import { chromium, Browser, BrowserContext, Page, BrowserContextOptions } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import winston from 'winston';
import { config } from './utils/config'; // Import config

// Configure environment
dotenv.config();

// Constants
const COOKIE_PATH = path.join(process.cwd(), 'cookies', 'twitter-cookies.json');
const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
const LOG_DIR = path.join(process.cwd(), 'logs');

// Set up logging
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ 
      filename: path.join(LOG_DIR, 'test-space-extraction.log'),
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

// Function to load cookies
async function loadCookies(context: BrowserContext) {
  try {
    logger.info(`Attempting to load cookies from: ${COOKIE_PATH}`);
    await fs.access(COOKIE_PATH);
    const cookiesString = await fs.readFile(COOKIE_PATH, 'utf-8');
    const cookies = JSON.parse(cookiesString);
    await context.addCookies(cookies);
    logger.info(`Successfully loaded ${cookies.length} cookies.`);
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.warn('Cookie file not found. Proceeding without loading cookies.');
    } else {
      logger.error('Error loading cookies:', error);
    }
    return false;
  }
}

// Function to check if logged in
async function checkLoginStatus(page: Page): Promise<boolean> {
    logger.info('Checking login status...');
    try {
        // Go to home page as a simple check
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Look for a common element that only appears when logged in
        const homeTimelineSelector = '[data-testid="primaryColumn"]'; // Example selector
        await page.waitForSelector(homeTimelineSelector, { timeout: 10000, state: 'visible' });
        logger.info('✅ Login status confirmed (found home timeline element).');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-check-success.png') });
        return true;
    } catch (error) {
        logger.warn('Login check failed. User might not be logged in.');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-check-failed.png') });
        return false;
    }
}

// Main test function
async function testSpaceExtraction() {
  logger.info('Starting Twitter Space extraction test');
  
  // Ensure necessary directories exist
  await ensureDirectoryExists(SCREENSHOT_DIR);
  await ensureDirectoryExists(LOG_DIR);
  await ensureDirectoryExists(path.dirname(COOKIE_PATH));
  
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  
  try {
    // Initialize browser
    logger.info('Launching browser...');
    browser = await chromium.launch({ headless: config.BROWSER_HEADLESS ?? false }); // Use config setting
    
    // Create context and load cookies
    logger.info('Creating browser context...');
    const contextOptions: BrowserContextOptions = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    };
    context = await browser.newContext(contextOptions);
    const cookiesLoaded = await loadCookies(context);
    if (!cookiesLoaded) {
        logger.error('Failed to load cookies. Aborting test as login is required.');
        return; // Stop if cookies can't be loaded
    }

    page = await context.newPage();
    
    // Verify login status
    const isLoggedIn = await checkLoginStatus(page);
    if (!isLoggedIn) {
        logger.error('Login check failed. Ensure valid cookies exist in cookies/twitter-cookies.json. Aborting test.');
        return; // Stop if not logged in
    }

    // Navigate to the test tweet
    const tweetUrl = 'https://x.com/RyanAtSpeechlab/status/1911181675243163665';
    logger.info(`Navigating to specific tweet: ${tweetUrl}`);
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'initial-tweet-page-logged-in.png') });
    await page.waitForTimeout(2000); // Allow dynamic content to load

    // Find article with Play button (might need to scroll up)
    logger.info('Searching for article with Play Recording button...');
    const articleWithPlayButton = await findArticleWithPlayButton(page);
    
    if (!articleWithPlayButton) {
      logger.error('Could not find article with Play button');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'no-play-button-found.png') });
      return;
    }
    
    logger.info('Found element containing Play button, taking screenshot...');
    // Check if it's a button or an article before screenshotting
    const tagName = await articleWithPlayButton.evaluate((el: Element) => el.tagName.toLowerCase());
    logger.info(`Element found is a: ${tagName}`);
    await articleWithPlayButton.screenshot({ path: path.join(SCREENSHOT_DIR, `found-element-${tagName}.png`) });
    
    // Determine the actual element to click (button might be returned directly)
    let playButtonLocator = articleWithPlayButton;
    if (tagName === 'article') {
      logger.info('Found article, locating button within it...');
      // Re-locate the button within the found article
      const playButtonSelectors = [
        'button[aria-label*="Play recording"]',
        'button:has-text("Play recording")',
        'div[data-testid*="audioSpace"] button[aria-label*="Play"]'
      ];
      for (const selector of playButtonSelectors) {
        const button = articleWithPlayButton.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) {
          playButtonLocator = button;
          logger.info(`Located play button within article using selector: ${selector}`);
          break;
        }
      }
      if (playButtonLocator === articleWithPlayButton) { // Check if locator was updated
         logger.error('Could not re-locate Play button within the found article.');
         return;
      }
    } else if (tagName !== 'button') {
        logger.error(`Expected an article or button, but found: ${tagName}`);
        return;
    }

    // Try to extract title before clicking play (if we have an article)
    let spaceTitle: string | null = null;
    if (tagName === 'article') {
        spaceTitle = await extractTitleBeforePlay(articleWithPlayButton);
        logger.info(`Title before clicking play (from article): "${spaceTitle || 'Not found'}"`);
    } else {
        logger.info('Skipping title extraction before play (element found was not an article).');
    }
    
    // Set up M3U8 capture
    logger.info('Setting up M3U8 URL capture...');
    let capturedM3u8Url: string | null = null;
    
    let resolveM3u8Promise: (url: string) => void;
    const m3u8Promise = new Promise<string>((resolve) => {
      resolveM3u8Promise = resolve;
    });
    
    page.on('request', request => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        logger.info(`M3U8 URL detected in request: ${url}`);
        if (!capturedM3u8Url) { // Only resolve once
             capturedM3u8Url = url;
             resolveM3u8Promise(url);
        }
      }
    });
    
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('live_video_stream') && !capturedM3u8Url) {
        logger.info(`Checking live_video_stream API response: ${url}`);
        try {
          const responseBody = await response.json().catch(() => null);
          if (responseBody) {
            const responseStr = JSON.stringify(responseBody);
            const urlMatches = responseStr.match(/"(https:\/\/[^"]*?\.m3u8[^"]*?)"/g);
            if (urlMatches && urlMatches.length > 0) {
              const cleanUrl = urlMatches[0].replace(/"/g, '');
              logger.info(`M3U8 URL extracted from API response: ${cleanUrl}`);
              if (!capturedM3u8Url) { // Only resolve once
                 capturedM3u8Url = cleanUrl;
                 resolveM3u8Promise(cleanUrl);
              }
            }
          }
        } catch (e) {
          logger.warn(`Error processing API response: ${e}`);
        }
      }
    });
    
    // Click the Play button
    logger.info('Clicking Play button...');
    await playButtonLocator.click({ force: true, timeout: 10000 });
    // INCREASED wait time for modal to appear and render fully
    logger.info('Waiting 5 seconds after click for modal to render...');
    await page.waitForTimeout(5000); 
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'after-play-click-and-wait.png') });
    
    // Log body HTML for debugging modal structure
    try {
        const bodyHtml = await page.locator('body').innerHTML();
        await fs.writeFile(path.join(LOG_DIR, 'body-after-click.html'), bodyHtml);
        logger.info('Saved body HTML to logs/body-after-click.html');
    } catch (htmlError) {
        logger.error('Failed to get or save body HTML:', htmlError);
    }
    
    // Wait for the modal to appear and extract title
    // logger.info('Waiting for modal to appear and extracting Space title...');
    // await page.waitForTimeout(3000); // Wait is now handled above
    
    // Attempt to extract title from modal
    const modalTitle = await extractTitleFromModal(page);
    if (modalTitle) {
      spaceTitle = modalTitle; // Update with modal title if found
      logger.info(`Title extracted from modal: "${spaceTitle}"`);
    } else {
        logger.warn('Could not extract title from modal. Final title will be from article (if found) or null.');
    }
    
    // Wait for m3u8 URL capture (with timeout)
    logger.info('Waiting for M3U8 URL capture (up to 30s)...');
    try {
      const m3u8Url = await Promise.race([
        m3u8Promise,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('M3U8 capture timeout')), 30000))
      ]);
      
      logger.info(`Successfully captured M3U8 URL: ${m3u8Url}`);
      
      const results = {
        tweetUrl,
        spaceTitle, // Will be modal title, article title, or null
        m3u8Url,
        timestamp: new Date().toISOString()
      };
      
      await fs.writeFile(
        path.join(process.cwd(), 'space-extraction-results.json'),
        JSON.stringify(results, null, 2)
      );
      
      logger.info('Test completed successfully! Results saved to space-extraction-results.json');
    } catch (error) {
      logger.error('Failed to capture M3U8 URL within timeout', error);
      // Still save results if title was found but M3U8 failed
      const results = {
        tweetUrl,
        spaceTitle,
        m3u8Url: null, // Indicate M3U8 failure
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      };
       await fs.writeFile(
        path.join(process.cwd(), 'space-extraction-results.json'),
        JSON.stringify(results, null, 2)
      );
    }
    
  } catch (error) {
    logger.error('Error during test execution:', error);
  } finally {
    // Cleanup
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    logger.info('Test completed, browser closed');
  }
}

// Helper function to find article or button containing Play
async function findArticleWithPlayButton(page: Page): Promise<any | null> {
  const playRecordingSelectors = [
    'button[aria-label*="Play recording"]',
    'button:has-text("Play recording")',
    'div[data-testid*="audioSpace"] button[aria-label*="Play"]', // More generic selector for space player
    'div[aria-label*="AudioSpace"] button[aria-label*="Play"]' // Another variation
  ];
  
  // Broader container search first (sometimes the tweet isn't in a standard article)
  logger.info('Searching for broader containers containing the play button...');
  const potentialContainers = await page.locator('div[data-testid="cellInnerDiv"]').all();
  logger.debug(`Found ${potentialContainers.length} potential cellInnerDiv containers`);
  for (let i = 0; i < potentialContainers.length; i++) {
      const container = potentialContainers[i];
      if (!await container.isVisible()) continue;
      for (const selector of playRecordingSelectors) {
          const button = container.locator(selector).first();
          if (await button.isVisible({ timeout: 500 })) {
              logger.info(`Found Play button inside cellInnerDiv container ${i + 1} using selector: ${selector}`);
              // Check if this container also contains the specific tweet text/handle for confirmation
              const tweetText = await container.textContent() || '';
              if (tweetText.includes('RyanAtSpeechlab')) { // Check for username
                 logger.info(`Confirmed container belongs to the target tweet author. Returning the button.`);
                 return button; // Return the button directly if found in a likely container
              }
          }
      }
  }

  // First try to find within standard articles without scrolling
  logger.info('Initial check for Play button within articles without scrolling...');
  const initialCheck = await checkArticlesForPlayButton(page, playRecordingSelectors);
  if (initialCheck) return initialCheck;
  
  // If not found, try scrolling up a few times
  logger.info('Play button not found initially. Scrolling up...');
  const MAX_SCROLL_UP = 7; 
  
  for (let i = 0; i < MAX_SCROLL_UP; i++) {
    logger.info(`Scroll attempt ${i + 1}/${MAX_SCROLL_UP}`);
    await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
    await page.waitForTimeout(2000); 
    
    const article = await checkArticlesForPlayButton(page, playRecordingSelectors);
    if (article) return article;
  }
  
  // Fallback: Check the entire page if article-specific search failed
  logger.info('Article-specific search failed. Checking the entire page for Play button...');
  for (const selector of playRecordingSelectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1000 })) {
        logger.info(`Found Play button with general page search using selector: ${selector}`);
        // Attempt to find the closest article ancestor
        try {
            const article = button.locator('xpath=ancestor::article[data-testid="tweet"]').first();
            if (await article.isVisible({timeout: 500})) {
                logger.info('Found ancestor article for the button.');
                return article;
            } else {
                logger.warn('Found button on page, but could not locate ancestor article. Returning the button itself.');
                return button; // Return the button if article can't be found
            }
        } catch (e) {
             logger.warn('Error finding ancestor article, returning button itself');
             return button;
        }
    }
  }
  
  return null;
}

async function checkArticlesForPlayButton(page: Page, selectors: string[]): Promise<any | null> {
  const tweetArticles = await page.locator('article[data-testid="tweet"]').all();
  logger.debug(`Found ${tweetArticles.length} articles with data-testid='tweet'`);
  
  for (let i = 0; i < tweetArticles.length; i++) {
    const article = tweetArticles[i];
    const articleVisible = await article.isVisible().catch(() => false);
    logger.debug(`Checking article ${i + 1}. Visible: ${articleVisible}`);
    if (!articleVisible) continue;
    
    // Take screenshot of each checked article for debugging
    // const articleScreenshotPath = path.join(process.cwd(), 'debug-screenshots', `checked-article-${i + 1}.png`);
    // await article.screenshot({ path: articleScreenshotPath }).catch(err => logger.warn(`Failed to screenshot article ${i+1}: ${err}`));

    for (const selector of selectors) {
      const button = article.locator(selector).first();
      const buttonVisible = await button.isVisible({ timeout: 500 });
      if (buttonVisible) {
        logger.info(`Found Play Recording button in article ${i + 1} using selector: ${selector}`);
        return article; // Return the article locator
      }
    }
  }
  
  logger.debug('Finished checking articles, no Play button found in them.');
  return null;
}

// Helper function to extract title before clicking play
async function extractTitleBeforePlay(articleLocator: any): Promise<string | null> {
  const titleSelectors = [
    'div[data-testid="card.layoutLarge.title"] span',
    'div[data-testid*="AudioSpaceCardHeader"] span[aria-hidden="true"]',
    'div > span[dir="auto"]:not([aria-hidden="true"])',
    'span[data-testid="card.layoutSmall.media.title"]'
  ];
  
  for (const selector of titleSelectors) {
    logger.debug(`Trying title selector: ${selector}`);
    const titleElement = articleLocator.locator(selector).first();
    
    if (await titleElement.isVisible({ timeout: 500 })) {
      const potentialTitle = await titleElement.textContent({ timeout: 1000 });
      if (potentialTitle && potentialTitle.trim().length > 0) {
        return potentialTitle.trim().substring(0, 100);
      }
    }
  }
  
  return null;
}

// Helper function to extract title from modal after clicking play
async function extractTitleFromModal(page: Page): Promise<string | null> {
    logger.info('[🐦 Helper Title] Attempting to extract Space title from modal...');
    const screenshotDir = path.join(process.cwd(), 'debug-screenshots');
    
    try {
        // Wait for *some* indicator of the player/modal content
        logger.info('[🐦 Helper Title] Waiting up to 10s for modal/player indicators to appear...');
        const modalIndicatorSelector = 
            'div[data-testid*="audioPlayer"], ' +
            'div[aria-label*="Audio"], ' +
            'div[data-testid*="audioSpaceDetailView"], ' +
            'div:has-text("tuned in"), ' +
            'div:has-text("Speakers")';
        await page.waitForSelector(modalIndicatorSelector, { state: 'visible', timeout: 10000 });
        logger.info('[🐦 Helper Title] Modal/player indicators are visible.');
        await page.waitForTimeout(1000); // Stability wait

        // Locate the specific player/modal container
        let container: any | null = null; 
        const potentialContainerSelectors = [
            'div[data-testid="SpaceDockExpanded"]',
            'div[data-testid="audioSpaceDetailView"]',
            'div[data-testid*="audioPlayer"]', 
            'div[aria-label*="Audio banner"]',
            'div[role="dialog"]', // Keep dialog as fallback
        ];
        
        for(const selector of potentialContainerSelectors) {
            logger.debug(`[🐦 Helper Title] Trying container selector: ${selector}`);
            const element = page.locator(selector).first();
            if (await element.isVisible({ timeout: 500 })) {
                const textContent = await element.textContent({ timeout: 500 }) || '';
                if (textContent.includes('tuned in') || textContent.includes('Speaker') || textContent.includes('Listener') || textContent.includes('MEMECOIN') /* Add known title part */) {
                    logger.info(`[🐦 Helper Title] Found specific Space container using selector: ${selector}`);
                    container = element;
                    // Log container HTML for debugging
                    try {
                        const containerHtml = await container.innerHTML();
                        logger.debug(`[🐦 Helper Title] Container HTML (first 500 chars): ${containerHtml.substring(0, 500)}`);
                    } catch (e) {logger.warn('Could not get container HTML');}
                    break;
                } else {
                    logger.debug(`[🐦 Helper Title] Container found with ${selector}, but missing confirmation text.`);
                }
            }
        }

        if (!container) {
            logger.error('[🐦 Helper Title] Could not locate a reliable modal/player container.');
            await page.screenshot({ path: path.join(screenshotDir, 'modal-container-not-found.png') });
            return null; 
        }

        logger.info('[🐦 Helper Title] Located container, taking screenshot...');
        await container.screenshot({ path: path.join(screenshotDir, 'modal-container-found.png') });

        // --- Search for Title WITHIN the container --- 
        // FOCUS ONLY on the data-testid strategy for now

        logger.info('[🐦 Helper Title] FOCUS STRATEGY: Checking data-testid=tweetText span within container...');
        try {
            // Increase timeout specifically for this selector
            const tweetTextSpan = container.locator('div[data-testid="tweetText"] span').first();
            if (await tweetTextSpan.isVisible({ timeout: 2000 })) { // Increased timeout
                const text = await tweetTextSpan.textContent();
                const trimmedText = text?.trim();
                if (trimmedText && trimmedText.length > 3 && trimmedText.includes('MEMECOIN COMMUNITY')) { 
                    logger.info(`[🐦 Helper Title] SUCCESS: Found title via tweetText span: "${trimmedText}"`);
                    return trimmedText;
                } else {
                    logger.warn(`[🐦 Helper Title] tweetText span visible, but text content mismatch or too short: "${trimmedText}"`);
                }
            } else {
                logger.warn('[🐦 Helper Title] tweetText span was not visible within the container.');
            }
        } catch (e) { 
             logger.error('[🐦 Helper Title] Error checking tweetText span:', e);
        }

        // REMOVED other strategies for now to isolate the main issue
        // ... (Strategy 1, 2, 3, 4 removed) ...

        logger.warn('[🐦 Helper Title] Could not extract Space title using the focused data-testid strategy.');
        return null;
    } catch (error) {
        logger.error('[🐦 Helper Title] Error during title extraction process:', error);
        await page.screenshot({ path: path.join(screenshotDir, 'modal-title-extraction-error.png') }).catch(()=>{});
        return null;
    }
}

// Run the test
testSpaceExtraction().catch(error => {
  logger.error('Unhandled error in main test function:', error);
  process.exit(1);
}); 