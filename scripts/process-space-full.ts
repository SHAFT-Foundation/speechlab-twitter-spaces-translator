#!/usr/bin/env tsx
/**
 * FULLY process a single Space tweet using the exact daemon code
 * This will: detect Space, launch browser, extract m3u8, dub it
 */

import { config } from '../src/utils/config.js';
import logger from '../src/utils/logger.js';
import { fetchVideoForMention, postReplyWithMedia } from '../src/services/twitterMentionService.js';
import { updateMentionStatus, getMention } from '../src/services/supabaseService.js';
import { initializeDaemonBrowser, extractSpaceUrl, clickPlayButtonAndCaptureM3u8, extractSpaceTitleFromModal } from '../src/services/twitterInteractionService.js';
import { detectLanguages } from '../src/utils/languageUtils.js';
import { downloadAndUploadAudio } from '../src/services/audioService.js';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink } from '../src/services/speechlabApiService.js';

// Helper function from daemon (not exported)
async function findArticleWithPlayButton(page: any): Promise<any | null> {
    logger.debug('[🐦 Helper] Searching for playable Space element...');

    const playButtonPatterns = [
        /Play recording/i,
        /^Play$/i,
        /Play Space/i,
        /Listen/i,
        /Playback/i
    ];

    const articleSelector = 'article[data-testid="tweet"]';

    // Find button within articles
    const articles = await page.locator(articleSelector).all();
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!await article.isVisible().catch(() => false)) {
            continue;
        }

        for (const pattern of playButtonPatterns) {
            const buttonInArticle = article.getByRole('button', { name: pattern }).first();
            if (await buttonInArticle.isVisible({ timeout: 500 }).catch(() => false)) {
                logger.info(`[🐦 Helper] Found Play button in article ${i + 1}`);
                return article;
            }
        }
    }

    logger.warn('[🐦 Helper] No article with Play button found');
    return null;
}

async function processSpaceFull(tweetId: string) {
    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[FULL PROCESS] Processing Space Tweet: ${tweetId}`);
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

    // Step 3: Fetch Space URL
    logger.info(`[FULL] Step 3: Fetching Space URL...`);
    const { videoUrl, parentTweetId } = await fetchVideoForMention(tweetId);

    if (!videoUrl) {
        logger.error(`[FULL] No URL found`);
        process.exit(1);
    }

    const isSpaceUrl = videoUrl.match(/https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/);
    if (!isSpaceUrl) {
        logger.error(`[FULL] Not a Space URL: ${videoUrl}`);
        process.exit(1);
    }

    const spaceId = isSpaceUrl[1];
    logger.info(`[FULL] ✅ Space URL: ${videoUrl}`);
    logger.info(`[FULL] Space ID: ${spaceId}`);

    // Step 4: Initialize browser
    logger.info(`\n[FULL] Step 4: Launching Playwright browser...`);
    const { browser, context } = await initializeDaemonBrowser();
    const page = await context.newPage();

    try {
        // Step 5: Navigate and extract m3u8 (SAME AS DAEMON initiateProcessing)
        // Navigate to PARENT tweet where the Space is, not the mention
        const parentTweetUrl = `https://twitter.com/i/status/${parentTweetId}`;
        logger.info(`[FULL] Step 5: Navigating to PARENT tweet (where Space is): ${parentTweetUrl}`);
        await page.goto(parentTweetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

        logger.info(`[FULL] Waiting 60 seconds for Space to load...`);
        await page.waitForTimeout(60000);

        // Extract Space title
        logger.info(`[FULL] Extracting Space title...`);
        const spaceTitle = await extractSpaceTitleFromModal(page) || `Space ${spaceId}`;
        logger.info(`[FULL] Space title: ${spaceTitle}`);

        // Find the article containing the Play button (same as daemon)
        logger.info(`[FULL] Finding article with Play button...`);
        let articleLocator = await findArticleWithPlayButton(page);

        if (!articleLocator) {
            // Try scrolling up like daemon does
            logger.info(`[FULL] Play button not found, scrolling up...`);
            const MAX_SCROLL_UP = 5;
            for (let i = 0; i < MAX_SCROLL_UP && !articleLocator; i++) {
                await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
                logger.info(`[FULL] Waiting 60 seconds after scroll ${i+1}...`);
                await page.waitForTimeout(60000);
                articleLocator = await findArticleWithPlayButton(page);
            }

            if (!articleLocator) {
                throw new Error('Could not find Play button for Space after scrolling');
            }
        }

        logger.info(`[FULL] ✅ Found article with Play button`);

        // Click Play and capture m3u8
        logger.info(`[FULL] Clicking Play button to capture m3u8 URL...`);
        const m3u8Url = await clickPlayButtonAndCaptureM3u8(page, articleLocator);

        if (!m3u8Url) {
            throw new Error('Failed to capture m3u8 URL');
        }

        logger.info(`[FULL] ✅ M3U8 URL captured: ${m3u8Url}`);

        // Step 6: Update database
        logger.info(`\n[FULL] Step 6: Updating database with m3u8 and content_type='space'...`);
        await updateMentionStatus(tweetId, 'processing', {
            m3u8_url: m3u8Url,
            content_type: 'space'
        });
        logger.info(`[FULL] ✅ Database updated`);

        // Step 7: Download and upload to S3
        logger.info(`\n[FULL] Step 7: Downloading Space audio and uploading to S3...`);
        const audioS3Url = await downloadAndUploadAudio(m3u8Url, spaceId);
        logger.info(`[FULL] ✅ Audio uploaded to S3: ${audioS3Url}`);

        // Step 8: Create SpeechLab dubbing project
        logger.info(`\n[FULL] Step 8: Creating SpeechLab dubbing project...`);
        const thirdPartyID = `${spaceTitle.toLowerCase().replace(/\s+/g, '-')}-${sourceLanguageCode}-to-${targetLanguageCode}-${tweetId}`;

        const projectId = await createDubbingProject(
            audioS3Url,
            spaceTitle,
            targetLanguageCode,
            thirdPartyID,
            sourceLanguageCode
        );

        if (!projectId) {
            throw new Error('Failed to create dubbing project');
        }

        logger.info(`[FULL] ✅ Project created: ${projectId}`);

        // Step 9: Wait for completion
        logger.info(`\n[FULL] Step 9: Waiting for dubbing to complete (this may take 10-15 minutes)...`);
        const maxWaitTimeMs = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
        const completedProject = await waitForProjectCompletion(thirdPartyID, maxWaitTimeMs);

        if (!completedProject || completedProject.job?.status !== 'COMPLETE') {
            throw new Error(`Project did not complete successfully`);
        }

        logger.info(`[FULL] ✅ Dubbing complete!`);

        // Step 10: Download and upload dubbed audio (same as daemon)
        logger.info(`\n[FULL] Step 10: Downloading dubbed audio and uploading to S3...`);
        const outputAudio = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
            d.category === 'audio' && d.format === 'mp3' && d.operationType === 'OUTPUT'
        );

        if (!outputAudio?.presignedURL) {
            throw new Error('No dubbed audio found in completed project medias');
        }

        logger.info(`[FULL] Found dubbed audio with presigned URL`);

        // Download and upload to S3 (reusing existing audioService)
        const { downloadFile } = await import('../src/utils/fileUtils.js');
        const { uploadLocalFileToS3 } = await import('../src/services/audioService.js');
        const path = await import('path');
        const fs = await import('fs');
        const os = await import('os');

        const tempDir = path.join(os.tmpdir(), 'twitter-spaces-audio');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const audioFilename = `${thirdPartyID}_dubbed.mp3`;
        const destinationAudioPath = path.join(tempDir, audioFilename);

        logger.info(`[FULL] Downloading dubbed audio to ${destinationAudioPath}...`);
        const downloadSuccess = await downloadFile(outputAudio.presignedURL, destinationAudioPath);

        if (!downloadSuccess) {
            throw new Error('Failed to download dubbed audio file');
        }

        logger.info(`[FULL] Successfully downloaded dubbed audio`);

        // Upload to public S3
        const publicS3Key = `dubbed-spaces/${audioFilename}`;
        logger.info(`[FULL] Uploading to S3 as ${publicS3Key}...`);
        const dubbedAudioUrl = await uploadLocalFileToS3(destinationAudioPath, publicS3Key);

        if (!dubbedAudioUrl) {
            throw new Error('Failed to upload dubbed audio to S3');
        }

        logger.info(`[FULL] ✅ Dubbed audio uploaded to S3: ${dubbedAudioUrl}`);

        // Clean up temp file
        try {
            fs.unlinkSync(destinationAudioPath);
            logger.info(`[FULL] Cleaned up temp file: ${destinationAudioPath}`);
        } catch (e) {
            logger.warn(`[FULL] Failed to clean up temp file: ${e}`);
        }

        // Step 11: Generate sharing link
        logger.info(`\n[FULL] Step 11: Generating sharing link...`);
        const sharingLink = await generateSharingLink(projectId);
        logger.info(`[FULL] ✅ Sharing link: ${sharingLink}`);

        await updateMentionStatus(tweetId, 'complete', {
            public_mp3_url: dubbedAudioUrl,
            sharing_link: sharingLink
        });

        // Step 12: Post reply to Twitter
        logger.info(`\n[FULL] Step 12: Posting reply to Twitter...`);
        const replyText = `@${mention.username} Your ${sourceLanguageName} to ${targetLanguageName} dub is ready! 🎉\n\nWatch here: ${dubbedAudioUrl}\n\nDisclaimer: this content is not certified for accuracy`;

        logger.info(`[FULL] Reply text: ${replyText}`);
        const replyResult = await postReplyWithMedia(replyText, tweetId, undefined);

        if (replyResult.success) {
            logger.info(`[FULL] ✅ Reply posted successfully!`);
        } else {
            logger.error(`[FULL] ❌ Failed to post reply`);
        }

        logger.info(`\n${'='.repeat(80)}`);
        logger.info(`[FULL] ✅✅✅ SPACE PROCESSING COMPLETE! ✅✅✅`);
        logger.info(`${'='.repeat(80)}`);
        logger.info(`Tweet: ${mention.tweet_url}`);
        logger.info(`Space: ${videoUrl}`);
        logger.info(`Dubbed Audio: ${dubbedAudioUrl}`);
        logger.info(`Sharing Link: ${sharingLink}`);
        logger.info(`Reply Posted: ${replyResult.success ? 'YES' : 'NO'}`);
        logger.info(`${'='.repeat(80)}`);

    } catch (error) {
        logger.error(`[FULL] ❌ Error:`, error);
        await updateMentionStatus(tweetId, 'failed', {
            error_message: error instanceof Error ? error.message : String(error)
        });
        throw error;
    } finally {
        logger.info(`[FULL] Closing browser...`);
        await page.close();
        await context.close();
        await browser.close();
    }
}

const tweetId = process.argv[2];
if (!tweetId) {
    console.error('Usage: npx tsx scripts/process-space-full.ts <tweet_id>');
    process.exit(1);
}

processSpaceFull(tweetId).catch((error) => {
    console.error('Failed:', error);
    process.exit(1);
});
