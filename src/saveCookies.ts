import { chromium } from 'playwright';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Simple script to save Twitter cookies after manual login
 */
async function saveTwitterCookies() {
  console.log('=== Twitter Cookie Saver ===');
  console.log('This script will help you save Twitter cookies after you manually log in');
  
  const cookieDir = path.join(process.cwd(), 'cookies');
  await fs.mkdir(cookieDir, { recursive: true });
  const cookiePath = path.join(cookieDir, 'twitter-cookies.json');
  
  console.log(`Cookies will be saved to: ${cookiePath}`);
  console.log('\nLaunching browser...');
  
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100
  });
  
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('Opening Twitter...');
  await page.goto('https://twitter.com/');
  
  console.log('\n=================================================');
  console.log('INSTRUCTIONS:');
  console.log('1. Click "Log in" if you see the login button');
  console.log('2. Complete the login process manually');
  console.log('3. Make sure you can see your Twitter feed');
  console.log('4. Once logged in, press ENTER in this terminal');
  console.log('=================================================\n');
  
  console.log('Press ENTER after you have successfully logged in...');
  await new Promise(r => process.stdin.once('data', r));
  
  console.log('\nVerifying login status...');
  
  // Navigate to home to ensure we're logged in
  await page.goto('https://twitter.com/home');
  
  // Check login indicators
  const loginIndicators = [
    '[data-testid="AppTabBar_Home_Link"]',
    'a[href="/home"]',
    '[data-testid="SideNav_NewTweet_Button"]'
  ];
  
  let isLoggedIn = false;
  for (const selector of loginIndicators) {
    if (await page.locator(selector).isVisible().catch(() => false)) {
      console.log(`✅ Login verified! (detected: ${selector})`);
      isLoggedIn = true;
      break;
    }
  }
  
  if (!isLoggedIn) {
    console.log('⚠️ Could not verify login. Please ensure you are logged in to Twitter.');
    await page.screenshot({ path: path.join(cookieDir, 'login-state.png') });
    console.log(`Screenshot saved to ${path.join(cookieDir, 'login-state.png')}`);
    console.log('Do you want to continue anyway? (y/n)');
    
    const response = await new Promise<string>(r => {
      process.stdin.once('data', data => r(data.toString().trim().toLowerCase()));
    });
    
    if (response !== 'y') {
      console.log('Aborting. Please try again and ensure you are logged in.');
      await browser.close();
      return;
    }
  }
  
  // Extract cookies
  console.log('\nExtracting cookies...');
  const cookies = await context.cookies();
  
  // Save to file
  await fs.writeFile(cookiePath, JSON.stringify(cookies, null, 2));
  console.log(`✅ Cookies saved to: ${cookiePath}`);
  
  // Save a full storage state (including local storage)
  const storageStatePath = path.join(cookieDir, 'twitter-storage-state.json');
  await context.storageState({ path: storageStatePath });
  console.log(`✅ Full storage state saved to: ${storageStatePath}`);
  
  console.log('\nNext steps:');
  console.log('1. You can now run the daemon with these saved cookies');
  console.log('2. The daemon should automatically use them to stay logged in');
  
  await browser.close();
  console.log('\nDone! Browser closed.');
}

// Run the script
saveTwitterCookies().catch(err => {
  console.error('Error:', err);
  process.exit(1);
}); 