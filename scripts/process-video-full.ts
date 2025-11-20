#!/usr/bin/env tsx
/**
 * FULLY process a single VIDEO tweet using the exact daemon code
 * This will: detect video, extract m3u8, dub it, and post reply
 */

import { config } from '../src/utils/config.js';
import logger from '../src/utils/logger.js';
import { fetchVideoForMention, postReplyWithMedia } from '../src/services/twitterMentionService.js';
import { updateMentionStatus, getMention } from '../src/services/supabaseService.js';
import { detectLanguages } from '../src/utils/languageUtils.js';
import { downloadAndUploadVideo } from '../src/services/audioService.js';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink } from '../src/services/speechlabApiService.js';

async function processVideoFull(tweetId: string) {
    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[FULL PROCESS] Processing Video Tweet: ${tweetId}`);
    logger.info(`${'='.repeat(80)}\n`);

    // Step 1: Get mention
    const mention = await getMention(tweetId);
    if (!mention) {
        logger.error(`[FULL] Mention not found`);
        process.exit(1);
    }

    logger.info(`[FULL] Step 1: Found mention @${mention.username}`);

    // Step 2: Detect languages
    const { sourceLanguageCode, sourceLanguageName, targetLanguageCode, targetLanguageName } = detectLanguages(mention.tweet_text);
    logger.info(`[FULL] Step 2: Languages: ${sourceLanguageName} → ${targetLanguageName}`);

    await updateMentionStatus(tweetId, 'initiating', {
        source_language: sourceLanguageCode,
        target_language: targetLanguageCode
    });

    // Step 3: Fetch Video URL
    logger.info(`[FULL] Step 3: Fetching video URL...`);
    const { videoUrl, parentTweetId } = await fetchVideoForMention(tweetId);

    if (!videoUrl) {
        logger.error(`[FULL] No URL found`);
        process.exit(1);
    }

    const isSpaceUrl = videoUrl.match(/https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/);
    if (isSpaceUrl) {
        logger.error(`[FULL] This is a Space URL, not a video. Use process-space-full.ts instead.`);
        process.exit(1);
    }

    logger.info(`[FULL] ✅ Video URL: ${videoUrl}`);

    // Step 4: Update database with video info
    logger.info(`\n[FULL] Step 4: Updating database with m3u8 and content_type='video'...`);
    await updateMentionStatus(tweetId, 'processing', {
        m3u8_url: videoUrl,
        content_type: 'video'
    });
    logger.info(`[FULL] ✅ Database updated`);

    // Step 5: Download and upload video to S3
    logger.info(`\n[FULL] Step 5: Downloading video and uploading to S3...`);
    const videoId = `video_${tweetId}`;
    const videoS3Url = await downloadAndUploadVideo(videoUrl, videoId);
    logger.info(`[FULL] ✅ Video uploaded to S3: ${videoS3Url}`);

    // Step 6: Create SpeechLab dubbing project
    logger.info(`\n[FULL] Step 6: Creating SpeechLab dubbing project...`);
    const videoTitle = `Video from @${mention.username}`;
    const thirdPartyID = `${videoTitle.toLowerCase().replace(/\s+/g, '-')}-${sourceLanguageCode}-to-${targetLanguageCode}-${tweetId}`;

    const projectId = await createDubbingProject(
        videoS3Url,
        videoTitle,
        targetLanguageCode,
        thirdPartyID,
        sourceLanguageCode
    );

    if (!projectId) {
        throw new Error('Failed to create dubbing project');
    }

    logger.info(`[FULL] ✅ Project created: ${projectId}`);

    // Step 7: Wait for completion
    logger.info(`\n[FULL] Step 7: Waiting for dubbing to complete (this may take 10-15 minutes)...`);
    const maxWaitTimeMs = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
    const completedProject = await waitForProjectCompletion(thirdPartyID, maxWaitTimeMs);

    if (!completedProject || completedProject.job?.status !== 'COMPLETE') {
        throw new Error(`Project did not complete successfully`);
    }

    logger.info(`[FULL] ✅ Dubbing complete!`);

    // Step 8: Download and upload dubbed video (same as daemon)
    logger.info(`\n[FULL] Step 8: Downloading dubbed video and uploading to S3...`);
    const outputVideo = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
        d.category === 'video' && d.format === 'mp4' && d.operationType === 'OUTPUT'
    );

    if (!outputVideo?.presignedURL) {
        throw new Error('No dubbed video found in completed project medias');
    }

    logger.info(`[FULL] Found dubbed video with presigned URL`);

    // Download and upload to S3 (reusing existing services)
    const { downloadFile } = await import('../src/utils/fileUtils.js');
    const { uploadLocalFileToS3 } = await import('../src/services/audioService.js');
    const path = await import('path');
    const fs = await import('fs');
    const os = await import('os');

    const tempDir = path.join(os.tmpdir(), 'twitter-video');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const videoFilename = `${thirdPartyID}_dubbed.mp4`;
    const destinationVideoPath = path.join(tempDir, videoFilename);

    logger.info(`[FULL] Downloading dubbed video to ${destinationVideoPath}...`);
    const downloadSuccess = await downloadFile(outputVideo.presignedURL, destinationVideoPath);

    if (!downloadSuccess) {
        throw new Error('Failed to download dubbed video file');
    }

    logger.info(`[FULL] Successfully downloaded dubbed video`);

    // Upload to public S3
    const publicS3Key = `dubbed-videos/${videoFilename}`;
    logger.info(`[FULL] Uploading to S3 as ${publicS3Key}...`);
    const dubbedVideoUrl = await uploadLocalFileToS3(destinationVideoPath, publicS3Key);

    if (!dubbedVideoUrl) {
        throw new Error('Failed to upload dubbed video to S3');
    }

    logger.info(`[FULL] ✅ Dubbed video uploaded to S3: ${dubbedVideoUrl}`);

    // Clean up temp file
    try {
        fs.unlinkSync(destinationVideoPath);
        logger.info(`[FULL] Cleaned up temp file: ${destinationVideoPath}`);
    } catch (e) {
        logger.warn(`[FULL] Failed to clean up temp file: ${e}`);
    }

    // Step 9: Generate sharing link
    logger.info(`\n[FULL] Step 9: Generating sharing link...`);
    const sharingLink = await generateSharingLink(projectId);
    logger.info(`[FULL] ✅ Sharing link: ${sharingLink}`);

    await updateMentionStatus(tweetId, 'complete', {
        public_video_url: dubbedVideoUrl,
        sharing_link: sharingLink
    });

    // Step 10: Post reply to Twitter WITH VIDEO ATTACHMENT
    logger.info(`\n[FULL] Step 10: Posting reply to Twitter with video attachment...`);

    // Download video again for Twitter attachment (daemon does this at line 1730)
    const replyVideoPath = path.join(tempDir, `reply_video_${tweetId}.mp4`);
    logger.info(`[FULL] Downloading video for Twitter attachment: ${replyVideoPath}`);
    const replyDownloadSuccess = await downloadFile(dubbedVideoUrl, replyVideoPath);

    let replyText = `@${mention.username} Your video dubbed to ${targetLanguageName}!\n\nDisclaimer: this content is not certified for accuracy`;
    let mediaPath: string | undefined = undefined;

    if (replyDownloadSuccess) {
        logger.info(`[FULL] ✅ Video downloaded for attachment`);
        mediaPath = replyVideoPath;
    } else {
        logger.warn(`[FULL] Failed to download video for attachment. Will include URL in text.`);
        replyText += `\n\nWatch here: ${dubbedVideoUrl}`;
    }

    logger.info(`[FULL] Reply text: ${replyText}`);
    logger.info(`[FULL] Media path: ${mediaPath || 'none'}`);
    const replyResult = await postReplyWithMedia(replyText, tweetId, mediaPath);

    if (replyResult.success) {
        logger.info(`[FULL] ✅ Reply posted successfully!`);
    } else {
        logger.error(`[FULL] ❌ Failed to post reply`);
    }

    // Clean up reply video file
    if (mediaPath) {
        try {
            fs.unlinkSync(replyVideoPath);
            logger.info(`[FULL] Cleaned up reply video file: ${replyVideoPath}`);
        } catch (e) {
            logger.warn(`[FULL] Failed to clean up reply video file: ${e}`);
        }
    }

    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[FULL] ✅✅✅ VIDEO PROCESSING COMPLETE! ✅✅✅`);
    logger.info(`${'='.repeat(80)}`);
    logger.info(`Tweet: ${mention.tweet_url}`);
    logger.info(`Video: ${videoUrl}`);
    logger.info(`Dubbed Video: ${dubbedVideoUrl}`);
    logger.info(`Sharing Link: ${sharingLink}`);
    logger.info(`Reply Posted: ${replyResult.success ? 'YES' : 'NO'}`);
    logger.info(`Video Attached: ${mediaPath ? 'YES' : 'NO (URL only)'}`);
    logger.info(`${'='.repeat(80)}`);
}

const tweetId = process.argv[2];
if (!tweetId) {
    console.error('Usage: npx tsx scripts/process-video-full.ts <tweet_id>');
    process.exit(1);
}

processVideoFull(tweetId).catch(async (error) => {
    console.error('Failed:', error);

    // Mark as failed in database
    const { updateMentionStatus } = await import('../src/services/supabaseService.js');
    await updateMentionStatus(tweetId, 'failed', {
        error_message: error instanceof Error ? error.message : String(error)
    });

    process.exit(1);
});
