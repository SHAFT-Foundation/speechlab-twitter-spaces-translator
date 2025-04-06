import logger from './utils/logger';
import { findSpaceTweetFromProfile } from './services/twitterInteractionService';
import * as path from 'path';
import * as fs from 'fs';

// Host username to search for
const HOST_USERNAME = "shaftfinance";

/**
 * Test finding tweets with embedded Spaces on a user's profile
 * @param username Twitter username to search
 * @param spaceId Optional specific Space ID to look for, or "any" for any Space
 */
async function testProfileSearch(username: string, spaceId: string = "any"): Promise<void> {
    logger.info(`[🧪 Test] Testing profile search for tweets with embedded Spaces for @${username}`);
    logger.info(`[🧪 Test] Looking for Space ID: ${spaceId === "any" ? "any Space" : spaceId}`);
    
    try {
        const tweetId = await findSpaceTweetFromProfile(username, spaceId);
        
        if (tweetId) {
            logger.info(`[🧪 Test] ✅ Found tweet ${tweetId} embedding a Space on @${username}'s profile`);
            
            // Create a clickable URL for the tweet
            const tweetUrl = `https://twitter.com/i/status/${tweetId}`;
            logger.info(`[🧪 Test] Tweet URL: ${tweetUrl}`);
        } else {
            logger.error(`[🧪 Test] ❌ No tweets embedding Spaces found on @${username}'s profile`);
        }
    } catch (error) {
        logger.error(`[🧪 Test] ❌ Error during profile search test:`, error);
    }
}

/**
 * Test finding tweets for a specific Space ID from the leaderboard data
 */
async function testWithLeaderboardSpace(): Promise<void> {
    try {
        const leaderboardPath = path.join(process.cwd(), 'leaderboard_data_playwright.json');
        logger.info(`[🧪 Test] Reading leaderboard data from: ${leaderboardPath}`);
        
        if (!fs.existsSync(leaderboardPath)) {
            logger.error(`[🧪 Test] ❌ Leaderboard data file not found: ${leaderboardPath}`);
            return;
        }
        
        const leaderboardData = JSON.parse(fs.readFileSync(leaderboardPath, 'utf8'));
        
        // Find an entry with a direct Space URL and host handle
        let testEntry = null;
        for (const entry of leaderboardData) {
            if (entry.direct_play_url && entry.host_handle) {
                testEntry = entry;
                break;
            }
        }
        
        if (!testEntry) {
            logger.error(`[🧪 Test] ❌ No suitable entry found in leaderboard data`);
            return;
        }
        
        const spaceUrl = testEntry.direct_play_url;
        const hostHandle = testEntry.host_handle.replace('@', '');
        
        logger.info(`[🧪 Test] Testing with Space: "${testEntry.space_title}" by @${hostHandle}`);
        logger.info(`[🧪 Test] Space URL: ${spaceUrl}`);
        
        // Extract the Space ID from the URL
        const spaceIdMatch = spaceUrl.match(/\/spaces\/([a-zA-Z0-9]+)/);
        if (!spaceIdMatch || !spaceIdMatch[1]) {
            logger.error(`[🧪 Test] ❌ Could not extract Space ID from URL: ${spaceUrl}`);
            return;
        }
        
        const spaceId = spaceIdMatch[1];
        logger.info(`[🧪 Test] Extracted Space ID: ${spaceId}`);
        
        // Search for tweets embedding this Space on the host's profile
        await testProfileSearch(hostHandle, spaceId);
    } catch (error) {
        logger.error(`[🧪 Test] ❌ Error during leaderboard test:`, error);
    }
}

/**
 * Main function to run the test
 */
async function main() {
    logger.info(`[🧪 Test] Starting profile search test...`);
    
    // Check for command line arguments
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        // If a specific username is provided, use it
        const username = args[0];
        // If a specific Space ID is provided, use it
        const spaceId = args.length > 1 ? args[1] : "any";
        
        await testProfileSearch(username, spaceId);
    } else if (args.length === 0) {
        // Test with a Space from the leaderboard
        await testWithLeaderboardSpace();
    }
    
    logger.info(`[🧪 Test] Profile search test completed`);
}

// Run the main function
main().catch(error => {
    logger.error(`[🧪 Test] Unhandled error:`, error);
}); 