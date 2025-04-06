import logger from '../utils/logger';
import { config } from '../utils/config';
import path from 'path';
import fs from 'fs';
// Import services
import { getM3u8ForSpacePage, postReplyToTweet, findTweetEmbeddingSpace, findSpaceTweetFromProfile } from '../services/twitterInteractionService';
import { downloadAndUploadAudio } from '../services/audioService';
import { createDubbingProject, generateSharingLink, waitForProjectCompletion } from '../services/speechlabApiService';
import { LeaderboardEntry } from '../services/scraperService'; // Import the interface

// Define a return type for the processing results
export interface ProcessingResult {
    processingAttempted: boolean; // Whether the entry had a valid play button and processing was attempted
    success: boolean;             // Whether processing completed successfully
    errorMessage?: string;        // Optional error message if processing failed
}

export class TwitterSpaceDubbingAgent {

    constructor() {
        logger.info('[🚀 Agent] TwitterSpaceDubbingAgent initialized.');
    }

    /**
     * Processes a single leaderboard entry: finds M3U8, downloads, dubs, posts.
     * @param entry The LeaderboardEntry object containing space details.
     * @returns ProcessingResult object indicating processing status
     */
    async processLeaderboardEntry(entry: LeaderboardEntry): Promise<ProcessingResult> {
        const processingId = entry.spaceTitle || entry.directSpaceUrl || entry.hostProfileUrl || 'Unknown Entry';
        logger.info(`[🚀 Agent] Starting processing for: ${processingId}`);

        // Validate required input from the entry
        if (!entry.directSpaceUrl) {
             logger.warn(`[🚀 Agent] Skipping entry - Missing directSpaceUrl: ${JSON.stringify(entry)}`);
             return { 
                 processingAttempted: false, 
                 success: false, 
                 errorMessage: 'Missing direct space URL'
             };
        }
        
        // Host profile URL is useful for context/logging but not strictly essential for M3U8 capture if direct link works
        // Space title is used for naming, provide a default if missing
        const spaceNameToUse = entry.spaceTitle || `Dubbed Space from ${entry.hostProfileUrl || 'Unknown Host'}`;
        const hostProfileForLog = entry.hostProfileUrl || 'N/A';
        
        // Extract the host username from host_handle in the entry for later use in finding tweets
        let hostUsername = 'unknown';
        if (entry.hostHandle) {
            // Remove @ if present and extract just the username
            hostUsername = entry.hostHandle.replace('@', '').trim();
            logger.info(`[🚀 Agent] Host username for Space: @${hostUsername}`);
        }

        try {
            // Phase 2: Find the M3U8 URL using the direct space link
            logger.info(`[🚀 Agent] ---> Phase 2: Finding M3U8 for Space URL ${entry.directSpaceUrl}...`);
            // Call the actual function from twitterInteractionService
            const interactionResult = await getM3u8ForSpacePage(entry.directSpaceUrl); 
            
            if (!interactionResult || !interactionResult.m3u8Url) {
                logger.warn(`[🚀 Agent] ---X Phase 2 Failed: Could not extract M3U8 URL for ${entry.directSpaceUrl}. Skipping entry.`);
                // Return early, indicating that no real processing was attempted (play button not found)
                return { 
                    processingAttempted: false, 
                    success: false, 
                    errorMessage: 'No play button found or M3U8 extraction failed' 
                };
            }
            
            // At this point, we've found a valid Play button and have attempted to process the space
            const { m3u8Url, originalTweetUrl } = interactionResult;
            logger.info(`[🚀 Agent] ---> Phase 2 Success: Found M3U8: ${m3u8Url}`);
            if (originalTweetUrl) logger.info(`                 Original Tweet URL (if found): ${originalTweetUrl}`);
            else logger.info(`                 Original Tweet URL not found on space page.`);

            // Phase 3: Download audio and upload to S3
            logger.info(`[🚀 Agent] ---> Phase 3: Downloading and uploading audio from ${m3u8Url}...`);
            logger.info(`[🚀 Agent] This process includes downloading audio stream and uploading to S3 (may take several minutes)`);
            logger.info(`[🚀 Agent] 🔊 Processing audio for "${spaceNameToUse}"`);

            const publicAudioUrl: string | null = await downloadAndUploadAudio(m3u8Url, spaceNameToUse);

            if (!publicAudioUrl) {
                logger.error(`[🚀 Agent] ---X Phase 3 Failed: Could not download/upload audio for ${m3u8Url}. Skipping entry.`);
                return { 
                    processingAttempted: true, 
                    success: false, 
                    errorMessage: 'Audio download/upload failed' 
                };
            }
            logger.info(`[🚀 Agent] ---> Phase 3 Success: Audio uploaded to ${publicAudioUrl}`);
            logger.info(`[🚀 Agent] Audio is now available for downloading/sharing at the URL above`);

            // Phase 4: Create dubbing project via SpeechLab API
            logger.info(`[🚀 Agent] ---> Phase 4: Creating SpeechLab dubbing project for "${spaceNameToUse}"...`);
            logger.info(`[🚀 Agent] 🎬 Sending request to SpeechLab API to create a new dubbing project`);
            
            // Sanitize spaceName for thirdPartyID creation (this should match the logic in createDubbingProject)
            const thirdPartyId = spaceNameToUse.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            logger.info(`[🚀 Agent] 🔑 Generated thirdPartyId: ${thirdPartyId}`);
            
            // Output thirdPartyId to a file for debugging
            try {
                const idFilePath = path.join(process.cwd(), 'third_party_id.txt');
                fs.writeFileSync(idFilePath, thirdPartyId);
                logger.info(`[🚀 Agent] 📝 Wrote thirdPartyId to ${idFilePath}`);
            } catch (err) {
                logger.error(`[🚀 Agent] ❌ Failed to write thirdPartyId to file:`, err);
            }
            
            const projectId: string | null = await createDubbingProject(publicAudioUrl, spaceNameToUse);

            if (!projectId) {
                logger.error(`[🚀 Agent] ---X Phase 4 Failed: Could not create SpeechLab project. Skipping entry.`);
                return { 
                    processingAttempted: true, 
                    success: false, 
                    errorMessage: 'SpeechLab project creation failed' 
                };
            }
            logger.info(`[🚀 Agent] ---> Phase 4 Success: SpeechLab project created with ID: ${projectId}`);
            
            // Phase 4b: Wait for project processing to complete before proceeding
            logger.info(`[🚀 Agent] ---> Phase 4b: Waiting for SpeechLab project to complete processing...`);
            logger.info(`[🚀 Agent] This could take several minutes to an hour depending on audio length.`);
            
            const projectCompleted = await waitForProjectCompletion(thirdPartyId);
            
            if (!projectCompleted) {
                logger.error(`[🚀 Agent] ---X Phase 4b Failed: Project did not reach COMPLETE status within allotted time.`);
                logger.info(`[🚀 Agent] Will continue with sharing link generation, but dubbing may not be ready yet.`);
                // We continue anyway, as the link will still be valid when the project eventually completes
            } else {
                logger.info(`[🚀 Agent] ---> Phase 4b Success: SpeechLab project processing completed successfully!`);
            }

            // Phase 5: Generate SpeechLab sharing link
            logger.info(`[🚀 Agent] ---> Phase 5: Generating sharing link for project ${projectId}...`);
            const sharingLink: string | null = await generateSharingLink(projectId);

            if (!sharingLink) {
                logger.error(`[🚀 Agent] ---X Phase 5 Failed: Could not generate sharing link. Skipping entry.`);
                return { 
                    processingAttempted: true, 
                    success: false, 
                    errorMessage: 'Sharing link generation failed' 
                };
            }
            logger.info(`[🚀 Agent] ---> Phase 5 Success: Sharing link generated: ${sharingLink}`);

            // Phase 6: Post link back to Twitter
            // First check if we already have an original tweet URL from the Space page
            let tweetUrl = null;
            if (originalTweetUrl) {
                if (originalTweetUrl.startsWith('/')) {
                    // Convert relative URL to absolute
                    tweetUrl = `https://twitter.com${originalTweetUrl}`;
                } else {
                    tweetUrl = originalTweetUrl;
                }
                logger.info(`[🚀 Agent] Found original tweet URL from Space page: ${tweetUrl}`);
            } else {
                // Multi-step approach to find a tweet to reply to
                logger.info(`[🚀 Agent] ---> Phase 6a: Finding tweet related to the Space...`);
                
                // Extract Space ID from the URL for tweet search
                const spaceIdMatch = entry.directSpaceUrl.match(/\/spaces\/([a-zA-Z0-9]+)/);
                let spaceId = null;
                if (spaceIdMatch && spaceIdMatch[1]) {
                    spaceId = spaceIdMatch[1];
                    logger.info(`[🚀 Agent] Extracted Space ID: ${spaceId} for tweet search`);
                }
                
                let tweetId = null;
                
                // Approach 1: Look for tweets on the host's profile that reference this Space
                if (hostUsername !== 'unknown' && spaceId) {
                    logger.info(`[🚀 Agent] Approach 1: Looking for tweets on @${hostUsername}'s profile related to this Space...`);
                    tweetId = await findSpaceTweetFromProfile(hostUsername, spaceId);
                    
                    if (tweetId) {
                        logger.info(`[🚀 Agent] ---> Phase 6a Success: Found tweet ${tweetId} on host's profile for this Space`);
                    } else {
                        logger.info(`[🚀 Agent] No tweet for this Space found on host's profile. Trying approach 2...`);
                    }
                }
                
                // Approach 2: If no exact match on profile, try to find any Space tweet from the host
                if (!tweetId && hostUsername !== 'unknown') {
                    logger.info(`[🚀 Agent] Approach 2: Looking for any Space-related tweet on @${hostUsername}'s profile...`);
                    tweetId = await findSpaceTweetFromProfile(hostUsername, "any");
                    
                    if (tweetId) {
                        logger.info(`[🚀 Agent] ---> Phase 6a Success: Found general Space tweet ${tweetId} on host's profile`);
                    } else {
                        logger.info(`[🚀 Agent] No Space tweets found on host's profile. Trying approach 3...`);
                    }
                }
                
                // Approach 3: If still no tweet found, try to find any tweet embedding the Space
                if (!tweetId) {
                    logger.info(`[🚀 Agent] Approach 3: Looking for any tweet embedding the Space...`);
                    tweetId = await findTweetEmbeddingSpace(entry.directSpaceUrl);
                    
                    if (tweetId) {
                        logger.info(`[🚀 Agent] ---> Phase 6a Success: Found embedding tweet: ${tweetId}`);
                    } else {
                        logger.warn(`[🚀 Agent] ---> Phase 6a Failed: Could not find any tweet related to the Space.`);
                    }
                }
                
                if (tweetId) {
                    tweetUrl = `https://twitter.com/i/status/${tweetId}`;
                }
            }

            // Now proceed with posting the reply if we have a tweet URL
            if (tweetUrl) {
                logger.info(`[🚀 Agent] ---> Phase 6b: Posting reply to tweet ${tweetUrl}...`);
                
                // Generate the comment text with a timestamp to make it unique
                const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
                const commentText = `Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this space in Latin Spanish! [${timestamp}] ${sharingLink}`;
                
                const postSuccess: boolean = await postReplyToTweet(tweetUrl, commentText);
                
                if (!postSuccess) {
                    logger.warn(`[🚀 Agent] ---> Phase 6b Failed: Could not post reply to ${tweetUrl}. (Check implementation/login)`);
                    // Not considered a full failure since we still have the sharing link
                    return { 
                        processingAttempted: true, 
                        success: true, 
                        errorMessage: 'Tweet reply posting failed, but dubbing was successful' 
                    };
                } else {
                    logger.info(`[🚀 Agent] ---> Phase 6b Success: Reply posted to ${tweetUrl}.`);
                }
            } else {
                logger.warn(`[🚀 Agent] ---> Phase 6 Skipped: No tweet URL found, cannot post reply automatically.`);
                // Optionally log the sharing link so it can be posted manually
                logger.info(`[ MANUAL POST ] Sharing link for space hosted by ${hostProfileForLog}: ${sharingLink}`);
            }

            logger.info(`[🚀 Agent] ✅ Successfully completed processing for: ${processingId}`);
            return { processingAttempted: true, success: true };

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`[🚀 Agent] ❌ Unhandled error during processing entry ${processingId}:`, error);
            return { 
                processingAttempted: true, 
                success: false, 
                errorMessage: `Unhandled error: ${errorMsg}` 
            };
        }
    }
} 