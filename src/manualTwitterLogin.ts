import { chromium, Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import { config } from './utils/config';

/**
 * Manual Twitter login script to be run once to establish cookies
 * After successful manual login, the browser state is saved so it can be reused
 */
async function manualTwitterLogin() {
    console.log('=== Twitter Manual Login Helper ===');
    console.log('This script will help you log in to Twitter manually and save the browser state');
    console.log('After successful login, the state will be saved for future daemon runs');
    
    // Create directories for saving browser state
    const stateDir = path.join(process.cwd(), 'browser-state');
    await fs.mkdir(stateDir, { recursive: true });
    
    const screenDir = path.join(process.cwd(), 'debug-screenshots', 'manual-login');
    await fs.mkdir(screenDir, { recursive: true });
    
    console.log(`Browser state will be saved to: ${stateDir}`);
    console.log(`Screenshots will be saved to: ${screenDir}`);
    
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    
    try {
        // Launch browser with slow motion for easier interaction
        console.log('\nLaunching browser for manual login...');
        browser = await chromium.launch({
            headless: false, // Always non-headless for manual login
            slowMo: 100,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        // Create a persistent context to save cookies and storage
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            permissions: ['geolocation'],
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        
        const page = await context.newPage();

        // Hide webdriver property to avoid detection
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Mock chrome object
            (window as any).chrome = {
                runtime: {},
            };

            // Mock plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });

            // Mock languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        });

        // Navigate to Twitter login page
        console.log('Opening Twitter...');
        try {
            await page.goto('https://twitter.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000); // Wait for page to settle
            await page.screenshot({ path: path.join(screenDir, '01-twitter-landing.png') });
        } catch (err) {
            console.log('Failed to load twitter.com, trying x.com...');
            await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);
            await page.screenshot({ path: path.join(screenDir, '01-x-landing.png') });
        }
        
        console.log('\n===================================================');
        console.log('IMPORTANT INSTRUCTIONS:');
        console.log('1. Please manually complete the login process in the browser');
        console.log('2. After you successfully log in, you will see the Twitter home feed');
        console.log('3. Once you see your Twitter home feed, press any key in this terminal to continue');
        console.log('   (DO NOT close the browser window)');
        console.log('===================================================\n');
        
        // Wait for user to press any key after completing login
        console.log('Press any key after you have successfully logged in...');
        await waitForKeyPress();
        
        // Verify login was successful
        console.log('\nVerifying login status...');
        await page.screenshot({ path: path.join(screenDir, '02-after-manual-login.png') });
        
        try {
            await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 30000 });
            await page.screenshot({ path: path.join(screenDir, '03-home-page.png') });
            
            // Check for login success indicators
            const successIndicators = [
                '[data-testid="AppTabBar_Home_Link"]',
                'a[href="/home"]',
                '[data-testid="SideNav_NewTweet_Button"]',
                '[data-testid="primaryColumn"]'
            ];
            
            let isLoggedIn = false;
            for (const selector of successIndicators) {
                if (await page.locator(selector).isVisible({ timeout: 3000 }).catch(() => false)) {
                    console.log(`✅ Login verified successfully! Found indicator: ${selector}`);
                    isLoggedIn = true;
                    break;
                }
            }
            
            if (!isLoggedIn) {
                console.log('⚠️ Could not verify login - home page elements not found.');
                console.log('Please ensure you are fully logged in before continuing.');
                
                console.log('\nPress any key to attempt to save state anyway...');
                await waitForKeyPress();
            }
            
            // Save the browser state
            console.log('\nSaving browser state...');
            await context.storageState({ path: path.join(stateDir, 'twitter-storage-state.json') });
            console.log('✅ Browser state saved successfully!');
            
            console.log('\nYou can now run the daemon with this saved state.');
            console.log('Browser will close in 5 seconds...');
            await new Promise(r => setTimeout(r, 5000));
            
        } catch (verifyError) {
            console.error('❌ Error verifying login:', verifyError);
        }
        
    } catch (error) {
        console.error('❌ Error during manual login process:', error);
    } finally {
        // Cleanup
        if (context) await context.close().catch(e => console.warn('Error closing context:', e));
        if (browser) await browser.close().catch(e => console.warn('Error closing browser:', e));
        console.log('Browser closed. Process complete.');
    }
}

// Helper function to wait for a key press
function waitForKeyPress(): Promise<void> {
    return new Promise(resolve => {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
            process.stdin.setRawMode(true);
            process.stdin.once('data', () => {
                if (process.stdin.setRawMode) {
                    process.stdin.setRawMode(false);
                }
                resolve();
            });
        } else {
            // Fallback for non-TTY environments
            process.stdin.once('data', () => {
                resolve();
            });
        }
    });
}

// Run the script
manualTwitterLogin().catch(error => {
    console.error('Unhandled error in manual login script:', error);
    process.exit(1);
}); 