import { TwitterApi, EUploadMimeType } from 'twitter-api-v2';
import logger from '../utils/logger';
import { config } from '../utils/config';
import * as fs from 'fs'; // Needed for checking media file existence

// Initialize the Twitter API Client (OAuth 1.0a for user context actions like tweeting)
// Ensure your .env file has: TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});

// Read-Write client instance
const rwClient = twitterClient.readWrite;

logger.info('[🐦 API] Twitter API v2 client initialized (read-write).');

/**
 * Uploads media (video) to Twitter using the v1.1 chunked upload API.
 * Necessary for attaching media to tweets via API v2.
 * @param mediaPath Path to the local media file.
 * @returns {Promise<string | null>} The media_id_string if upload is successful, otherwise null.
 */
async function uploadMedia(mediaPath: string): Promise<string | null> {
    logger.info(`[🐦 API Upload] Starting media upload for: ${mediaPath}`);
    try {
        if (!fs.existsSync(mediaPath)) {
            logger.error(`[🐦 API Upload] File not found: ${mediaPath}`);
            return null;
        }

        // Determine MIME type (adjust if supporting images later)
        const mimeType = EUploadMimeType.Mp4;

        logger.debug(`[🐦 API Upload] Uploading with mime type: ${mimeType}`);
        // Use the v1.1 client for media uploads as v2 doesn't fully support chunked video yet
        const mediaId = await twitterClient.v1.uploadMedia(mediaPath, { mimeType });
        
        logger.info(`[🐦 API Upload] ✅ Media uploaded successfully. Media ID: ${mediaId}`);
        return mediaId;

    } catch (error: any) {
        logger.error('[🐦 API Upload] ❌ Media upload failed:', error);
        // Log specific Twitter API errors if available
        if (error.code) {
             logger.error(`[🐦 API Upload] Twitter Error Code: ${error.code}, Message: ${error.message}`);
        }
        return null;
    }
}

/**
 * Posts a reply tweet with optional attached media using the Twitter API v2.
 * @param tweetText The text content of the reply.
 * @param tweetIdToReplyTo The ID of the tweet being replied to.
 * @param mediaPath Optional path to a local media file (already uploaded).
 * @returns {Promise<boolean>} True if the tweet was posted successfully, false otherwise.
 */
export async function postTweetReplyWithMediaApi(
    tweetText: string,
    tweetIdToReplyTo: string,
    mediaPath?: string
): Promise<boolean> {
    logger.info(`[🐦 API Post] Attempting to post API reply to tweet ID: ${tweetIdToReplyTo}${mediaPath ? ' with media' : ''}`);
    logger.info(`[🐦 API Post] Full Reply Text: ${tweetText}`);
    
    let mediaId: string | null = null;

    try {
        // Step 1: Upload media if path is provided
        if (mediaPath) {
            mediaId = await uploadMedia(mediaPath);
            if (!mediaId) {
                logger.error('[🐦 API Post] ❌ Failed to upload media, cannot post tweet with attachment.');
                return false;
            }
        }

        // Step 2: Construct tweet payload
        const tweetPayload: any = {
            text: tweetText,
            reply: {
                in_reply_to_tweet_id: tweetIdToReplyTo
            }
        };

        if (mediaId) {
            tweetPayload.media = { media_ids: [mediaId] };
        }
        
        logger.debug(`[🐦 API Post] Tweet payload: ${JSON.stringify(tweetPayload)}`);

        // Step 3: Post the tweet
        logger.info(`[🐦 API Post] Posting tweet reply...`);
        const result = await rwClient.v2.tweet(tweetPayload);
        
        logger.debug(`[🐦 API Post] Tweet post result: ${JSON.stringify(result)}`);

        if (result.data?.id) {
            logger.info(`[🐦 API Post] ✅ Tweet reply posted successfully! Tweet ID: ${result.data.id}`);
            return true;
        } else {
            logger.error('[🐦 API Post] ❌ Tweet post API call seemed successful, but no ID found in response data.', result.errors);
            return false;
        }

    } catch (error: any) {
        logger.error('[🐦 API Post] ❌ Error posting tweet reply via API:', error);
        logger.error(`[🐦 API Post] Failed Reply Text: ${tweetText}`);
        if (error.code) {
             logger.error(`[🐦 API Post] Twitter Error Code: ${error.code}, Message: ${error.message}`);
        } else if (error.data?.errors) {
             logger.error(`[🐦 API Post] Twitter API Errors: ${JSON.stringify(error.data.errors)}`);
        }
        return false;
    }
} 