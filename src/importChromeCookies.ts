import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Script to manually import cookies from Chrome DevTools
 *
 * INSTRUCTIONS:
 * 1. Open Chrome and log in to Twitter
 * 2. Press F12 to open DevTools
 * 3. Go to the "Application" tab
 * 4. In the left sidebar, expand "Cookies" and click on "https://twitter.com" or "https://x.com"
 * 5. In the DevTools console (Console tab), paste this code and press Enter:
 *
 *    copy(JSON.stringify(document.cookie.split('; ').map(c => {
 *      const [name, ...v] = c.split('=');
 *      return {
 *        name,
 *        value: v.join('='),
 *        domain: '.twitter.com',
 *        path: '/',
 *        expires: -1,
 *        httpOnly: false,
 *        secure: true,
 *        sameSite: 'Lax'
 *      };
 *    })))
 *
 * 6. The cookies JSON is now copied to your clipboard
 * 7. Run this script and paste the JSON when prompted
 */

async function importChromeCookies() {
    console.log('=== Import Cookies from Chrome ===\n');
    console.log('STEP 1: Open Chrome and log in to Twitter/X');
    console.log('STEP 2: Press F12 to open Chrome DevTools');
    console.log('STEP 3: Go to the "Console" tab');
    console.log('STEP 4: Paste this code in the console and press Enter:\n');
    console.log('─────────────────────────────────────────────────────');
    console.log(`copy(JSON.stringify(document.cookie.split('; ').map(c => {
  const [name, ...v] = c.split('=');
  return {
    name,
    value: v.join('='),
    domain: '.twitter.com',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax'
  };
})))`);
    console.log('─────────────────────────────────────────────────────');
    console.log('\nSTEP 5: The cookies JSON is now copied to your clipboard');
    console.log('STEP 6: Paste the JSON below and press Enter:\n');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const cookiesJson = await new Promise<string>((resolve) => {
        let input = '';
        console.log('Paste your cookies JSON here (press Ctrl+D or Ctrl+Z when done):');

        rl.on('line', (line) => {
            input += line;
        });

        rl.on('close', () => {
            resolve(input);
        });
    });

    try {
        // Parse the JSON
        const cookies = JSON.parse(cookiesJson);

        if (!Array.isArray(cookies)) {
            throw new Error('Expected an array of cookies');
        }

        console.log(`\n✅ Successfully parsed ${cookies.length} cookies`);

        // Create directories
        const cookieDir = path.join(process.cwd(), 'cookies');
        const browserStateDir = path.join(process.cwd(), 'browser-state');

        if (!fs.existsSync(cookieDir)) {
            fs.mkdirSync(cookieDir, { recursive: true });
        }
        if (!fs.existsSync(browserStateDir)) {
            fs.mkdirSync(browserStateDir, { recursive: true });
        }

        // Save cookies in both formats
        const cookiePath = path.join(cookieDir, 'twitter-cookies.json');
        const storagePath = path.join(browserStateDir, 'twitter-storage-state.json');

        // Save raw cookies
        fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
        console.log(`✅ Saved cookies to: ${cookiePath}`);

        // Create Playwright storage state format
        const storageState = {
            cookies: cookies,
            origins: [
                {
                    origin: 'https://twitter.com',
                    localStorage: []
                },
                {
                    origin: 'https://x.com',
                    localStorage: []
                }
            ]
        };

        fs.writeFileSync(storagePath, JSON.stringify(storageState, null, 2));
        console.log(`✅ Saved storage state to: ${storagePath}`);

        console.log('\n✅ Cookie import complete!');
        console.log('You can now run the daemon with:');
        console.log('  SKIP_INITIAL_MENTIONS=true npx ts-node src/mentionDaemon.ts');

    } catch (error) {
        console.error('\n❌ Error parsing cookies:', error);
        console.error('Make sure you pasted valid JSON from the Chrome console');
        process.exit(1);
    }
}

importChromeCookies().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
