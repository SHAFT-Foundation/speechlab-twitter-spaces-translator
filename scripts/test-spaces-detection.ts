#!/usr/bin/env tsx
/**
 * Test Twitter Spaces Detection
 *
 * Tests if Spaces M3U8 extraction is working correctly
 */

import { chromium } from 'playwright';
import logger from '../src/utils/logger';

async function testSpacesDetection(tweetUrl: string) {
    let browser;
    try {
        logger.info('[🧪 Test] Testing Spaces detection for:', tweetUrl);

        browser = await chromium.launch({
            headless: false, // Show browser so you can see what's happening
            args: ['--no-sandbox']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        const page = await context.newPage();

        // Set up M3U8 detection
        let m3u8Url: string | null = null;

        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('.m3u8')) {
                logger.info(`[🧪 Test] ✅ Found M3U8 URL: ${url}`);
                if (!m3u8Url) {
                    m3u8Url = url;
                }
            }
        });

        // Navigate to tweet
        logger.info('[🧪 Test] Navigating to tweet...');
        await page.goto(tweetUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        // Look for Spaces elements
        logger.info('[🧪 Test] Looking for Spaces elements...');

        // Try multiple selectors
        const selectors = [
            'article[role="article"]',
            'div[data-testid="cellInnerDiv"]',
            'button[aria-label*="Play"]',
            'button[aria-label*="space"]',
            'a[href*="/spaces/"]'
        ];

        for (const selector of selectors) {
            const elements = await page.locator(selector).all();
            if (elements.length > 0) {
                logger.info(`[🧪 Test] Found ${elements.length} elements matching: ${selector}`);

                for (let i = 0; i < Math.min(elements.length, 3); i++) {
                    const text = await elements[i].textContent().catch(() => '');
                    const ariaLabel = await elements[i].getAttribute('aria-label').catch(() => '');
                    logger.info(`   Element ${i + 1}: text="${text?.substring(0, 50)}", aria-label="${ariaLabel}"`);
                }
            }
        }

        // Try clicking Play button if found
        logger.info('[🧪 Test] Attempting to click Play button...');
        const playButton = page.locator('button[aria-label*="Play"]').first();

        if (await playButton.count() > 0) {
            logger.info('[🧪 Test] Play button found, clicking...');
            await playButton.click();
            await page.waitForTimeout(5000); // Wait for M3U8 request

            if (m3u8Url) {
                logger.info(`[🧪 Test] ✅ Successfully captured M3U8 URL: ${m3u8Url}`);
            } else {
                logger.warn('[🧪 Test] ⚠️  Play button clicked but no M3U8 URL detected');
                logger.info('[🧪 Test] Waiting longer for M3U8...');
                await page.waitForTimeout(10000);
                if (m3u8Url) {
                    logger.info(`[🧪 Test] ✅ M3U8 URL captured after delay: ${m3u8Url}`);
                } else {
                    logger.error('[🧪 Test] ❌ No M3U8 URL detected after 15 seconds');
                }
            }
        } else {
            logger.warn('[🧪 Test] ⚠️  No Play button found on page');
            logger.info('[🧪 Test] This may not be a Spaces tweet, or Spaces UI has changed');
        }

        // Take screenshot for debugging
        const screenshotPath = `/tmp/spaces-test-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`[🧪 Test] Screenshot saved to: ${screenshotPath}`);

        // Keep browser open for manual inspection
        logger.info('[🧪 Test] Browser will stay open for 30 seconds for manual inspection...');
        await page.waitForTimeout(30000);

        logger.info('\n========================================');
        logger.info('🧪 Test Results:');
        logger.info('========================================');
        logger.info(`M3U8 URL detected: ${m3u8Url ? '✅ YES' : '❌ NO'}`);
        if (m3u8Url) {
            logger.info(`M3U8 URL: ${m3u8Url}`);
        }
        logger.info(`Screenshot: ${screenshotPath}`);
        logger.info('========================================\n');

        await browser.close();

        process.exit(m3u8Url ? 0 : 1);

    } catch (error) {
        logger.error('[🧪 Test] Test failed:', error);
        if (browser) {
            await browser.close();
        }
        process.exit(1);
    }
}

// Get tweet URL from command line
const tweetUrl = process.argv[2];

if (!tweetUrl) {
    console.error('Usage: npx tsx scripts/test-spaces-detection.ts <tweet_url>');
    console.error('Example: npx tsx scripts/test-spaces-detection.ts https://twitter.com/username/status/1234567890');
    process.exit(1);
}

testSpacesDetection(tweetUrl);
