import { chromium, Browser, BrowserContext, Page, BrowserContextOptions } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import winston from 'winston';
import { getProjectByThirdPartyID, Project, Translation, DubObject, DubMedia } from './services/speechlabApiService'; // Import the function to get project details
import { downloadFile } from './utils/fileUtils'; // Import the download utility
import { exec } from 'child_process'; // Import exec
import util from 'util'; // Import util for promisify
// Import necessary functions from twitterInteractionService
import { initializeDaemonBrowser, postReplyToTweet } from './services/twitterInteractionService'; 

// Promisify exec for easier async/await usage
const execPromise = util.promisify(exec);

// Configure environment
dotenv.config();

// Constants
const COOKIE_PATH = path.join(process.cwd(), 'cookies', 'twitter-cookies.json'); // Need cookie path
const TEMP_AUDIO_DIR = path.join(process.cwd(), 'temp_audio_test'); // Changed dir name
const TEMP_VIDEO_DIR = path.join(process.cwd(), 'temp_video_test'); 
const PLACEHOLDER_IMAGE_PATH = path.join(process.cwd(), 'placeholder.jpg'); // Assumed path
const LOG_DIR = path.join(process.cwd(), 'logs');
const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots'); // For browser screenshots

// Set up logging
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      // Changed log prefix
      return `${timestamp} [${level.toUpperCase()}] [VIDEO-POST-TEST] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      // Changed log filename
      filename: path.join(LOG_DIR, 'test-video-post.log'),
      options: { flags: 'w' } // Overwrite existing log file
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

// Function to check login status (can reuse or adapt from mentionDaemon)
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
                 await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-video-post-login-check-success.png') });
                 return true;
             }
        }
        logger.warn('❌ Login check failed: No success indicators visible on /home.');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-video-post-login-check-fail.png') });
        return false;
    } catch (error) {
        logger.error('Error during login check navigation/verification:', error);
        try { await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-video-post-login-check-error.png') }); } catch {}
        return false;
    }
}

// Main test function
async function testVideoDownloadAndPost() {
  logger.info('Starting Test: Download MP3 -> Convert to MP4 -> Post Reply');
  
  // Ensure necessary directories exist
  await ensureDirectoryExists(LOG_DIR);
  await ensureDirectoryExists(TEMP_AUDIO_DIR); // Changed dir name
  await ensureDirectoryExists(TEMP_VIDEO_DIR);
  await ensureDirectoryExists(SCREENSHOT_DIR);
  await ensureDirectoryExists(path.dirname(COOKIE_PATH)); // Ensure cookies dir exists
  
  // --- Configuration --- 
  const testThirdPartyID = 'free-memecoin-launch-zh'; 
  const testReplyTweetUrl = 'https://x.com/RyanAtSpeechlab/status/1911421752871211011'; // Target for the reply
  const replyText = `[TEST] Attaching generated video for ${testThirdPartyID} (${new Date().toISOString()})`;
  const expectedAudioFormat = 'mp3';
  const expectedCategory = 'audio';
  const expectedOperationType = 'OUTPUT';
  // --------------------

  let downloadedAudioPath: string | undefined = undefined;
  let generatedVideoPath: string | undefined = undefined;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // --- Part 1: Get Project Details & Generate Video (No Browser Needed Yet) ---
    logger.info('--- Phase 1: Fetching Project and Generating Video ---');
    try {
        await fs.access(PLACEHOLDER_IMAGE_PATH);
        logger.info(`Placeholder image found at: ${PLACEHOLDER_IMAGE_PATH}`);
    } catch (imgError) {
        logger.error(`❌ Placeholder image NOT FOUND at: ${PLACEHOLDER_IMAGE_PATH}`);
        logger.error('Please create a placeholder.jpg file in the project root directory.');
        return; // Cannot proceed without the image
    }

    logger.info(`Fetching project details for thirdPartyID: ${testThirdPartyID}`);
    const project = await getProjectByThirdPartyID(testThirdPartyID);

    if (!project) {
      logger.error(`Project not found for thirdPartyID: ${testThirdPartyID}. Cannot proceed.`);
      return;
    }

    if (project.job?.status !== 'COMPLETE') {
       logger.warn(`Project status is ${project.job?.status}, not COMPLETE. Audio might not be available or final.`);
    }

    logger.info(`Project found. Searching for ${expectedAudioFormat} output...`);
    logger.debug(`Full Project structure: ${JSON.stringify(project, null, 2)}`);

    // Find AUDIO output using the correct, deeply nested path
    const outputAudio = project.translations?.[0]?.dub?.[0]?.medias?.find((d: DubMedia) => 
        d.category === expectedCategory && 
        d.format === expectedAudioFormat && 
        d.operationType === expectedOperationType
    );

    if (outputAudio?.presignedURL) {
        logger.info(`Found output ${expectedAudioFormat} URL: ${outputAudio.presignedURL}`);
        const audioFilename = `${testThirdPartyID}.mp3`; // MP3 extension
        const destinationAudioPath = path.join(TEMP_AUDIO_DIR, audioFilename);
        downloadedAudioPath = destinationAudioPath; // Store path for cleanup
        
        logger.info(`Attempting to download audio to ${destinationAudioPath}...`);
        const downloadSuccess = await downloadFile(outputAudio.presignedURL, destinationAudioPath);
        
        if (downloadSuccess) {
            logger.info(`✅ Successfully downloaded audio: ${destinationAudioPath}`);
            
            // Now attempt ffmpeg conversion
            const videoFilename = `${testThirdPartyID}_test_post.mp4`; // Unique name for test video
            const destinationVideoPath = path.join(TEMP_VIDEO_DIR, videoFilename);
            generatedVideoPath = destinationVideoPath; // Store path for cleanup

            logger.info(`Attempting to convert ${destinationAudioPath} + ${PLACEHOLDER_IMAGE_PATH} to ${destinationVideoPath} using ffmpeg...`);
            
            // Ensure paths are properly escaped for the shell command
            const escapedImagePath = `"${PLACEHOLDER_IMAGE_PATH}"`;
            const escapedAudioPath = `"${destinationAudioPath}"`;
            const escapedVideoPath = `"${destinationVideoPath}"`;

            // Adjusted ffmpeg command with scaling filter
            // -vf "scale=w=-2:h=194" ensures width is even while keeping height 194
            // Or use "scale=w=260:h=-2" to set width and auto-adjust height
            const ffmpegCommand = `ffmpeg -loop 1 -y -i ${escapedImagePath} -i ${escapedAudioPath} -vf "scale=w=-2:h=194" -c:v libx264 -c:a aac -b:a 192k -pix_fmt yuv420p -shortest ${escapedVideoPath}`;
            logger.debug(`Executing ffmpeg command: ${ffmpegCommand}`);

            try {
                const { stdout, stderr } = await execPromise(ffmpegCommand);
                if (stderr && !stderr.toLowerCase().includes('success')) { // ffmpeg often logs info to stderr
                    logger.warn(`[FFMPEG STDERR]:\n${stderr}`);
                }
                if (stdout) {
                    logger.debug(`[FFMPEG STDOUT]:\n${stdout}`);
                }
                 // Verify file creation
                await fs.access(destinationVideoPath);
                logger.info(`✅ Successfully generated video: ${destinationVideoPath}`);

            } catch (ffmpegError: any) {
                logger.error(`❌ FFMPEG execution failed:`, ffmpegError);
                logger.error(`FFMPEG STDERR: ${ffmpegError.stderr}`);
                logger.error(`FFMPEG STDOUT: ${ffmpegError.stdout}`);
                generatedVideoPath = undefined; // Don't cleanup if conversion failed
            }

        } else {
            logger.error(`❌ Failed to download audio file from presigned URL.`);
            downloadedAudioPath = undefined; // Don't try to clean up if download failed
        }
    } else {
        logger.error(`❌ Could not find ${expectedAudioFormat} audio output URL with category=${expectedCategory} and operationType=${expectedOperationType} in project details.`);
    }

    // --- Part 2: Post to Twitter using Playwright --- 
    logger.info('--- Phase 2: Posting Video Reply to Twitter ---');
    if (!generatedVideoPath) {
        logger.error('Cannot proceed to posting: Video generation failed or path is missing.');
        return;
    }

    logger.info('Initializing Playwright browser for posting...');
    // Use initializeDaemonBrowser to handle cookie/state loading logic
    const browserInfo = await initializeDaemonBrowser(); 
    browser = browserInfo.browser;
    context = browserInfo.context;
    page = await context.newPage();

    // Verify login status
    const isLoggedIn = await checkLoginStatus(page);
    if (!isLoggedIn) {
        logger.error('Login check failed after initializing browser. Ensure valid cookies/state exist.');
        throw new Error('Test cannot proceed without login.'); // Throw error to trigger finally block
    }
    logger.info('Login verified. Proceeding to post reply...');

    // Call the actual postReplyToTweet function
    const postSuccess = await postReplyToTweet(
        page, 
        testReplyTweetUrl, 
        replyText, 
        generatedVideoPath // Pass the path to the generated MP4
    );

    if (postSuccess) {
        logger.info(`✅✅ Successfully posted reply with video to ${testReplyTweetUrl}`);
    } else {
        logger.error(`❌❌ Failed to post reply with video to ${testReplyTweetUrl}`);
    }

  } catch (error) {
    logger.error('Error during test execution:', error);
  } finally {
    // Cleanup browser
     logger.info('Cleaning up browser...');
    if (page) await page.close().catch(e => logger.warn('Error closing page:', e));
    if (context) await context.close().catch(e => logger.warn('Error closing context:', e));
    if (browser) await browser.close().catch(e => logger.warn('Error closing browser:', e));

    // Cleanup downloaded/generated files
    if (downloadedAudioPath) {
        logger.info(`Cleaning up temporary audio file: ${downloadedAudioPath}`);
        await fs.unlink(downloadedAudioPath).catch(err => logger.warn(`Failed to delete temp audio ${downloadedAudioPath}:`, err));
    }
    if (generatedVideoPath) {
        logger.info(`Cleaning up generated video file: ${generatedVideoPath}`);
        await fs.unlink(generatedVideoPath).catch(err => logger.warn(`Failed to delete generated video ${generatedVideoPath}:`, err));
    }
    logger.info('Test finished.');
  }
}

// Run the test
testVideoDownloadAndPost().catch(error => { // Renamed function call
  logger.error('Unhandled error in main test function:', error);
  process.exit(1);
}); 