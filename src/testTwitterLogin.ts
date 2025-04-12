import { chromium, Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import logger from './utils/logger';
import { config } from './utils/config';

const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots', 'login-test');

/**
 * Test script for debugging Twitter login issues
 */
async function testTwitterLogin() {
    console.log('=== Twitter Login Test Script ===');
    console.log(`Log level: ${config.LOG_LEVEL}`);
    console.log(`Twitter username set: ${!!config.TWITTER_USERNAME}`);
    console.log(`Twitter password set: ${!!config.TWITTER_PASSWORD}`);
    
    // Create screenshot directory
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    console.log(`Created screenshot directory: ${SCREENSHOT_DIR}`);
    
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    
    try {
        // Initialize browser with very slow motion for debugging
        console.log('Launching browser in non-headless mode with slow motion...');
        browser = await chromium.launch({
            headless: false,
            slowMo: 500, // Very slow for debugging
        });
        
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
        });
        
        page = await context.newPage();
        
        // Very verbose debugging
        page.on('console', msg => console.log(`[Page Console] ${msg.text()}`));
        page.on('response', response => {
            const status = response.status();
            const url = response.url();
            if (status >= 400 || url.includes('login') || url.includes('auth')) {
                console.log(`[Network] ${response.request().method()} ${url} - ${status}`);
            }
        });
        
        // Navigate to login page
        console.log('Navigating to Twitter login page...');
        await page.goto('https://twitter.com/i/flow/login', { waitUntil: 'networkidle', timeout: 60000 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-login-page.png') });
        console.log(`Current URL: ${page.url()}`);
        console.log(`Current Title: ${await page.title()}`);
        
        await new Promise(r => setTimeout(r, 3000));
        
        // Username step
        console.log('Looking for username field...');
        let usernameField = await page.locator('input[autocomplete="username"], input[name="text"], input[data-testid="username_or_email"]').first();
        
        if (await usernameField.isVisible({ timeout: 5000 })) {
            console.log('✅ Username field found. Filling with username...');
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-username-field-found.png') });
            
            await usernameField.click();
            await usernameField.fill('');
            await usernameField.fill(config.TWITTER_USERNAME || 'MISSING_USERNAME');
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-username-filled.png') });
            
            console.log('Looking for Next button...');
            let nextButton = await page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').first();
            
            if (await nextButton.isVisible({ timeout: 5000 })) {
                console.log('✅ Next button found. Clicking...');
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-next-button-found.png') });
                await nextButton.click();
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-after-next-click.png') });
                
                // Wait for password field
                await new Promise(r => setTimeout(r, 3000));
                
                // Check for unusual login activity verification
                const unusualActivityText = await page.getByText('Enter your phone number or email address', { exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
                if (unusualActivityText) {
                    console.log('⚠️ Unusual login activity detected! Email verification required.');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05b-unusual-activity-verification.png') });
                    
                    // Look for the email/phone input field
                    console.log('Looking for email/phone verification field...');
                    const verificationInput = await page.locator('input[name="text"], input[type="text"]').first();
                    
                    if (await verificationInput.isVisible({ timeout: 3000 })) {
                        console.log('✅ Verification input field found. Filling with email...');
                        await verificationInput.click();
                        await verificationInput.fill('');
                        // Use the TWITTER_EMAIL if available, otherwise fallback to username
                        await verificationInput.fill(config.TWITTER_EMAIL || config.TWITTER_USERNAME || 'MISSING_EMAIL');
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05c-email-verification-filled.png') });
                        
                        // Look for the Next/Submit button
                        console.log('Looking for verification submit button...');
                        const submitButton = await page.locator('div[role="button"]:has-text("Next"), button:has-text("Next"), div[role="button"]:has-text("Submit"), button:has-text("Submit")').first();
                        
                        if (await submitButton.isVisible({ timeout: 3000 })) {
                            console.log('✅ Submit button found. Clicking...');
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05d-verification-submit-button.png') });
                            await submitButton.click();
                            await page.waitForTimeout(3000);
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05e-after-verification-submit.png') });
                        } else {
                            console.log('❌ Verification submit button not found.');
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-no-verification-submit.png') });
                        }
                    } else {
                        console.log('❌ Verification input field not found.');
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-no-verification-input.png') });
                    }
                }
                
                console.log('Looking for password field...');
                
                // Check if we got a verification step
                const verificationField = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
                
                if (await verificationField.isVisible({ timeout: 2000 }).catch(() => false)) {
                    console.log('⚠️ Verification step detected! Manual login required.');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '06-verification-required.png') });
                    console.log('Waiting 30 seconds for manual verification input...');
                    await new Promise(r => setTimeout(r, 30000));
                    console.log('Continuing after manual verification wait...');
                }
                
                // Try to find password field
                let passwordField = await page.locator('input[name="password"], input[type="password"]').first();
                
                if (await passwordField.isVisible({ timeout: 5000 })) {
                    console.log('✅ Password field found. Filling with password...');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '07-password-field-found.png') });
                    
                    await passwordField.click();
                    await passwordField.fill('');
                    await passwordField.fill(config.TWITTER_PASSWORD || 'MISSING_PASSWORD');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '08-password-filled.png') });
                    
                    console.log('Looking for Login button...');
                    let loginButton = await page.locator('[data-testid="LoginForm_Login_Button"], div[role="button"]:has-text("Log in"), button:has-text("Log in")').first();
                    
                    if (await loginButton.isVisible({ timeout: 5000 })) {
                        console.log('✅ Login button found. Clicking...');
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '09-login-button-found.png') });
                        await loginButton.click();
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10-after-login-click.png') });
                        
                        // Wait for login to complete
                        await new Promise(r => setTimeout(r, 5000));
                        
                        // Check for suspicious login message and "Got it" button
                        console.log('Checking for suspicious login message...');
                        const suspiciousLoginText = await page.getByText('suspicious login prevented', { exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
                        const gotItButton = await page.getByRole('button', { name: 'Got it', exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
                        
                        if (suspiciousLoginText || gotItButton) {
                            console.log('⚠️ Suspicious login prevented message detected!');
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10b-suspicious-login-message.png') });
                            
                            // Click the "Got it" button if visible
                            const gotItElement = page.getByRole('button', { name: 'Got it', exact: false });
                            if (await gotItElement.isVisible({ timeout: 3000 })) {
                                console.log('✅ "Got it" button found. Clicking...');
                                await gotItElement.click();
                                await page.waitForTimeout(3000);
                                await page.screenshot({ path: path.join(SCREENSHOT_DIR, '10c-after-got-it-click.png') });
                            } else {
                                console.log('❌ "Got it" button not visible despite suspicious login message.');
                            }
                        }
                        
                        // Check for login success
                        console.log('Checking if login was successful...');
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '11-checking-login-success.png') });
                        
                        const homeLink = await page.locator('[data-testid="AppTabBar_Home_Link"], a[href="/home"]').first();
                        if (await homeLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                            console.log('✅ Login successful! Home link detected.');
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12-login-successful.png') });
                            
                            // Try to navigate to home page
                            console.log('Navigating to home page...');
                            await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 30000 });
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '13-home-page.png') });
                            console.log(`Home page URL: ${page.url()}`);
                        } else {
                            console.log('❌ Login failed. Home link not detected.');
                            
                            // Check for error messages
                            const errorMessage = await page.locator('div[role="alert"]').first();
                            if (await errorMessage.isVisible({ timeout: 2000 }).catch(() => false)) {
                                const errorText = await errorMessage.textContent();
                                console.log(`Error message: ${errorText}`);
                            }
                            
                            // Try navigating to home to see what happens
                            console.log('Attempting to navigate to home page despite login failure...');
                            await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 30000 });
                            await page.screenshot({ path: path.join(SCREENSHOT_DIR, '14-home-after-failed-login.png') });
                            console.log(`Current URL after failed login: ${page.url()}`);
                        }
                    } else {
                        console.log('❌ Login button not found.');
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-no-login-button.png') });
                    }
                } else {
                    console.log('❌ Password field not found.');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-no-password-field.png') });
                }
            } else {
                console.log('❌ Next button not found.');
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-no-next-button.png') });
            }
        } else {
            console.log('❌ Username field not found.');
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-no-username-field.png') });
            
            // Log all input elements on page
            const inputs = await page.locator('input').all();
            console.log(`Found ${inputs.length} input elements on page:`);
            for (let i = 0; i < inputs.length; i++) {
                const type = await inputs[i].getAttribute('type') || 'unknown';
                const name = await inputs[i].getAttribute('name') || 'unknown';
                const id = await inputs[i].getAttribute('id') || 'unknown';
                console.log(`Input ${i+1}: type="${type}", name="${name}", id="${id}"`);
            }
        }
        
        // Keep browser open for 60 seconds to allow inspection
        console.log('Test complete. Keeping browser open for 60 seconds for manual inspection...');
        await new Promise(r => setTimeout(r, 60000));
        
    } catch (error) {
        console.error('Error during Twitter login test:', error);
        if (page) {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'error-exception.png') }).catch(() => {});
        }
    } finally {
        console.log('Cleaning up...');
        if (page && !page.isClosed()) await page.close().catch(e => console.warn('Error closing page:', e));
        if (context) await context.close().catch(e => console.warn('Error closing context:', e));
        if (browser) await browser.close().catch(e => console.warn('Error closing browser:', e));
        console.log('Cleanup complete.');
    }
}

// Run the test
testTwitterLogin().catch(error => {
    console.error('Unhandled error in test script:', error);
    process.exit(1);
}); 