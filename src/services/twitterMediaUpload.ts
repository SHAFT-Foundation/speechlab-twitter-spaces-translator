/**
 * Twitter v2 Media Upload Service
 * Implements chunked upload for videos using twitter-api-v2 library
 */

import * as fs from 'fs';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { TwitterApi, EUploadMimeType } from 'twitter-api-v2';

const MAX_RETRIES = 1; // Retry uploads once (2 total attempts to limit API calls)

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize Twitter client for uploads
const userContextClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});

/**
 * Upload video to Twitter using twitter-api-v2 library (handles chunking automatically)
 *
 * @param filePath Path to the video file
 * @returns Media ID string if successful, null if failed
 */
export async function uploadVideoChunked(filePath: string): Promise<string | null> {
    logger.info(`[🐦 Chunked Upload] ========================================`);
    logger.info(`[🐦 Chunked Upload] 🚀 Starting video upload via twitter-api-v2`);
    logger.info(`[🐦 Chunked Upload] File: ${filePath}`);
    logger.info(`[🐦 Chunked Upload] ========================================`);

    // Verify file exists
    if (!fs.existsSync(filePath)) {
        logger.error(`[🐦 Chunked Upload] ❌ File not found: ${filePath}`);
        return null;
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const totalMB = (stats.size / (1024 * 1024)).toFixed(2);

    logger.info(`[🐦 Chunked Upload] 📊 File size: ${totalMB} MB (${stats.size} bytes)`);

    if (stats.size === 0) {
        logger.error(`[🐦 Chunked Upload] ❌ File is empty`);
        return null;
    }

    // Check size limit (512 MB)
    if (stats.size > 512 * 1024 * 1024) {
        logger.error(`[🐦 Chunked Upload] ❌ File exceeds 512 MB limit`);
        return null;
    }

    // Retry loop
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            logger.info(`[🐦 Chunked Upload] Upload attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

            const startTime = Date.now();

            // twitter-api-v2 handles chunking automatically for large files
            const mediaId = await userContextClient.v1.uploadMedia(filePath, {
                mimeType: EUploadMimeType.Mp4,
                target: 'tweet' // Important: 'tweet' target for video uploads
            });

            const duration = Date.now() - startTime;
            const uploadSpeed = (stats.size / 1024 / 1024 / (duration / 1000)).toFixed(2);

            logger.info(`[🐦 Chunked Upload] ========================================`);
            logger.info(`[🐦 Chunked Upload] ✅ Upload successful!`);
            logger.info(`[🐦 Chunked Upload] Media ID: ${mediaId}`);
            logger.info(`[🐦 Chunked Upload] Duration: ${(duration / 1000).toFixed(2)}s`);
            logger.info(`[🐦 Chunked Upload] Speed: ${uploadSpeed} MB/s`);
            logger.info(`[🐦 Chunked Upload] ========================================`);

            return mediaId;

        } catch (error: any) {
            logger.error(`[🐦 Chunked Upload] ❌ Attempt ${attempt + 1} failed`);
            logger.error(`[🐦 Chunked Upload] Error: ${error.message || 'Unknown error'}`);

            if (error.code) {
                logger.error(`[🐦 Chunked Upload] Error code: ${error.code}`);
            }

            if (error.data) {
                logger.error(`[🐦 Chunked Upload] Error data:`, JSON.stringify(error.data, null, 2));
            }

            // If not last attempt, wait before retry
            if (attempt < MAX_RETRIES) {
                const waitTime = Math.pow(2, attempt) * 5000; // 5s, 10s
                logger.info(`[🐦 Chunked Upload] Retrying in ${waitTime / 1000}s...`);
                await sleep(waitTime);
            }
        }
    }

    logger.error(`[🐦 Chunked Upload] ❌ All upload attempts failed`);
    return null;
}
