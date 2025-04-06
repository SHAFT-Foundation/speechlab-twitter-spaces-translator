import logger from '../utils/logger';
import { config } from '../utils/config';
// Import services
import { getM3u8ForSpacePage, postReplyToTweet } from '../services/twitterInteractionService';
import { downloadAndUploadAudio } from '../services/audioService';
import { createDubbingProject, generateSharingLink } from '../services/speechlabApiService';
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
            if (originalTweetUrl) {
                logger.info(`[🚀 Agent] ---> Phase 6: Posting reply to tweet ${originalTweetUrl}...`);
                const commentText = `Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this space in Latin Spanish!! ${sharingLink}?`;
                const postSuccess: boolean = await postReplyToTweet(originalTweetUrl, commentText);
                 if (!postSuccess) {
                     logger.warn(`[🚀 Agent] ---> Phase 6 Failed: Could not post reply to ${originalTweetUrl}. (Check implementation/login)`);
                     // Not considered a full failure since we still have the sharing link
                     return { 
                         processingAttempted: true, 
                         success: true, 
                         errorMessage: 'Tweet reply posting failed, but dubbing was successful' 
                     };
                 } else {
                     logger.info(`[🚀 Agent] ---> Phase 6 Success: Reply posted to ${originalTweetUrl}.`);
                 }
            } else {
                 logger.warn(`[🚀 Agent] ---> Phase 6 Skipped: Original tweet URL was not found/captured, cannot post reply automatically.`);
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