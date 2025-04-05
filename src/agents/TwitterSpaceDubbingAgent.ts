import logger from '../utils/logger';
import { config } from '../utils/config';
// Import services
import { getM3u8ForSpacePage, postReplyToTweet } from '../services/twitterInteractionService';
import { downloadAndUploadAudio } from '../services/audioService';
import { createDubbingProject, generateSharingLink } from '../services/speechlabApiService';
import { LeaderboardEntry } from '../services/scraperService'; // Import the interface

export class TwitterSpaceDubbingAgent {

    constructor() {
        logger.info('[🚀 Agent] TwitterSpaceDubbingAgent initialized.');
    }

    /**
     * Processes a single leaderboard entry: finds M3U8, downloads, dubs, posts.
     * @param entry The LeaderboardEntry object containing space details.
     */
    async processLeaderboardEntry(entry: LeaderboardEntry): Promise<void> {
        const processingId = entry.spaceTitle || entry.directSpaceUrl || entry.hostProfileUrl || 'Unknown Entry';
        logger.info(`[🚀 Agent] Starting processing for: ${processingId}`);

        // Validate required input from the entry
        if (!entry.directSpaceUrl) {
             logger.warn(`[🚀 Agent] Skipping entry - Missing directSpaceUrl: ${JSON.stringify(entry)}`);
             return;
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
                return;
            }
            const { m3u8Url, originalTweetUrl } = interactionResult;
            logger.info(`[🚀 Agent] ---> Phase 2 Success: Found M3U8: ${m3u8Url}`);
            if (originalTweetUrl) logger.info(`                 Original Tweet URL (if found): ${originalTweetUrl}`);
            else logger.info(`                 Original Tweet URL not found on space page.`);

            // Phase 3: Download audio and upload to S3
            logger.info(`[🚀 Agent] ---> Phase 3: Downloading and uploading audio from ${m3u8Url}...`);
            const publicAudioUrl: string | null = await downloadAndUploadAudio(m3u8Url, spaceNameToUse);

            if (!publicAudioUrl) {
                logger.error(`[🚀 Agent] ---X Phase 3 Failed: Could not download/upload audio for ${m3u8Url}. Skipping entry.`);
                return;
            }
            logger.info(`[🚀 Agent] ---> Phase 3 Success: Audio uploaded to ${publicAudioUrl}`);

            // Phase 4: Create dubbing project via SpeechLab API
            logger.info(`[🚀 Agent] ---> Phase 4: Creating SpeechLab dubbing project for "${spaceNameToUse}"...`);
            const projectId: string | null = await createDubbingProject(publicAudioUrl, spaceNameToUse);

            if (!projectId) {
                logger.error(`[🚀 Agent] ---X Phase 4 Failed: Could not create SpeechLab project. Skipping entry.`);
                return;
            }
            logger.info(`[🚀 Agent] ---> Phase 4 Success: SpeechLab project created with ID: ${projectId}`);

            // Phase 5: Generate SpeechLab sharing link
            logger.info(`[🚀 Agent] ---> Phase 5: Generating sharing link for project ${projectId}...`);
            const sharingLink: string | null = await generateSharingLink(projectId);

            if (!sharingLink) {
                logger.error(`[🚀 Agent] ---X Phase 5 Failed: Could not generate sharing link. Skipping entry.`);
                return;
            }
            logger.info(`[🚀 Agent] ---> Phase 5 Success: Sharing link generated: ${sharingLink}`);

            // Phase 6: Post link back to Twitter
            if (originalTweetUrl) {
                logger.info(`[🚀 Agent] ---> Phase 6: Posting reply to tweet ${originalTweetUrl}...`);
                const commentText = `Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this space in Latin Spanish!! ${sharingLink}?`;
                const postSuccess: boolean = await postReplyToTweet(originalTweetUrl, commentText);
                 if (!postSuccess) {
                     logger.warn(`[🚀 Agent] ---> Phase 6 Failed: Could not post reply to ${originalTweetUrl}. (Check implementation/login)`);
                 } else {
                     logger.info(`[🚀 Agent] ---> Phase 6 Success: Reply posted to ${originalTweetUrl}.`);
                 }
            } else {
                 logger.warn(`[🚀 Agent] ---> Phase 6 Skipped: Original tweet URL was not found/captured, cannot post reply automatically.`);
                 // Optionally log the sharing link so it can be posted manually
                 logger.info(`[ MANUAL POST ] Sharing link for space hosted by ${hostProfileForLog}: ${sharingLink}`);
            }

            logger.info(`[🚀 Agent] ✅ Successfully completed processing for: ${processingId}`);

        } catch (error) {
            logger.error(`[🚀 Agent] ❌ Unhandled error during processing entry ${processingId}:`, error);
        }
    }

} 