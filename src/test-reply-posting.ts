import logger from './utils/logger';
import { config } from './utils/config';
import { findTweetEmbeddingSpace, postReplyToTweet, findSpaceTweetFromProfile } from './services/twitterInteractionService';
import fs from 'fs';
import path from 'path';

// Using the existing sharing link provided
const EXISTING_SHARING_LINK = "https://translate.speechlab.ai/projects/67f2ce9c2ee951002667cd7b?usp=sharing&token=6231cab4aa64180661d63c6a8a3fc9d730088a3e82840942b1ce01c7ba7991f28f9c0d5a45278fa746042425a7c869918daf86c688dbb17820370eb51fb24144&uid=64c02c788cc17800260aaa14&rid=63c7303736135300262305cc";

// Twitter host username to search for tweets
const HOST_USERNAME = "shaftfinance";

// Known Space tweet from the host (directly embedding a Space)
const KNOWN_SPACE_TWEET_URL = "https://x.com/shaftfinance/status/1902388551771152713";

/**
 * Tests just the tweet finding and reply posting functionality
 * @param spaceUrl The URL of the Twitter Space
 */
async function testReplyPosting(spaceUrl: string): Promise<void> {
    logger.info(`[🧪 Test] Starting reply posting test for Space URL: ${spaceUrl}`);
    
    try {
        // Extract the Space ID from the URL
        const spaceIdMatch = spaceUrl.match(/\/spaces\/([a-zA-Z0-9]+)/);
        if (!spaceIdMatch || !spaceIdMatch[1]) {
            logger.error(`[🧪 Test] Could not extract Space ID from URL: ${spaceUrl}`);
            return;
        }
        
        const spaceId = spaceIdMatch[1];
        logger.info(`[🧪 Test] Extracted Space ID: ${spaceId}`);
        
        // Try two approaches to find a tweet to reply to
        
        // Approach 1: Look for tweets on the host's profile that reference this Space
        logger.info(`[🧪 Test] Approach 1: Looking for tweets on @${HOST_USERNAME}'s profile that reference Space ${spaceId}...`);
        let tweetId = await findSpaceTweetFromProfile(HOST_USERNAME, spaceId);
        
        // Approach 2: If no tweet found on profile, try to find any tweet embedding the Space
        if (!tweetId) {
            logger.info(`[🧪 Test] Approach 2: No matching tweet found on host profile. Looking for any tweet embedding the Space...`);
            tweetId = await findTweetEmbeddingSpace(spaceUrl);
        }
        
        if (!tweetId) {
            logger.error(`[🧪 Test] Could not find any tweet referencing the Space.`);
            return;
        }
        
        const tweetUrl = `https://twitter.com/i/status/${tweetId}`;
        logger.info(`[🧪 Test] Found tweet URL: ${tweetUrl}`);
        
        // Step 2: Post a reply to the tweet with the sharing link
        logger.info(`[🧪 Test] Posting reply to tweet...`);
        
        // Generate the comment text including the host username
        const commentText = `Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this @${HOST_USERNAME} space in Latin Spanish! Contact for more languages! ${EXISTING_SHARING_LINK}`;
        
        const postSuccess = await postReplyToTweet(tweetUrl, commentText);
        
        if (postSuccess) {
            logger.info(`[🧪 Test] ✅ Successfully posted reply to tweet: ${tweetUrl}`);
        } else {
            logger.error(`[🧪 Test] ❌ Failed to post reply to tweet.`);
        }
        
    } catch (error) {
        logger.error(`[🧪 Test] ❌ Error during test:`, error);
    }
}

/**
 * Directly test a specific tweet URL for reply posting
 * @param tweetUrl The URL of the tweet to reply to
 */
async function testDirectReply(tweetUrl: string): Promise<void> {
    logger.info(`[🧪 Test] Starting direct reply test for tweet URL: ${tweetUrl}`);
    
    try {
        // Generate the comment text with the host username
        const commentText = `Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this @${HOST_USERNAME} space in Latin Spanish! Contact for more languages! ${EXISTING_SHARING_LINK}`;
        
        const postSuccess = await postReplyToTweet(tweetUrl, commentText);
        
        if (postSuccess) {
            logger.info(`[🧪 Test] ✅ Successfully posted direct reply to tweet: ${tweetUrl}`);
        } else {
            logger.error(`[🧪 Test] ❌ Failed to post direct reply to tweet.`);
        }
    } catch (error) {
        logger.error(`[🧪 Test] ❌ Error during direct reply test:`, error);
    }
}

/**
 * Tests finding tweets on a host profile that link to Spaces
 * @param username The Twitter username to search (without @)
 */
async function testProfileSearch(username: string): Promise<void> {
    logger.info(`[🧪 Test] Testing profile search for @${username}`);
    
    try {
        // First find a Space URL from the leaderboard data
        const spaceUrl = getTestSpaceUrl();
        
        if (!spaceUrl) {
            logger.error(`[🧪 Test] No Space URL found to test with.`);
            return;
        }
        
        // Extract Space ID
        const spaceIdMatch = spaceUrl.match(/\/spaces\/([a-zA-Z0-9]+)/);
        if (!spaceIdMatch || !spaceIdMatch[1]) {
            logger.error(`[🧪 Test] Could not extract Space ID from URL: ${spaceUrl}`);
            return;
        }
        
        const spaceId = spaceIdMatch[1];
        logger.info(`[🧪 Test] Looking for tweets on @${username}'s profile related to any Space...`);
        
        // Search for any Space tweet on the profile (not necessarily matching our Space ID)
        const tweetId = await findSpaceTweetFromProfile(username, "any");
        
        if (tweetId) {
            logger.info(`[🧪 Test] ✅ Found tweet ${tweetId} on @${username}'s profile mentioning a Space`);
            
            // Try to post a reply to this tweet
            const tweetUrl = `https://twitter.com/i/status/${tweetId}`;
            logger.info(`[🧪 Test] Attempting to reply to tweet ${tweetUrl}`);
            
            const commentText = `Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this @${username} space in Latin Spanish! Contact for more languages! ${EXISTING_SHARING_LINK}`;
            
            const postSuccess = await postReplyToTweet(tweetUrl, commentText);
            
            if (postSuccess) {
                logger.info(`[🧪 Test] ✅ Successfully posted reply to tweet from profile search`);
            } else {
                logger.error(`[🧪 Test] ❌ Failed to post reply to tweet from profile search`);
            }
        } else {
            logger.error(`[🧪 Test] ❌ No Space-related tweets found on @${username}'s profile`);
        }
    } catch (error) {
        logger.error(`[🧪 Test] ❌ Error during profile search test:`, error);
    }
}

/**
 * Directly test posting to a known Space tweet
 */
async function testKnownSpaceTweet(): Promise<void> {
    logger.info(`[🧪 Test] Testing direct reply to known Space tweet: ${KNOWN_SPACE_TWEET_URL}`);
    
    try {
        // Generate the comment text with a timestamp to make it unique
        const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const commentText = `Speechlab Twitter Space Agent 🎤 #AIForCrypto sponsored by @shaftfinance $SHAFT has dubbed this space! [${timestamp}] ${EXISTING_SHARING_LINK}`;
        
        // Add more hashtags for visibility
        const enhancedCommentText = `${commentText} #AI #SpaceDubs #CryptoSpaces #Dubbing`;
        
        logger.info(`[🧪 Test] Attempting to post comment: ${enhancedCommentText}`);
        const postSuccess = await postReplyToTweet(KNOWN_SPACE_TWEET_URL, enhancedCommentText);
        
        if (postSuccess) {
            logger.info(`[🧪 Test] ✅ Successfully posted reply to known Space tweet`);
        } else {
            logger.error(`[🧪 Test] ❌ Failed to post reply to known Space tweet`);
        }
    } catch (error) {
        logger.error(`[🧪 Test] ❌ Error during known tweet test:`, error);
    }
}

/**
 * Gets a Twitter Space URL from the leaderboard data
 */
function getTestSpaceUrl(): string | null {
    try {
        // Read the leaderboard data from the JSON file
        const leaderboardPath = path.join(process.cwd(), 'leaderboard_data_playwright.json');
        logger.info(`[🧪 Test] Reading leaderboard data from: ${leaderboardPath}`);
        
        const leaderboardData = JSON.parse(fs.readFileSync(leaderboardPath, 'utf8'));
        
        // Find an entry with a direct Space URL
        for (const entry of leaderboardData) {
            if (entry.direct_play_url) {
                logger.info(`[🧪 Test] Found test Space: "${entry.space_title}" by @${entry.host_handle}`);
                return entry.direct_play_url;
            }
        }
        
        logger.error(`[🧪 Test] No valid Space URL found in leaderboard data.`);
        return null;
    } catch (error) {
        logger.error(`[🧪 Test] Error getting test Space URL:`, error);
        return null;
    }
}

/**
 * Main function to run the test
 */
async function main() {
    logger.info(`[🧪 Test] Starting reply posting test...`);
    
    // Check for command line arguments
    const args = process.argv.slice(2);
    
    // Check for known Space tweet test
    if (args.length > 0 && args[0] === 'known-tweet') {
        await testKnownSpaceTweet();
        return;
    }
    
    // Check for profile search test
    if (args.length > 0 && args[0] === 'profile') {
        const username = args[1] || HOST_USERNAME;
        await testProfileSearch(username);
        return;
    }
    
    // If a space URL is provided directly, use it
    if (args.length > 0 && args[0].includes('spaces')) {
        logger.info(`[🧪 Test] Using Space URL from command line: ${args[0]}`);
        await testReplyPosting(args[0]);
        return;
    }
    
    // If a tweet URL is provided directly, test posting to it
    if (args.length > 0 && args[0].includes('status')) {
        logger.info(`[🧪 Test] Using Tweet URL from command line: ${args[0]}`);
        await testDirectReply(args[0]);
        return;
    }
    
    // Otherwise get a test Space URL from the leaderboard data
    const testSpaceUrl = getTestSpaceUrl();
    
    if (!testSpaceUrl) {
        logger.error(`[🧪 Test] No test Space URL available. Exiting.`);
        return;
    }
    
    // Run the test with the Space URL
    await testReplyPosting(testSpaceUrl);
}

// Run the main function
main().catch(error => {
    logger.error(`[🧪 Test] Unhandled error:`, error);
}); 