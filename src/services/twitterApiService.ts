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

// Rate limiting state
let lastTweetTime = 0;
const MIN_TWEET_INTERVAL_MS = 300000; // 5 minutes (300 seconds) between tweets to avoid rate limits

// Exponential backoff configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 60000; // Start with 1 minute for 429 errors
const MAX_DELAY_MS = 900000; // Max 15 minutes

logger.info('[🐦 API] Twitter API v2 client initialized (read-write).');

/**
 * Sleep helper for exponential backoff
 */
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 * @param attempt Current attempt number (0-indexed)
 * @returns Delay in milliseconds
 */
function getExponentialBackoffDelay(attempt: number): number {
    // Exponential backoff progression:
    // Attempt 0: 1 minute (60s)
    // Attempt 1: 2 minutes (120s)
    // Attempt 2: 4 minutes (240s)
    // Attempt 3+: 15 minutes (900s) - capped
    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);

    // Add jitter (±20%) to avoid thundering herd problem
    const jitter = delay * 0.2 * (Math.random() - 0.5);

    return Math.floor(delay + jitter);
}

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

    // Step 1: Upload media if path is provided (no retry for media upload)
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

    // Step 3: Post with exponential backoff retry logic
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Rate limit protection - wait if needed
            const now = Date.now();
            const timeSinceLastTweet = now - lastTweetTime;
            if (timeSinceLastTweet < MIN_TWEET_INTERVAL_MS) {
                const waitTime = MIN_TWEET_INTERVAL_MS - timeSinceLastTweet;
                const waitMinutes = Math.ceil(waitTime / 60000);
                const waitSeconds = Math.ceil(waitTime / 1000);
                logger.info(`[🐦 API Post] ⏱️ Rate limit protection: waiting ${waitMinutes}m ${waitSeconds % 60}s (${waitTime}ms) before posting...`);
                await sleep(waitTime);
            }

            // Post the tweet
            logger.info(`[🐦 API Post] Posting tweet reply (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
            const result = await rwClient.v2.tweet(tweetPayload);
            lastTweetTime = Date.now();

            logger.debug(`[🐦 API Post] Tweet post result: ${JSON.stringify(result)}`);

            if (result.data?.id) {
                logger.info(`[🐦 API Post] ✅ Tweet reply posted successfully! Tweet ID: ${result.data.id}`);
                return true;
            } else {
                logger.error('[🐦 API Post] ❌ Tweet post API call seemed successful, but no ID found in response data.', result.errors);
                return false;
            }

        } catch (error: any) {
            const isLastAttempt = attempt === MAX_RETRIES;

            // Handle rate limiting (429) with exponential backoff
            if (error.code === 429) {
                logger.error(`[🐦 API Post] 🚨 RATE LIMIT EXCEEDED (429) - Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

                // Try to extract rate limit reset time from headers
                let resetWaitTime: number | null = null;
                if (error.rateLimit && error.rateLimit.reset) {
                    const resetTime = new Date(error.rateLimit.reset * 1000);
                    resetWaitTime = resetTime.getTime() - Date.now();
                    const waitMinutes = Math.ceil(resetWaitTime / 60000);
                    logger.error(`[🐦 API Post] Rate limit resets at: ${resetTime.toISOString()} (in ~${waitMinutes} minutes)`);
                }

                if (isLastAttempt) {
                    logger.error(`[🐦 API Post] ❌ Max retries reached. Giving up.`);
                    logger.error(`[🐦 API Post] Failed Reply Text: ${tweetText}`);
                    return false;
                }

                // Use reset time if available, otherwise use exponential backoff
                const backoffDelay = resetWaitTime && resetWaitTime > 0 && resetWaitTime < MAX_DELAY_MS
                    ? resetWaitTime
                    : getExponentialBackoffDelay(attempt);

                const backoffMinutes = Math.floor(backoffDelay / 60000);
                const backoffSeconds = Math.round((backoffDelay % 60000) / 1000);
                logger.info(`[🐦 API Post] ⏳ Retrying in ${backoffMinutes}m ${backoffSeconds}s with exponential backoff...`);
                await sleep(backoffDelay);
                continue; // Retry

            } else if (error.code === 403) {
                // 403 errors are usually not retryable (permissions, duplicate content, etc.)
                logger.error(`[🐦 API Post] ❌ Forbidden (403) - Not retrying. Error: ${error.message}`);
                logger.error(`[🐦 API Post] Failed Reply Text: ${tweetText}`);
                if (error.data?.errors) {
                    logger.error(`[🐦 API Post] Twitter API Errors: ${JSON.stringify(error.data.errors)}`);
                }
                return false;

            } else if (error.code && [500, 502, 503, 504].includes(error.code)) {
                // Server errors - retry with backoff
                logger.error(`[🐦 API Post] ⚠️ Server error (${error.code}) - Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

                if (isLastAttempt) {
                    logger.error(`[🐦 API Post] ❌ Max retries reached after server errors. Giving up.`);
                    logger.error(`[🐦 API Post] Failed Reply Text: ${tweetText}`);
                    return false;
                }

                const backoffDelay = getExponentialBackoffDelay(attempt);
                const backoffMinutes = Math.floor(backoffDelay / 60000);
                const backoffSeconds = Math.round((backoffDelay % 60000) / 1000);
                logger.info(`[🐦 API Post] ⏳ Retrying in ${backoffMinutes}m ${backoffSeconds}s...`);
                await sleep(backoffDelay);
                continue; // Retry

            } else {
                // Other errors - log and fail immediately
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
    }

    // Should never reach here, but just in case
    logger.error('[🐦 API Post] ❌ Unexpected: Exhausted all retries without returning.');
    return false;
} 