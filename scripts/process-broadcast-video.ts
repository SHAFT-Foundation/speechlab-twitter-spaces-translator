#!/usr/bin/env tsx
/**
 * Process a broadcast VIDEO tweet (not Space/audio only)
 * This handles Twitter broadcast URLs that contain video content
 * Extracts m3u8, dubs the video, and posts VIDEO reply (not link)
 */

import { config } from '../src/utils/config.js';
import logger from '../src/utils/logger.js';
import { fetchVideoForMention, postReplyWithMedia } from '../src/services/twitterMentionService.js';
import { updateMentionStatus, getMention } from '../src/services/supabaseService.js';
import { initializeDaemonBrowser, clickPlayButtonAndCaptureM3u8 } from '../src/services/twitterInteractionService.js';
import { detectLanguages } from '../src/utils/languageUtils.js';
import { downloadAndUploadVideo } from '../src/services/audioService.js';
import { createDubbingProject, waitForProjectCompletion } from '../src/services/speechlabApiService.js';
import { mergeVideoDubbedAudio } from '../src/utils/videoUtils.js';
import { downloadFile } from '../src/utils/fileUtils.js';
import path from 'path';
import fs from 'fs';

// Helper function to find article with video player
async function findArticleWithVideoPlayer(page: any): Promise<any | null> {
    logger.debug('[🐦 Helper] Searching for video player element...');

    const articleSelector = 'article[data-testid="tweet"]';

    // Find articles with video players
    const articles = await page.locator(articleSelector).all();
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!await article.isVisible().catch(() => false)) {
            continue;
        }

        // Look for video element or broadcast player
        const videoElement = article.locator('video').first();
        if (await videoElement.isVisible({ timeout: 500 }).catch(() => false)) {
            logger.info(`[🐦 Helper] Found video element in article ${i + 1}`);
            return article;
        }

        // Also check for broadcast player div
        const broadcastPlayer = article.locator('div[data-testid*="videoPlayer"], div[data-testid*="broadcast"]').first();
        if (await broadcastPlayer.isVisible({ timeout: 500 }).catch(() => false)) {
            logger.info(`[🐦 Helper] Found broadcast player in article ${i + 1}`);
            return article;
        }
    }

    logger.warn('[🐦 Helper] No article with video player found');
    return null;
}

async function processBroadcastVideo(tweetId: string, manualM3u8Url?: string) {
    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[BROADCAST VIDEO] Processing Tweet: ${tweetId}`);
    if (manualM3u8Url) {
        logger.info(`[BROADCAST VIDEO] Using manually provided m3u8 URL`);
    }
    logger.info(`${'='.repeat(80)}\n`);

    // Step 1: Get mention
    const mention = await getMention(tweetId);
    if (!mention) {
        logger.error(`[BROADCAST VIDEO] Mention not found`);
        process.exit(1);
    }

    logger.info(`[BROADCAST VIDEO] Step 1: Found mention @${mention.username}`);

    // Step 2: Detect languages
    const { sourceLanguageCode, sourceLanguageName, targetLanguageCode, targetLanguageName } = detectLanguages(mention.tweet_text);
    logger.info(`[BROADCAST VIDEO] Step 2: Languages: ${sourceLanguageName} → ${targetLanguageName}`);

    await updateMentionStatus(tweetId, 'initiating', {
        source_language: sourceLanguageCode,
        target_language: targetLanguageCode
    });

    // Step 3: Fetch broadcast URL
    logger.info(`[BROADCAST VIDEO] Step 3: Fetching broadcast URL...`);
    const { videoUrl, parentTweetId } = await fetchVideoForMention(tweetId);

    if (!videoUrl) {
        logger.error(`[BROADCAST VIDEO] No URL found`);
        process.exit(1);
    }

    const isBroadcastUrl = videoUrl.match(/https:\/\/(?:twitter|x)\.com\/i\/broadcasts\/([a-zA-Z0-9]+)/);
    if (!isBroadcastUrl) {
        logger.error(`[BROADCAST VIDEO] Not a broadcast URL: ${videoUrl}`);
        process.exit(1);
    }

    const broadcastId = isBroadcastUrl[1];
    logger.info(`[BROADCAST VIDEO] ✅ Broadcast URL: ${videoUrl}`);
    logger.info(`[BROADCAST VIDEO] Broadcast ID: ${broadcastId}`);

    // Step 4: Skip browser extraction if manual m3u8 URL is provided
    let m3u8Url: string | null = manualM3u8Url || null;
    let browser: any = null;

    if (manualM3u8Url) {
        logger.info(`\n[BROADCAST VIDEO] Step 4-5: Skipping browser extraction, using provided m3u8 URL`);
        logger.info(`[BROADCAST VIDEO] ✅ M3U8 URL: ${manualM3u8Url}`);
    } else {
        // Step 4: Initialize browser
        logger.info(`\n[BROADCAST VIDEO] Step 4: Launching Playwright browser...`);
        const browserData = await initializeDaemonBrowser();
        browser = browserData.browser;
        const context = browserData.context;
        const page = await context.newPage();

        try {
            // Step 5: Set up network listener BEFORE navigating
            logger.info(`[BROADCAST VIDEO] Step 5: Setting up network request/response listeners...`);

        // Enable CDP (Chrome DevTools Protocol) for low-level network interception
        const client = await context.newCDPSession(page);
        await client.send('Network.enable');

        // CDP Network.requestWillBeSent captures ALL requests
        client.on('Network.requestWillBeSent', (params: any) => {
            const url = params.request.url;
            if (!m3u8Url && !url.includes('thumbnail')) {
                if ((url.includes('.m3u8') && (url.includes('playlist') || url.includes('/hls/'))) ||
                    (url.includes('pscp.tv') && url.includes('/hls/'))) {
                    logger.info(`[BROADCAST VIDEO] 🎯 CDP captured m3u8 URL: ${url}`);
                    m3u8Url = url;
                }
            }
        });

        // Also keep Playwright listeners as backup
        page.on('request', (request: any) => {
            const url = request.url();
            // Look for m3u8 playlist URLs, exclude thumbnails
            if (url.includes('.m3u8') && !url.includes('thumbnail') && !m3u8Url) {
                // Prioritize URLs with 'playlist' and 'hls' in them
                if (url.includes('playlist') || url.includes('/hls/')) {
                    logger.info(`[BROADCAST VIDEO] 🎯 Captured m3u8 playlist URL from request: ${url}`);
                    m3u8Url = url;
                }
            }
        });

        page.on('response', (response: any) => {
            const url = response.url();
            // Look for pscp.tv video streams or m3u8 playlists, but exclude thumbnails
            if (!m3u8Url && !url.includes('thumbnail')) {
                if (url.includes('.m3u8') && (url.includes('playlist') || url.includes('/hls/'))) {
                    logger.info(`[BROADCAST VIDEO] 🎯 Captured m3u8 playlist URL from response: ${url}`);
                    m3u8Url = url;
                } else if (url.includes('pscp.tv') && url.includes('/hls/')) {
                    logger.info(`[BROADCAST VIDEO] 🎯 Captured pscp.tv HLS stream URL from response: ${url}`);
                    m3u8Url = url;
                }
            }
        });

        // Navigate to parent tweet
        const parentTweetUrl = `https://twitter.com/i/status/${parentTweetId}`;
        logger.info(`[BROADCAST VIDEO] Navigating to parent tweet: ${parentTweetUrl}`);
        await page.goto(parentTweetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

        // Wait for video to autoplay and network request to fire
        logger.info(`[BROADCAST VIDEO] Waiting for video to load and capture stream URL...`);

        // Wait up to 30 seconds for m3u8 URL to be captured
        const startTime = Date.now();
        const maxWaitTime = 30000; // 30 seconds

        while (!m3u8Url && (Date.now() - startTime) < maxWaitTime) {
            await page.waitForTimeout(1000);
        }

        if (!m3u8Url) {
            // Fallback 1: try to find video element and get src
            logger.info(`[BROADCAST VIDEO] No m3u8 captured from network, checking video element src...`);
            const videoSrc = await page.locator('video').first().getAttribute('src').catch(() => null);
            if (videoSrc && (videoSrc.includes('.m3u8') || videoSrc.includes('pscp.tv'))) {
                m3u8Url = videoSrc;
                logger.info(`[BROADCAST VIDEO] 🎯 Found m3u8 in video element: ${m3u8Url}`);
            }
        }

        if (!m3u8Url) {
            // Fallback 2: Extract m3u8 from page JavaScript/HTML
            logger.info(`[BROADCAST VIDEO] Trying to extract m3u8 from broadcast page directly...`);

            // Navigate directly to broadcast URL
            logger.info(`[BROADCAST VIDEO] Navigating to broadcast URL: ${videoUrl}`);
            await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            // Wait for page to load
            await page.waitForTimeout(3000);

            // Try to find and click play button to trigger video load
            try {
                logger.info(`[BROADCAST VIDEO] Looking for play button...`);
                const playButton = page.locator('button[aria-label*="Play"], button:has-text("Play"), [data-testid*="play"]').first();
                if (await playButton.isVisible({ timeout: 2000 }).catch(() => false)) {
                    logger.info(`[BROADCAST VIDEO] Found play button, clicking...`);
                    await playButton.click();
                    // Wait for network requests after clicking play
                    await page.waitForTimeout(10000);
                } else {
                    logger.info(`[BROADCAST VIDEO] No play button found, video might autoplay`);
                    await page.waitForTimeout(10000);
                }
            } catch (e) {
                logger.info(`[BROADCAST VIDEO] Could not interact with play button: ${e}`);
                await page.waitForTimeout(5000);
            }

            // Try to extract m3u8 from page content
            const pageContent = await page.content();

            // Look for m3u8 playlist URLs in the page HTML (with /hls/ and playlist)
            const m3u8Matches = pageContent.match(/https?:\/\/[^"'>\s]+\.m3u8[^"'>\s]*/g);
            if (m3u8Matches && m3u8Matches.length > 0) {
                // Find URLs with playlist and/or hls, exclude thumbnails
                const validM3u8 = m3u8Matches.find(url =>
                    !url.includes('thumbnail') &&
                    (url.includes('playlist') || url.includes('/hls/'))
                );
                if (validM3u8) {
                    m3u8Url = validM3u8.replace(/\\u002F/g, '/').replace(/\\"/g, '');
                    logger.info(`[BROADCAST VIDEO] 🎯 Found m3u8 playlist in page HTML: ${m3u8Url}`);
                }
            }

            // Also try to find pscp.tv HLS URLs directly
            if (!m3u8Url) {
                const hlsMatches = pageContent.match(/https?:\/\/[^"'>\s]*pscp\.tv[^"'>\s]*\/hls\/[^"'>\s]*/gi);
                if (hlsMatches && hlsMatches.length > 0) {
                    // Filter out thumbnail URLs
                    const validHls = hlsMatches.find(url => !url.includes('thumbnail'));
                    if (validHls) {
                        m3u8Url = validHls.replace(/\\u002F/g, '/').replace(/\\"/g, '');
                        logger.info(`[BROADCAST VIDEO] 🎯 Found pscp.tv HLS URL in page HTML: ${m3u8Url}`);
                    }
                }
            }

            // Try executing JavaScript to get player data
            if (!m3u8Url) {
                logger.info(`[BROADCAST VIDEO] Trying to extract from window object...`);
                const playerUrl = await page.evaluate(() => {
                    // Try to find player data in window object
                    const win = window as any;
                    if (win.__INITIAL_STATE__) {
                        return JSON.stringify(win.__INITIAL_STATE__);
                    }
                    if (win.__data) {
                        return JSON.stringify(win.__data);
                    }
                    return null;
                }).catch(() => null);

                if (playerUrl) {
                    const urlMatches = playerUrl.match(/https?:\/\/[^"'>\s]+\.m3u8[^"'>\s]*/g);
                    if (urlMatches && urlMatches.length > 0) {
                        m3u8Url = urlMatches[0];
                        logger.info(`[BROADCAST VIDEO] 🎯 Found m3u8 in window object: ${m3u8Url}`);
                    }
                }
            }
        }

            if (!m3u8Url) {
                throw new Error('Failed to capture m3u8 URL from network, video element, or page content');
            }

            logger.info(`[BROADCAST VIDEO] ✅ M3U8 URL captured: ${m3u8Url}`);

            // Close browser
            await browser.close();

        } catch (error) {
            logger.error(`[BROADCAST VIDEO] Browser extraction error:`, error);
            if (browser) {
                await browser.close().catch(() => {});
            }
            throw error;
        }
    } // End of if (!manualM3u8Url)

    try {
        // Step 6: Update database
        logger.info(`\n[BROADCAST VIDEO] Step 6: Updating database with m3u8 and content_type='video'...`);
        await updateMentionStatus(tweetId, 'processing', {
            m3u8_url: m3u8Url,
            content_type: 'video'
        });
        logger.info(`[BROADCAST VIDEO] ✅ Database updated`);

        // Step 7: Download video and upload to S3
        logger.info(`\n[BROADCAST VIDEO] Step 7: Downloading video and uploading to S3...`);
        const videoS3Url = await downloadAndUploadVideo(m3u8Url, `broadcast_${broadcastId}`);

        if (!videoS3Url) {
            throw new Error('Failed to download and upload video');
        }

        logger.info(`[BROADCAST VIDEO] ✅ Video uploaded to S3: ${videoS3Url}`);

        // Step 8: Create SpeechLab dubbing project
        logger.info(`\n[BROADCAST VIDEO] Step 8: Creating SpeechLab dubbing project...`);
        const thirdPartyID = `broadcast-video-${sourceLanguageCode}-to-${targetLanguageCode}-${tweetId}`;

        const projectId = await createDubbingProject(
            videoS3Url,
            `Broadcast Video from @${mention.parent_username || mention.username}`,
            targetLanguageCode,
            thirdPartyID,
            sourceLanguageCode
        );

        if (!projectId) {
            throw new Error('Failed to create dubbing project');
        }

        logger.info(`[BROADCAST VIDEO] ✅ Project created: ${projectId}`);

        // Step 9: Wait for completion
        logger.info(`\n[BROADCAST VIDEO] Step 9: Waiting for dubbing to complete (this may take 10-15 minutes)...`);
        const maxWaitTimeMs = 6 * 60 * 60 * 1000; // 6 hours
        const completedProject = await waitForProjectCompletion(thirdPartyID, maxWaitTimeMs);

        if (!completedProject || completedProject.job?.status !== 'COMPLETE') {
            throw new Error(`Project did not complete successfully`);
        }

        logger.info(`[BROADCAST VIDEO] ✅ Dubbing complete!`);

        // Step 10: Get dubbed video URL
        logger.info(`\n[BROADCAST VIDEO] Step 10: Getting dubbed video URL...`);
        const outputVideo = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
            d.category === 'video' && d.format === 'mp4' && d.operationType === 'OUTPUT'
        );

        if (!outputVideo?.presignedURL) {
            throw new Error('No dubbed video found in completed project medias');
        }

        logger.info(`[BROADCAST VIDEO] Found dubbed video with presigned URL`);

        // Step 11: Download dubbed video
        logger.info(`\n[BROADCAST VIDEO] Step 11: Downloading dubbed video...`);
        const tempDir = path.join(process.cwd(), 'temp_audio');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const dubbedVideoPath = path.join(tempDir, `dubbed_${broadcastId}_${Date.now()}.mp4`);
        await downloadFile(outputVideo.presignedURL, dubbedVideoPath);
        logger.info(`[BROADCAST VIDEO] ✅ Downloaded dubbed video to: ${dubbedVideoPath}`);

        // Step 12: Post reply with VIDEO
        logger.info(`\n[BROADCAST VIDEO] Step 12: Posting reply tweet with dubbed VIDEO...`);
        const replyText = `🎬 Dubbed to ${targetLanguageName}`;

        const result = await postReplyWithMedia(
            tweetId,
            replyText,
            dubbedVideoPath,
            'video'
        );

        if (!result.success) {
            throw new Error('Failed to post reply tweet');
        }

        logger.info(`[BROADCAST VIDEO] ✅ Reply posted: ${result.tweetUrl}`);

        // Step 13: Update database with completion
        logger.info(`\n[BROADCAST VIDEO] Step 13: Updating database with completion...`);
        await updateMentionStatus(tweetId, 'complete', {
            dub_reply_tweet_id: result.tweetId,
            dub_reply_tweet_url: result.tweetUrl,
            public_video_url: videoS3Url
        });

        logger.info(`[BROADCAST VIDEO] ✅ Database updated`);

        // Cleanup
        if (fs.existsSync(dubbedVideoPath)) {
            fs.unlinkSync(dubbedVideoPath);
            logger.info(`[BROADCAST VIDEO] Cleaned up temp file`);
        }

        logger.info(`\n${'='.repeat(80)}`);
        logger.info(`[BROADCAST VIDEO] ✅ PROCESSING COMPLETE!`);
        logger.info(`[BROADCAST VIDEO] Reply Tweet: ${result.tweetUrl}`);
        logger.info(`${'='.repeat(80)}\n`);

    } catch (error) {
        logger.error(`[BROADCAST VIDEO] Error:`, error);
        await browser.close().catch(() => {});
        await updateMentionStatus(tweetId, 'failed', {
            error_message: error instanceof Error ? error.message : String(error)
        });
        throw error;
    }
}

const tweetId = process.argv[2];
const manualM3u8Url = process.argv[3];

if (!tweetId) {
    logger.error('[BROADCAST VIDEO] Usage: npx tsx scripts/process-broadcast-video.ts <tweet_id> [m3u8_url]');
    logger.error('[BROADCAST VIDEO] Example: npx tsx scripts/process-broadcast-video.ts 1234567890 "https://...playlist.m3u8"');
    process.exit(1);
}

if (manualM3u8Url) {
    logger.info(`[BROADCAST VIDEO] Using manually provided m3u8 URL: ${manualM3u8Url}`);
}

processBroadcastVideo(tweetId, manualM3u8Url)
    .then(() => {
        logger.info('[BROADCAST VIDEO] Script completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[BROADCAST VIDEO] Script failed:', error);
        process.exit(1);
    });
