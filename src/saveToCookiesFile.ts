import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './utils/config'; // Import config

/**
 * Very simple script to manually save Twitter cookies after logging in
 */
async function simpleSaveCookies() {
  console.log('=== Twitter Cookie Saver (Simple Version) ===');
  console.log('This script will help you save Twitter cookies after you manually log in');
  
  // Create cookies directory if it doesn't exist
  const cookieDir = path.join(process.cwd(), 'cookies');
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }
  
  const cookiePath = path.join(cookieDir, 'twitter-cookies.json');
  const storagePath = path.join(cookieDir, 'twitter-storage-state.json');
  
  console.log(`Cookies will be saved to: ${cookiePath}`);
  console.log(`Storage state will be saved to: ${storagePath}`);
  console.log('\nLaunching browser...');
  
  const browser = await chromium.launch({
    headless: config.BROWSER_HEADLESS ?? false // Use config setting
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('Opening Twitter...');
  await page.goto('https://twitter.com/');
  
  console.log('\n=================================================');
  console.log('INSTRUCTIONS:');
  console.log('1. In the browser window, log in to Twitter manually');
  console.log('2. Make sure you can see your Twitter feed');
  console.log('3. THEN press ENTER in this terminal window');
  console.log('=================================================\n');
  
  console.log('Press ENTER after you have successfully logged in...');
  await new Promise(r => process.stdin.once('data', r));
  
  // Check if logged in by navigating to home
  try {
    console.log('Checking if login was successful...');
    await page.goto('https://twitter.com/home');
    
    // Save a screenshot of current state
    await page.screenshot({ path: path.join(cookieDir, 'twitter-login-check.png') });
    console.log(`Saved screenshot to ${path.join(cookieDir, 'twitter-login-check.png')}`);
    
    // Extract and save cookies
    console.log('Extracting cookies...');
    const cookies = await context.cookies();
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    console.log(`✅ Saved ${cookies.length} cookies to: ${cookiePath}`);
    
    // Save storage state
    console.log('Saving browser storage state...');
    await context.storageState({ path: storagePath });
    console.log(`✅ Saved storage state to: ${storagePath}`);
    
    // Verify files were created
    if (fs.existsSync(cookiePath) && fs.existsSync(storagePath)) {
      console.log('✅ Cookie files successfully created!');
    } else {
      console.log('⚠️ Warning: Cookie files may not have been created correctly.');
    }
  } catch (error) {
    console.error('❌ Error while saving cookies:', error);
  } finally {
    // Always close the browser
    console.log('Closing browser...');
    await browser.close();
    console.log('Done!');
  }
}

// Run the script
simpleSaveCookies().catch(console.error); 