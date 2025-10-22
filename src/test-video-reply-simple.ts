import { Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import winston from 'winston';
import { initializeDaemonBrowser, postReplyToTweet } from './services/twitterInteractionService';

// Configure environment
dotenv.config();

// Constants
const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
const LOG_DIR = path.join(process.cwd(), 'logs');

// Set up logging
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] [VIDEO-REPLY-TEST] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'test-video-reply-simple.log'),
      options: { flags: 'w' }
    })
  ]
});

// Create directories if they don't exist
async function ensureDirectoryExists(directory: string) {
  try {
    await fs.access(directory);
  } catch (error) {
    await fs.mkdir(directory, { recursive: true });
  }
}

// Check login status
async function checkLoginStatus(page: Page): Promise<boolean> {
    logger.info('Checking login status via /home...');
    try {
        await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        logger.info('Navigated to /home page structure.');
        logger.info('Waiting 10 seconds for dynamic content...');
        await page.waitForTimeout(10000);

        const successIndicators = [
            '[data-testid="primaryColumn"]',
            'aside[aria-label*="Account menu"]',
            '[data-testid="SideNav_NewTweet_Button"]'
        ];

        for (const selector of successIndicators) {
             if (await page.locator(selector).first().isVisible({ timeout: 5000 }).catch(() => false)) {
                 logger.info(`✅ Login status verified! (Indicator: ${selector})`);
                 await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-video-reply-login-success.png') });
                 return true;
             }
        }
        logger.warn('❌ Login check failed: No success indicators visible on /home.');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-video-reply-login-fail.png') });
        return false;
    } catch (error) {
        logger.error('Error during login check navigation/verification:', error);
        try { await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-video-reply-login-error.png') }); } catch {}
        return false;
    }
}

// Main test function
async function testVideoReply() {
  logger.info('========================================');
  logger.info('Starting Simple Video Reply Test');
  logger.info('========================================');

  await ensureDirectoryExists(LOG_DIR);
  await ensureDirectoryExists(SCREENSHOT_DIR);

  // Configuration
  const TEST_TWEET_URL = 'https://x.com/RyanAtSpeechlab/status/1980770274782945627';
  const VIDEO_PATH = path.join(process.cwd(), 'temp_video', 'reply_video_1980770274782945627.mp4');
  const REPLY_TEXT = `Test video reply with attachment - ${new Date().toLocaleTimeString()}`;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Verify video file exists
    logger.info('--- Phase 1: Checking Video File ---');
    try {
        await fs.access(VIDEO_PATH);
        const stats = await fs.stat(VIDEO_PATH);
        logger.info(`✅ Found video file: ${VIDEO_PATH}`);
        logger.info(`   Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (fileError) {
        logger.error(`❌ Video file NOT FOUND at: ${VIDEO_PATH}`);
        logger.info('Available video files:');
        const tempVideoDir = path.join(process.cwd(), 'temp_video');
        try {
            const files = await fs.readdir(tempVideoDir);
            files.filter(f => f.endsWith('.mp4')).forEach(f => logger.info(`   - ${f}`));
        } catch {}
        throw new Error('Video file not found');
    }

    // Initialize browser
    logger.info('--- Phase 2: Initializing Browser ---');
    const browserInfo = await initializeDaemonBrowser();
    browser = browserInfo.browser;
    context = browserInfo.context;
    page = await context.newPage();

    // Check login
    logger.info('--- Phase 3: Verifying Login ---');
    const isLoggedIn = await checkLoginStatus(page);
    if (!isLoggedIn) {
        throw new Error('Not logged in - cannot proceed');
    }

    // Post reply with video
    logger.info('--- Phase 4: Posting Video Reply ---');
    logger.info(`Tweet URL: ${TEST_TWEET_URL}`);
    logger.info(`Reply Text: ${REPLY_TEXT}`);
    logger.info(`Video: ${path.basename(VIDEO_PATH)}`);

    const postSuccess = await postReplyToTweet(
        page,
        TEST_TWEET_URL,
        REPLY_TEXT,
        VIDEO_PATH
    );

    if (postSuccess) {
        logger.info('========================================');
        logger.info('✅✅✅ SUCCESS: Video reply posted!');
        logger.info('========================================');
    } else {
        logger.error('========================================');
        logger.error('❌❌❌ FAILED: Could not post video reply');
        logger.error('========================================');
    }

  } catch (error) {
    logger.error('========================================');
    logger.error('❌ Test execution error:', error);
    logger.error('========================================');
  } finally {
    // Cleanup
    logger.info('--- Cleanup ---');
    if (page) await page.close().catch(e => logger.warn('Error closing page:', e));
    if (context) await context.close().catch(e => logger.warn('Error closing context:', e));
    if (browser) await browser.close().catch(e => logger.warn('Error closing browser:', e));
    logger.info('Test finished.');
  }
}

// Run the test
testVideoReply().catch(error => {
  logger.error('Unhandled error in main test function:', error);
  process.exit(1);
});
