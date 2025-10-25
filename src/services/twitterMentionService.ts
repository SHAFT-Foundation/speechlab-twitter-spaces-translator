import { TwitterApi, TweetV2, EUploadMimeType } from 'twitter-api-v2';
import { TwitterApiRateLimitPlugin } from '@twitter-api-v2/plugin-rate-limit';
import logger from '../utils/logger';
import { config } from '../utils/config';
import * as fs from 'fs';

/**
 * Service for polling Twitter mentions and posting replies using the Twitter API v2
 */

// Initialize rate limit plugin for automatic tracking
const rateLimitPlugin = new TwitterApiRateLimitPlugin();

// Initialize Twitter API client with rate limit plugin
const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
}, {
    plugins: [rateLimitPlugin]
});

const rwClient = twitterClient.readWrite;

// Export rate limit plugin for external access
export { rateLimitPlugin };

// Rate limiting state
let lastPollTime = 0;
const MIN_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes between polls (allows ~7 polls per 15min window)
let rateLimitResetTime: number | null = null; // Track rate limit reset time

// Retry configuration
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 60000; // 1 minute base delay
const MAX_RETRY_DELAY_MS = 900000; // 15 minutes max delay

// Cache for parent tweet video data (to avoid refetching same tweet multiple times)
const parentTweetVideoCache = new Map<string, { videoUrl: string | undefined; videoVariants: any[] | undefined; timestamp: number }>();
const CACHE_TTL_MS = 3600000; // 1 hour cache

/**
 * Sleep helper
 */
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function getExponentialBackoffDelay(attempt: number): number {
    const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    return Math.floor(delay + jitter);
}

/**
 * Interface for mention data
 */
export interface MentionData {
    tweetId: string;
    tweetUrl: string;
    username: string;
    parentUsername?: string;
    text: string;
    createdAt: Date;
    authorId: string;
    hasVideo?: boolean;
    videoUrl?: string;
    videoVariants?: Array<{url: string; bitrate?: number; content_type: string}>;
}

/**
 * Get current rate limit status for an endpoint
 * @param endpoint The endpoint to check (e.g., 'users/:id/mentions')
 * @returns Rate limit info or null if not available
 */
export async function getRateLimitStatus(endpoint: string) {
    try {
        const rateLimit = await rateLimitPlugin.v2.getRateLimit(endpoint);
        if (rateLimit) {
            logger.info(`[🐦 Rate Limit] Status for ${endpoint}:`);
            logger.info(`[🐦 Rate Limit]   - Limit: ${rateLimit.limit} requests per window`);
            logger.info(`[🐦 Rate Limit]   - Remaining: ${rateLimit.remaining}`);
            logger.info(`[🐦 Rate Limit]   - Reset: ${new Date(rateLimit.reset * 1000).toISOString()}`);

            const minutesUntilReset = Math.ceil((rateLimit.reset * 1000 - Date.now()) / 60000);
            logger.info(`[🐦 Rate Limit]   - Minutes until reset: ${minutesUntilReset}`);

            return rateLimit;
        }
        return null;
    } catch (error) {
        logger.error('[🐦 Rate Limit] Error getting rate limit status:', error);
        return null;
    }
}

/**
 * Test Twitter API connection and show verbose response
 * @returns True if connection successful (or if rate limited but credentials valid)
 */
export async function testTwitterApiConnection(): Promise<boolean> {
    try {
        logger.info('[🐦 API Test] ========================================');
        logger.info('[🐦 API Test] Testing Twitter API Connection...');
        logger.info('[🐦 API Test] ========================================');

        // Test 1: Get authenticated user info
        logger.info('[🐦 API Test] Test 1: Fetching authenticated user info...');
        logger.info('[🐦 API Call] 🔵 Calling Twitter API: GET /2/users/me');
        const startTime = Date.now();
        const me = await rwClient.v2.me();
        const elapsed = Date.now() - startTime;
        logger.info(`[🐦 API Call] ✅ Response received from /2/users/me (${elapsed}ms)`);

        logger.info('[🐦 API Test] ✅ Successfully authenticated!');
        logger.info('[🐦 API Test] Response time: ' + elapsed + 'ms');
        logger.info('[🐦 API Test] User Details:');
        logger.info('[🐦 API Test]   - Username: @' + me.data.username);
        logger.info('[🐦 API Test]   - User ID: ' + me.data.id);
        logger.info('[🐦 API Test]   - Name: ' + me.data.name);
        logger.info('[🐦 API Test] Full API Response: ' + JSON.stringify(me.data, null, 2));

        // Test 2: Try a simple mentions request to verify access
        logger.info('[🐦 API Test] Test 2: Testing mentions endpoint access...');
        logger.info(`[🐦 API Call] 🔵 Calling Twitter API: GET /2/users/${me.data.id}/mentions?max_results=5`);
        const testStart = Date.now();
        try {
            const testMentions = await rwClient.v2.userMentionTimeline(me.data.id, {
                max_results: 5,
                'tweet.fields': 'created_at'
            });
            const testElapsed = Date.now() - testStart;
            logger.info(`[🐦 API Call] ✅ Response received from /2/users/${me.data.id}/mentions (${testElapsed}ms)`);

            logger.info('[🐦 API Test] ✅ Mentions endpoint accessible!');
            logger.info('[🐦 API Test] Response time: ' + testElapsed + 'ms');
            logger.info('[🐦 API Test] Found ' + (testMentions.data.data?.length || 0) + ' recent mentions');

            // Check rate limit info from response
            // Reference: https://docs.x.com/x-api/fundamentals/rate-limits
            if (testMentions.rateLimit) {
                logger.info('[🐦 API Test] ========================================');
                logger.info('[🐦 API Test] 📊 HTTP Rate Limit Headers:');
                logger.info('[🐦 API Test] ========================================');
                logger.info('[🐦 API Test] x-rate-limit-limit: ' + testMentions.rateLimit.limit + ' (rate limit ceiling for endpoint)');
                logger.info('[🐦 API Test] x-rate-limit-remaining: ' + testMentions.rateLimit.remaining + ' (remaining requests for 15-min window)');
                logger.info('[🐦 API Test] x-rate-limit-reset: ' + testMentions.rateLimit.reset + ' (UTC epoch seconds)');

                const resetTime = new Date(testMentions.rateLimit.reset * 1000);
                const minutesUntilReset = Math.ceil((testMentions.rateLimit.reset * 1000 - Date.now()) / 60000);
                logger.info('[🐦 API Test] Reset time: ' + resetTime.toISOString() + ' (' + minutesUntilReset + ' minutes)');
                logger.info('[🐦 API Test] ========================================');
            }
        } catch (mentionError: any) {
            // If we hit rate limit (429), that's actually OK - it means credentials work
            if (mentionError.code === 429) {
                // CRITICAL: Check if this is a FALSE 429 error
                // Sometimes Twitter returns 429 even when remaining > 0
                const isFalse429 = mentionError.rateLimit && mentionError.rateLimit.remaining > 0;

                if (isFalse429) {
                    logger.warn('[🐦 API Test] ⚠️⚠️⚠️ FALSE RATE LIMIT DETECTED! ⚠️⚠️⚠️');
                    logger.warn('[🐦 API Test] Twitter returned 429 but you have ' + mentionError.rateLimit.remaining + ' requests remaining!');
                    logger.warn('[🐦 API Test] This is a Twitter API glitch - ignoring false rate limit');
                    logger.info('[🐦 API Test] ✅ API connection test passed (false 429 ignored)');
                } else {
                    logger.warn('[🐦 API Test] ⚠️  Rate Limited (429) - But This Is OK!');
                    logger.warn('[🐦 API Test] ========================================');
                    logger.warn('[🐦 API Test] You are currently rate limited by Twitter.');
                    logger.warn('[🐦 API Test] ========================================');
                }

                if (mentionError.rateLimit && mentionError.rateLimit.reset) {
                    const resetTime = new Date(mentionError.rateLimit.reset * 1000);
                    const waitMinutes = Math.ceil((mentionError.rateLimit.reset * 1000 - Date.now()) / 60000);
                    logger.warn('[🐦 API Test] 📊 HTTP Rate Limit Headers (Error 429):');
                    logger.warn('[🐦 API Test] ========================================');
                    logger.warn('[🐦 API Test] x-rate-limit-limit: ' + mentionError.rateLimit.limit);
                    logger.warn('[🐦 API Test] x-rate-limit-remaining: ' + mentionError.rateLimit.remaining);
                    logger.warn('[🐦 API Test] x-rate-limit-reset: ' + mentionError.rateLimit.reset + ' (UTC epoch seconds)');
                    logger.warn('[🐦 API Test] Reset time: ' + resetTime.toISOString() + ' (' + waitMinutes + ' minutes)');
                    logger.warn('[🐦 API Test] ========================================');

                    // Only store reset time if it's a REAL rate limit (remaining = 0)
                    if (!isFalse429) {
                        rateLimitResetTime = resetTime.getTime();
                        logger.info('[🐦 API Test] 💾 Stored rate limit reset time for daemon');
                    }
                }

                logger.info('[🐦 API Test] ✅ Credentials valid (rate limit status checked)');
            } else {
                // Other errors are actual failures
                logger.error('[🐦 API Test] ❌ Failed to access mentions endpoint');
                throw mentionError;
            }
        }

        logger.info('[🐦 API Test] ========================================');
        logger.info('[🐦 API Test] ✅ Twitter API Connection Test PASSED');
        logger.info('[🐦 API Test] ========================================');

        return true;
    } catch (error: any) {
        // Handle rate limit on authentication endpoint
        if (error.code === 429) {
            // CRITICAL: Check if this is a FALSE 429 error
            // Sometimes Twitter returns 429 even when remaining > 0
            const isFalse429 = error.rateLimit && error.rateLimit.remaining > 0;

            if (isFalse429) {
                logger.warn('[🐦 API Test] ========================================');
                logger.warn('[🐦 API Test] ⚠️⚠️⚠️ FALSE RATE LIMIT DETECTED! ⚠️⚠️⚠️');
                logger.warn('[🐦 API Test] ========================================');
                logger.warn('[🐦 API Test] Twitter returned 429 but you have ' + error.rateLimit.remaining + ' requests remaining!');
                logger.warn('[🐦 API Test] This is a Twitter API glitch - ignoring false rate limit');
                logger.info('[🐦 API Test] ✅ API connection test passed (false 429 ignored)');
            } else {
                logger.warn('[🐦 API Test] ========================================');
                logger.warn('[🐦 API Test] ⚠️ Rate Limited (429) - But This Is OK!');
                logger.warn('[🐦 API Test] ========================================');
                logger.warn('[🐦 API Test] You are currently rate limited by Twitter.');
            }

            if (error.rateLimit && error.rateLimit.reset) {
                const resetTime = new Date(error.rateLimit.reset * 1000);
                const waitMinutes = Math.ceil((error.rateLimit.reset * 1000 - Date.now()) / 60000);
                logger.warn('[🐦 API Test] ========================================');
                logger.warn('[🐦 API Test] 📊 HTTP Rate Limit Headers (Error 429):');
                logger.warn('[🐦 API Test] ========================================');
                logger.warn('[🐦 API Test] x-rate-limit-limit: ' + error.rateLimit.limit);
                logger.warn('[🐦 API Test] x-rate-limit-remaining: ' + error.rateLimit.remaining);
                logger.warn('[🐦 API Test] x-rate-limit-reset: ' + error.rateLimit.reset + ' (UTC epoch seconds)');
                logger.warn('[🐦 API Test] Reset time: ' + resetTime.toISOString() + ' (' + waitMinutes + ' minutes)');
                logger.warn('[🐦 API Test] ========================================');

                // Only store reset time if it's a REAL rate limit (remaining = 0)
                if (!isFalse429) {
                    rateLimitResetTime = resetTime.getTime();
                    logger.info('[🐦 API Test] 💾 Stored rate limit reset time - daemon will wait');
                } else {
                    logger.info('[🐦 API Test] ⏭️  Skipping reset time storage (false 429)');
                }
            }

            logger.info('[🐦 API Test] ========================================');
            logger.info('[🐦 API Test] ✅ Continuing - Daemon will respect rate limits');
            logger.info('[🐦 API Test] ========================================');
            return true; // Allow daemon to continue
        }

        // For non-rate-limit errors, these are real failures
        logger.error('[🐦 API Test] ========================================');
        logger.error('[🐦 API Test] ❌ Twitter API Connection Test FAILED');
        logger.error('[🐦 API Test] ========================================');
        logger.error('[🐦 API Test] Error details:', error);

        if (error.code) {
            logger.error('[🐦 API Test] Error code: ' + error.code);
        }
        if (error.message) {
            logger.error('[🐦 API Test] Error message: ' + error.message);
        }
        if (error.data) {
            logger.error('[🐦 API Test] API response data: ' + JSON.stringify(error.data, null, 2));
        }

        return false;
    }
}

/**
 * Get mentions from Twitter API
 * NOTE: This function does NOT fetch parent tweet videos to save API calls.
 * Video fetching should be done on-demand AFTER validating the mention is a valid dubbing request.
 * Use fetchVideoForMention() for on-demand video fetching.
 *
 * @param sinceId Optional tweet ID to only fetch mentions newer than this
 * @param maxResults Maximum number of results to return (default 100, max 100)
 * @returns Array of mention data (without video URLs - fetch separately if needed)
 */
export async function fetchMentions(sinceId?: string, maxResults: number = 100): Promise<MentionData[]> {
    logger.info('[🐦 Mentions] Fetching mentions from Twitter API...');

    // Retry loop for rate limiting
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Check if we're in a known rate limit window
            if (rateLimitResetTime) {
                if (Date.now() < rateLimitResetTime) {
                    // Still rate limited - wait
                    const waitUntilReset = rateLimitResetTime - Date.now();
                    const waitMinutes = Math.ceil(waitUntilReset / 60000);
                    logger.warn(`[🐦 Mentions] ⚠️ Known rate limit active. Waiting ${waitMinutes}m until reset...`);
                    await sleep(waitUntilReset + 5000); // Add 5s buffer
                    rateLimitResetTime = null;
                } else {
                    // Reset time has passed - clear it and proceed
                    logger.info(`[🐦 Mentions] ✅ Rate limit reset time has passed, clearing and proceeding...`);
                    rateLimitResetTime = null;
                }
            }

            // Rate limit protection
            const now = Date.now();
            const timeSinceLastPoll = now - lastPollTime;
            if (timeSinceLastPoll < MIN_POLL_INTERVAL_MS) {
                const waitTime = MIN_POLL_INTERVAL_MS - timeSinceLastPoll;
                logger.info(`[🐦 Mentions] Rate limit protection: waiting ${Math.ceil(waitTime / 1000)}s before polling...`);
                await sleep(waitTime);
            }

            // Get authenticated user info to fetch their mentions
            logger.info(`[🐦 API Call] 🔵 Calling Twitter API: GET /2/users/me`);
            const me = await rwClient.v2.me();
            logger.info(`[🐦 API Call] ✅ Response received from /2/users/me`);
            logger.info(`[🐦 Mentions] Fetching mentions for @${me.data.username} (ID: ${me.data.id})`);

            // Build query parameters - include media fields and referenced tweets
            // Clamp maxResults between 5 and 100
            const clampedMaxResults = Math.max(5, Math.min(maxResults, 100));
            const params: any = {
                max_results: clampedMaxResults,
                'tweet.fields': 'created_at,author_id,conversation_id,attachments,referenced_tweets',
                'user.fields': 'username',
                // CRITICAL: referenced_tweets.id expansion tells Twitter to include the parent tweet data
                // attachments.media_keys expansion applies to BOTH mention tweets AND referenced tweets
                expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
                'media.fields': 'type,url,variants,duration_ms,media_key',
            };

            logger.info(`[🐦 Mentions] Requesting up to ${clampedMaxResults} mentions...`);

            if (sinceId) {
                params.since_id = sinceId;
                logger.info(`[🐦 Mentions] Fetching mentions since tweet ID: ${sinceId}`);
            }

            // Fetch mentions timeline
            logger.info(`[🐦 Mentions] Requesting mentions (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
            logger.info(`[🐦 API Call] 🔵 Calling Twitter API: GET /2/users/${me.data.id}/mentions`);
            logger.info(`[🐦 API Call] Parameters: ${JSON.stringify(params)}`);
            const fetchStartTime = Date.now();
            const mentionsTimeline = await rwClient.v2.userMentionTimeline(me.data.id, params);
            const fetchDuration = Date.now() - fetchStartTime;
            logger.info(`[🐦 API Call] ✅ Response received from /2/users/${me.data.id}/mentions (${fetchDuration}ms)`);

            lastPollTime = Date.now();

            // Log verbose response info
            logger.info(`[🐦 Mentions] ✅ Mentions API response received (${fetchDuration}ms)`);
            logger.debug(`[🐦 Mentions] Response meta:`, JSON.stringify(mentionsTimeline.meta, null, 2));

            // Check for rate limit headers in the response
            // Reference: https://docs.x.com/x-api/fundamentals/rate-limits
            // Plugin automatically tracks these headers
            if (mentionsTimeline.rateLimit) {
                logger.info(`[🐦 Mentions] ========================================`);
                logger.info(`[🐦 Mentions] 📊 HTTP Rate Limit Headers (auto-tracked by plugin):`);
                logger.info(`[🐦 Mentions] ========================================`);
                logger.info(`[🐦 Mentions] x-rate-limit-limit: ${mentionsTimeline.rateLimit.limit} (rate limit ceiling for endpoint)`);
                logger.info(`[🐦 Mentions] x-rate-limit-remaining: ${mentionsTimeline.rateLimit.remaining} (remaining requests for 15-min window)`);
                logger.info(`[🐦 Mentions] x-rate-limit-reset: ${mentionsTimeline.rateLimit.reset} (UTC epoch seconds)`);

                const resetTime = new Date(mentionsTimeline.rateLimit.reset * 1000);
                const resetMinutes = Math.ceil((mentionsTimeline.rateLimit.reset * 1000 - Date.now()) / 60000);
                logger.info(`[🐦 Mentions] Reset time: ${resetTime.toISOString()} (${resetMinutes} minutes)`);
                logger.info(`[🐦 Mentions] ========================================`);

                // Warn if running low on rate limit
                if (mentionsTimeline.rateLimit.remaining < 5) {
                    logger.warn(`[🐦 Mentions] ⚠️ Rate limit running low! Only ${mentionsTimeline.rateLimit.remaining} requests remaining`);
                }
            }

            // Log the plugin's tracked rate limit (may differ from response if cached)
            try {
                const pluginLimit = await rateLimitPlugin.v2.getRateLimit(`users/${me.data.id}/mentions`);
                if (pluginLimit) {
                    logger.debug(`[🐦 Mentions] Plugin tracked rate limit: ${pluginLimit.remaining}/${pluginLimit.limit} remaining`);
                }
            } catch (err) {
                // Ignore errors getting plugin rate limit
            }

        // Process mentions
        // NOTE: Videos are extracted from parent tweets in the API response
        const mentions: MentionData[] = [];

        // Debug: Log what includes we got back
        logger.info(`[🐦 Mentions] ========================================`);
        logger.info(`[🐦 Mentions] API RESPONSE INCLUDES:`);
        logger.info(`[🐦 Mentions] ========================================`);
        logger.info(`[🐦 Mentions] Users: ${mentionsTimeline.data.includes?.users?.length || 0}`);
        logger.info(`[🐦 Mentions] Tweets (referenced): ${mentionsTimeline.data.includes?.tweets?.length || 0}`);
        logger.info(`[🐦 Mentions] Media: ${mentionsTimeline.data.includes?.media?.length || 0}`);
        logger.info(`[🐦 Mentions] ========================================`);

        // Log full response for first mention to debug
        if (mentionsTimeline.data.data && mentionsTimeline.data.data.length > 0) {
            const firstMention = mentionsTimeline.data.data[0];
            logger.info(`[🐦 Mentions] FIRST MENTION SAMPLE:`);
            logger.info(`[🐦 Mentions] Tweet ID: ${firstMention.id}`);
            logger.info(`[🐦 Mentions] Has referenced_tweets: ${!!firstMention.referenced_tweets}`);
            if (firstMention.referenced_tweets) {
                logger.info(`[🐦 Mentions] Referenced tweets: ${JSON.stringify(firstMention.referenced_tweets)}`);
            }
            logger.info(`[🐦 Mentions] Has attachments: ${!!firstMention.attachments}`);
            if (firstMention.attachments) {
                logger.info(`[🐦 Mentions] Attachments: ${JSON.stringify(firstMention.attachments)}`);
            }
        }

        logger.debug(`[🐦 Mentions] Full includes object:`, JSON.stringify(mentionsTimeline.data.includes, null, 2));

        for (const tweet of mentionsTimeline.data.data || []) {
            // Get author username from includes
            const author = mentionsTimeline.data.includes?.users?.find(u => u.id === tweet.author_id);
            const username = author?.username || 'unknown';

            // Get parent tweet info if this is a reply
            let parentUsername: string | undefined;
            let videoUrl: string | undefined;
            let hasVideo = false;

            if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
                // Find the replied-to tweet
                const referencedTweet = tweet.referenced_tweets.find(ref => ref.type === 'replied_to');
                if (referencedTweet && referencedTweet.id) {
                    logger.debug(`[🐦 Mentions] Tweet ${tweet.id} references parent tweet ${referencedTweet.id}`);

                    // Find the parent tweet in includes
                    const parentTweet = mentionsTimeline.data.includes?.tweets?.find(t => t.id === referencedTweet.id);
                    if (parentTweet) {
                        logger.debug(`[🐦 Mentions] Found parent tweet ${referencedTweet.id} in includes`);
                        logger.debug(`[🐦 Mentions] Parent tweet attachments:`, parentTweet.attachments);

                        // Get parent author username
                        if (parentTweet.author_id) {
                            const parentAuthor = mentionsTimeline.data.includes?.users?.find(u => u.id === parentTweet.author_id);
                            parentUsername = parentAuthor?.username;
                        }

                        // Extract video from parent tweet if it has media
                        if (parentTweet.attachments?.media_keys) {
                            logger.debug(`[🐦 Mentions] Parent tweet has ${parentTweet.attachments.media_keys.length} media keys`);

                            if (mentionsTimeline.data.includes?.media) {
                                logger.debug(`[🐦 Mentions] Total media items in response: ${mentionsTimeline.data.includes.media.length}`);

                                for (const mediaKey of parentTweet.attachments.media_keys) {
                                    logger.debug(`[🐦 Mentions] Looking for media_key: ${mediaKey}`);
                                    const media = mentionsTimeline.data.includes.media.find(m => m.media_key === mediaKey);

                                    if (media) {
                                        logger.debug(`[🐦 Mentions] Found media for key ${mediaKey}, type: ${media.type}`);

                                        if (media.type === 'video' && media.variants) {
                                            logger.debug(`[🐦 Mentions] Video has ${media.variants.length} variants`);

                                            // Get highest bitrate MP4 variant
                                            const bestVariant = media.variants
                                                .filter((v: any) => v.content_type === 'video/mp4')
                                                .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                                            if (bestVariant) {
                                                videoUrl = bestVariant.url;
                                                hasVideo = true;
                                                logger.info(`[🐦 Mentions] ✅ Found video in parent tweet ${referencedTweet.id}: ${videoUrl}`);
                                            } else {
                                                logger.warn(`[🐦 Mentions] ⚠️ No MP4 variants found for video`);
                                            }
                                            break;
                                        }
                                    } else {
                                        logger.warn(`[🐦 Mentions] ⚠️ Media key ${mediaKey} not found in includes.media`);
                                    }
                                }
                            } else {
                                logger.warn(`[🐦 Mentions] ⚠️ No media in includes despite parent having media_keys`);
                            }
                        } else {
                            logger.debug(`[🐦 Mentions] Parent tweet has no media_keys`);
                        }
                    } else {
                        logger.warn(`[🐦 Mentions] ⚠️ Parent tweet ${referencedTweet.id} NOT found in includes!`);
                    }
                }
            }

            // Build mention data WITH video info from parent tweet
            mentions.push({
                tweetId: tweet.id,
                tweetUrl: `https://twitter.com/${username}/status/${tweet.id}`,
                username: username,
                parentUsername: parentUsername,
                text: tweet.text,
                createdAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
                authorId: tweet.author_id || '',
                hasVideo: hasVideo,
                videoUrl: videoUrl,
                videoVariants: undefined,
            });
        }

            logger.info(`[🐦 Mentions] ✅ Fetched ${mentions.length} mentions`);

            if (mentions.length > 0) {
                logger.debug(`[🐦 Mentions] Latest mention: @${mentions[0].username}: "${mentions[0].text.substring(0, 50)}..."`);
            }

            return mentions;

        } catch (error: any) {
            const isLastAttempt = attempt === MAX_RETRIES;

            // Handle rate limiting with exponential backoff
            if (error.code === 429) {
                logger.error(`[🐦 Mentions] ========================================`);
                logger.error(`[🐦 Mentions] 🚨 RATE LIMIT ERROR (429) DETECTED`);
                logger.error(`[🐦 Mentions] Attempt: ${attempt + 1}/${MAX_RETRIES + 1}`);
                logger.error(`[🐦 Mentions] ========================================`);

                // Log full error details for debugging
                logger.error(`[🐦 Mentions] Full error object:`, JSON.stringify(error, null, 2));
                logger.error(`[🐦 Mentions] Error data:`, JSON.stringify(error.data, null, 2));
                logger.error(`[🐦 Mentions] Error response body:`, error.data?.detail || error.data?.title || 'No detail available');

                // Try to get reset time from headers
                let resetWaitTime: number | null = null;
                let useResetTime = false;

                if (error.rateLimit && error.rateLimit.reset) {
                    const resetTime = new Date(error.rateLimit.reset * 1000);
                    resetWaitTime = resetTime.getTime() - Date.now();
                    const waitMinutes = Math.ceil(resetWaitTime / 60000);

                    logger.error(`[🐦 Mentions] ========================================`);
                    logger.error(`[🐦 Mentions] 📊 HTTP Rate Limit Headers (Error 429):`);
                    logger.error(`[🐦 Mentions] ========================================`);
                    logger.error(`[🐦 Mentions] x-rate-limit-limit: ${error.rateLimit.limit} (rate limit ceiling for endpoint)`);
                    logger.error(`[🐦 Mentions] x-rate-limit-remaining: ${error.rateLimit.remaining} (remaining requests for 15-min window)`);
                    logger.error(`[🐦 Mentions] x-rate-limit-reset: ${error.rateLimit.reset} (UTC epoch seconds)`);
                    logger.error(`[🐦 Mentions] Reset time: ${resetTime.toISOString()} (${waitMinutes} minutes)`);
                    logger.error(`[🐦 Mentions] ========================================`);

                    // CRITICAL: Check if this is a FALSE 429 error
                    // Sometimes Twitter returns 429 even when remaining > 0
                    if (error.rateLimit.remaining > 0) {
                        logger.warn(`[🐦 Mentions] ⚠️⚠️⚠️ FALSE RATE LIMIT DETECTED! ⚠️⚠️⚠️`);
                        logger.warn(`[🐦 Mentions] Remaining requests: ${error.rateLimit.remaining} (should be 0 if truly rate limited)`);
                        logger.warn(`[🐦 Mentions] This appears to be a Twitter API glitch or different limit being enforced`);
                        logger.warn(`[🐦 Mentions] Will retry with shorter delay instead of waiting full reset time`);

                        // Use short retry delay for false 429s instead of waiting full reset time
                        useResetTime = false;
                    } else {
                        rateLimitResetTime = resetTime.getTime();
                        logger.info(`[🐦 Mentions] 💾 Stored rate limit reset time globally for future requests`);

                        if (resetWaitTime > 0 && resetWaitTime <= MAX_RETRY_DELAY_MS) {
                            useResetTime = true;
                        }
                    }
                } else {
                    logger.warn(`[🐦 Mentions] ⚠️ No rate limit info in error response, using exponential backoff`);
                }

                if (isLastAttempt) {
                    logger.error(`[🐦 Mentions] ========================================`);
                    logger.error(`[🐦 Mentions] ❌ MAX RETRIES REACHED - GIVING UP`);
                    logger.error(`[🐦 Mentions] This is normal if rate limits persist.`);
                    logger.error(`[🐦 Mentions] Will retry on next polling interval.`);
                    logger.error(`[🐦 Mentions] ========================================`);
                    return [];
                }

                // Choose delay strategy
                let backoffDelay: number;
                let delaySource: string;

                // For false 429s (remaining > 0), use short retry delay
                if (error.rateLimit && error.rateLimit.remaining > 0) {
                    backoffDelay = 5000; // 5 seconds for false 429s
                    delaySource = "short retry (false 429)";
                } else if (useResetTime && resetWaitTime) {
                    backoffDelay = resetWaitTime;
                    delaySource = "Twitter API reset time";
                } else {
                    backoffDelay = getExponentialBackoffDelay(attempt);
                    delaySource = "exponential backoff";
                }

                const backoffMinutes = Math.floor(backoffDelay / 60000);
                const backoffSeconds = Math.round((backoffDelay % 60000) / 1000);

                logger.info(`[🐦 Mentions] ⏳ Strategy: ${delaySource}`);
                logger.info(`[🐦 Mentions] ⏳ Waiting ${backoffMinutes}m ${backoffSeconds}s before retry ${attempt + 2}/${MAX_RETRIES + 1}...`);
                await sleep(backoffDelay);
                logger.info(`[🐦 Mentions] ⏭️  Wait complete, retrying now...`);
                continue; // Retry

            } else {
                // Non-rate-limit error - log and return empty
                logger.error('[🐦 Mentions] ========================================');
                logger.error('[🐦 Mentions] ❌ ERROR FETCHING MENTIONS');
                logger.error('[🐦 Mentions] ========================================');
                logger.error('[🐦 Mentions] Error details:', error);

                if (error.code) {
                    logger.error(`[🐦 Mentions] Error Code: ${error.code}`);
                }
                if (error.message) {
                    logger.error(`[🐦 Mentions] Error Message: ${error.message}`);
                }
                if (error.data) {
                    logger.error(`[🐦 Mentions] API Response Data:`, JSON.stringify(error.data, null, 2));
                }

                logger.error('[🐦 Mentions] Returning empty results to avoid crash');
                return [];
            }
        }
    }

    // Should never reach here
    logger.error('[🐦 Mentions] ❌ Exhausted all retries without returning');
    return [];
}

/**
 * Upload media to Twitter
 * @param mediaPath Path to media file
 * @returns Media ID string or null if failed
 */
export async function uploadMedia(mediaPath: string): Promise<string | null> {
    logger.info(`[🐦 Upload] ========================================`);
    logger.info(`[🐦 Upload] Starting media upload`);
    logger.info(`[🐦 Upload] File path: ${mediaPath}`);
    logger.info(`[🐦 Upload] ========================================`);

    if (!fs.existsSync(mediaPath)) {
        logger.error(`[🐦 Upload] ❌ File not found: ${mediaPath}`);
        return null;
    }

    // Verify file has actual content and is stable (not currently being written)
    try {
        const stats = fs.statSync(mediaPath);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        const fileSizeKB = (stats.size / 1024).toFixed(2);

        if (stats.size === 0) {
            logger.error(`[🐦 Upload] ❌ File exists but is empty (0 bytes): ${mediaPath}`);
            return null;
        }

        logger.info(`[🐦 Upload] ✅ File exists: ${mediaPath}`);
        logger.info(`[🐦 Upload] 📊 File size: ${fileSizeMB} MB (${fileSizeKB} KB, ${stats.size} bytes)`);
        logger.info(`[🐦 Upload] 🕒 File modified: ${stats.mtime.toISOString()}`);

        // Wait a moment and check if file size is still changing (indicating active write)
        await sleep(500); // 500ms delay
        const stats2 = fs.statSync(mediaPath);

        if (stats.size !== stats2.size) {
            logger.warn(`[🐦 Upload] ⚠️ File size changed during verification (${stats.size} → ${stats2.size} bytes)`);
            logger.warn(`[🐦 Upload] File may still be downloading. Waiting 2 seconds...`);
            await sleep(2000);

            // Final check
            const stats3 = fs.statSync(mediaPath);
            const finalSizeMB = (stats3.size / (1024 * 1024)).toFixed(2);
            logger.info(`[🐦 Upload] Final file size after wait: ${finalSizeMB} MB`);

            if (stats3.size === 0) {
                logger.error(`[🐦 Upload] ❌ File is still empty after waiting`);
                return null;
            }
        }

        logger.info(`[🐦 Upload] ✅ File validation passed, proceeding with upload`);

    } catch (statError) {
        logger.error(`[🐦 Upload] ❌ Error validating file:`, statError);
        return null;
    }

    // Determine MIME type based on file extension
    const ext = mediaPath.toLowerCase();
    let mimeType: EUploadMimeType;

    if (ext.endsWith('.mp4')) {
        mimeType = EUploadMimeType.Mp4;
    } else if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
        mimeType = EUploadMimeType.Jpeg;
    } else if (ext.endsWith('.png')) {
        mimeType = EUploadMimeType.Png;
    } else if (ext.endsWith('.gif')) {
        mimeType = EUploadMimeType.Gif;
    } else if (ext.endsWith('.webp')) {
        mimeType = EUploadMimeType.Webp;
    } else {
        logger.error(`[🐦 Upload] Unsupported file type: ${ext}`);
        return null;
    }

    // Retry loop with exponential backoff
    try {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                logger.info(`[🐦 Upload] ========================================`);
                logger.info(`[🐦 Upload] 📤 UPLOAD REQUEST (Attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
                logger.info(`[🐦 Upload] ========================================`);
                logger.info(`[🐦 Upload] Endpoint: POST /1.1/media/upload.json`);
                logger.info(`[🐦 Upload] File path: ${mediaPath}`);
                logger.info(`[🐦 Upload] MIME type: ${mimeType}`);
                logger.info(`[🐦 Upload] ========================================`);

                // Upload using v1.1 API
                const mediaId = await twitterClient.v1.uploadMedia(mediaPath, { mimeType });

                logger.info(`[🐦 Upload] ========================================`);
                logger.info(`[🐦 Upload] 📥 UPLOAD RESPONSE - SUCCESS`);
                logger.info(`[🐦 Upload] ========================================`);
                logger.info(`[🐦 Upload] ✅ Media uploaded successfully`);
                logger.info(`[🐦 Upload] Media ID: ${mediaId}`);
                logger.info(`[🐦 Upload] ========================================`);
                return mediaId;

            } catch (error: any) {
                const isLastAttempt = attempt === MAX_RETRIES;
                const isNetworkError = !error.code || error.type === 'request';

                // Log comprehensive error details
                logger.error(`[🐦 Upload] ========================================`);
                logger.error(`[🐦 Upload] ❌ TWITTER API UPLOAD ERROR`);
                logger.error(`[🐦 Upload] ========================================`);
                logger.error(`[🐦 Upload] Attempt: ${attempt + 1}/${MAX_RETRIES + 1}`);
                logger.error(`[🐦 Upload] Error type: ${error.type || 'unknown'}`);
                logger.error(`[🐦 Upload] Error code: ${error.code || 'N/A'}`);
                logger.error(`[🐦 Upload] Error message: ${error.message || 'No message'}`);
                logger.error(`[🐦 Upload] ========================================`);
                logger.error(`[🐦 Upload] Full Error Object:`, JSON.stringify(error, null, 2));
                logger.error(`[🐦 Upload] ========================================`);

                if (error.errors) {
                    logger.error(`[🐦 Upload] Error Array:`, JSON.stringify(error.errors, null, 2));
                }

                if (error.data) {
                    logger.error(`[🐦 Upload] Error Data:`, JSON.stringify(error.data, null, 2));
                }

                // Log network-specific details
                if (isNetworkError) {
                    logger.error(`[🐦 Upload] 🌐 Network Error Details:`);
                    logger.error(`[🐦 Upload] - Error name: ${error.name || 'unknown'}`);
                    logger.error(`[🐦 Upload] - Error type: ${error.type || 'unknown'}`);
                    logger.error(`[🐦 Upload] - Syscall: ${error.syscall || 'N/A'}`);
                    logger.error(`[🐦 Upload] - Error code: ${error.code || error.errno || 'N/A'}`);
                    logger.error(`[🐦 Upload] - Host: ${error.hostname || error.address || 'N/A'}`);
                    logger.error(`[🐦 Upload] - Port: ${error.port || 'N/A'}`);
                }

                logger.error(`[🐦 Upload] Full error stack:`, error.stack);
                logger.error(`[🐦 Upload] ========================================`);

                // Retry on network errors
                if (isNetworkError && !isLastAttempt) {
                    const retryDelay = 5000; // 5 seconds for network errors
                    logger.warn(`[🐦 Upload] ⚠️ Network error detected. Retrying in ${retryDelay/1000}s...`);
                    await sleep(retryDelay);
                    continue;
                }

                // Retry on rate limits with exponential backoff
                if (error.code === 429 && !isLastAttempt) {
                    logger.error(`[🐦 Upload] 🚨 RATE LIMIT (429)`);

                    // Log rate limit headers if available
                    if (error.rateLimit) {
                        const resetTime = error.rateLimit.reset ? new Date(error.rateLimit.reset * 1000) : null;
                        const waitMinutes = resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / 60000) : 'unknown';

                        logger.error(`[🐦 Upload] 📊 Rate Limit Headers:`);
                        logger.error(`[🐦 Upload] x-rate-limit-limit: ${error.rateLimit.limit || 'N/A'}`);
                        logger.error(`[🐦 Upload] x-rate-limit-remaining: ${error.rateLimit.remaining || 'N/A'}`);
                        logger.error(`[🐦 Upload] x-rate-limit-reset: ${error.rateLimit.reset || 'N/A'}`);
                        if (resetTime) {
                            logger.error(`[🐦 Upload] Reset time: ${resetTime.toISOString()} (in ${waitMinutes} minutes)`);
                        }

                        // Warn about false rate limits
                        if (error.rateLimit.remaining > 0) {
                            logger.warn(`[🐦 Upload] ⚠️ FALSE RATE LIMIT? Remaining: ${error.rateLimit.remaining} (should be 0)`);
                        }
                    }

                    // Use short delay for false 429s (remaining > 0), otherwise use exponential backoff
                    let backoffDelay: number;
                    let delaySource: string;

                    if (error.rateLimit && error.rateLimit.remaining > 0) {
                        backoffDelay = 5000; // 5 seconds for false 429s
                        delaySource = "short retry (false 429)";
                        logger.info(`[🐦 Upload] 🔄 Using SHORT DELAY for false rate limit (remaining: ${error.rateLimit.remaining})`);
                    } else {
                        backoffDelay = getExponentialBackoffDelay(attempt);
                        delaySource = "exponential backoff";
                    }

                    const backoffMinutes = Math.floor(backoffDelay / 60000);
                    const backoffSeconds = Math.round((backoffDelay % 60000) / 1000);
                    logger.info(`[🐦 Upload] ⏳ Retrying in ${backoffMinutes}m ${backoffSeconds}s (${delaySource})...`);
                    await sleep(backoffDelay);
                    continue;
                }

                // Last attempt or non-retryable error
                if (isLastAttempt) {
                    logger.error(`[🐦 Upload] ❌ All ${MAX_RETRIES + 1} attempts failed. Giving up.`);
                }
                return null;
            }
        }
    } catch (error: any) {
        // Catch any unexpected errors that escape the inner try-catch
        logger.error(`[🐦 Upload] ❌ Unexpected error during upload:`, error);
        return null;
    }

    return null;
}

/**
 * Post a reply tweet with optional media
 * @param tweetText Reply text
 * @param replyToTweetId Tweet ID to reply to
 * @param mediaPath Optional media file path
 * @returns True if successful
 */
export async function postReplyWithMedia(
    tweetText: string,
    replyToTweetId: string,
    mediaPath?: string
): Promise<boolean> {
    try {
        logger.info(`[🐦 Reply] Posting reply to tweet ID: ${replyToTweetId}`);
        logger.info(`[🐦 Reply] Reply text: "${tweetText}"`);

        // Upload media if provided (uploadMedia already has retry logic)
        let mediaId: string | null = null;
        if (mediaPath) {
            logger.info(`[🐦 Reply] Uploading media: ${mediaPath}`);
            try {
                mediaId = await uploadMedia(mediaPath);
                if (!mediaId) {
                    logger.error('[🐦 Reply] ❌ Failed to upload media');
                    return false;
                }
            } catch (uploadError: any) {
                logger.error('[🐦 Reply] ❌ Exception during media upload:', uploadError);
                return false;
            }
        }

        // Construct tweet payload
        const tweetPayload: any = {
            text: tweetText,
            reply: {
                in_reply_to_tweet_id: replyToTweetId
            }
        };

        if (mediaId) {
            tweetPayload.media = { media_ids: [mediaId] };
        }

        // Retry loop for posting tweet
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Post tweet
                logger.info(`[🐦 Reply] Posting tweet (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
                logger.info(`[🐦 Reply] ========================================`);
                logger.info(`[🐦 Reply] 📤 REQUEST DETAILS`);
                logger.info(`[🐦 Reply] ========================================`);
                logger.info(`[🐦 Reply] Endpoint: POST /2/tweets`);
                logger.info(`[🐦 Reply] Payload Text: ${tweetPayload.text}`);
                logger.info(`[🐦 Reply] Reply To Tweet ID: ${tweetPayload.reply?.in_reply_to_tweet_id || 'N/A'}`);
                if (tweetPayload.media) {
                    logger.info(`[🐦 Reply] Media IDs: ${JSON.stringify(tweetPayload.media.media_ids)}`);
                }
                logger.info(`[🐦 Reply] Full Payload Object:`, tweetPayload);
                logger.info(`[🐦 Reply] ========================================`);

                const result = await rwClient.v2.tweet(tweetPayload);

                logger.info(`[🐦 Reply] ========================================`);
                logger.info(`[🐦 Reply] 📥 RESPONSE DETAILS`);
                logger.info(`[🐦 Reply] ========================================`);
                logger.info(`[🐦 Reply] Response Data:`, result.data);
                logger.info(`[🐦 Reply] Response Errors:`, result.errors);
                logger.info(`[🐦 Reply] Full Response Object:`, result);
                logger.info(`[🐦 Reply] ========================================`);

                if (result.data?.id) {
                    logger.info(`[🐦 Reply] ✅ Reply posted successfully! Tweet ID: ${result.data.id}`);
                    return true;
                } else {
                    logger.error('[🐦 Reply] ❌ No tweet ID in response', result.errors);
                    return false;
                }

            } catch (error: any) {
                const isLastAttempt = attempt === MAX_RETRIES;

                logger.error(`[🐦 Reply] ========================================`);
                logger.error(`[🐦 Reply] ❌ TWITTER API ERROR`);
                logger.error(`[🐦 Reply] ========================================`);
                logger.error(`[🐦 Reply] Error Code: ${error.code || 'N/A'}`);
                logger.error(`[🐦 Reply] Error Message: ${error.message || 'No message'}`);
                logger.error(`[🐦 Reply] Error Type: ${error.type || 'unknown'}`);
                logger.error(`[🐦 Reply] Error Name: ${error.name || 'unknown'}`);
                logger.error(`[🐦 Reply] ========================================`);

                // Log error data object
                if (error.data) {
                    logger.error(`[🐦 Reply] Error Data Object:`, error.data);
                    logger.error(`[🐦 Reply] Error Data Title: ${error.data.title || 'N/A'}`);
                    logger.error(`[🐦 Reply] Error Data Detail: ${error.data.detail || 'N/A'}`);
                    logger.error(`[🐦 Reply] Error Data Type: ${error.data.type || 'N/A'}`);
                }

                // Log error array
                if (error.errors) {
                    logger.error(`[🐦 Reply] Error Array:`, error.errors);
                }

                // Log the complete error object properties
                logger.error(`[🐦 Reply] Error Keys:`, Object.keys(error));
                logger.error(`[🐦 Reply] Full Error Object:`, error);
                logger.error(`[🐦 Reply] ========================================`);

                // Handle rate limiting with exponential backoff
                if (error.code === 429) {
                    logger.error(`[🐦 Reply] ========================================`);
                    logger.error(`[🐦 Reply] 🚨 RATE LIMIT ERROR (429) DETECTED`);
                    logger.error(`[🐦 Reply] Attempt: ${attempt + 1}/${MAX_RETRIES + 1}`);
                    logger.error(`[🐦 Reply] ========================================`);

                    // Log rate limit headers if available
                    if (error.rateLimit) {
                        const resetTime = error.rateLimit.reset ? new Date(error.rateLimit.reset * 1000) : null;
                        const waitMinutes = resetTime ? Math.ceil((resetTime.getTime() - Date.now()) / 60000) : 'unknown';

                        logger.error(`[🐦 Reply] 📊 HTTP Rate Limit Headers:`);
                        logger.error(`[🐦 Reply] x-rate-limit-limit: ${error.rateLimit.limit || 'N/A'}`);
                        logger.error(`[🐦 Reply] x-rate-limit-remaining: ${error.rateLimit.remaining || 'N/A'}`);
                        logger.error(`[🐦 Reply] x-rate-limit-reset: ${error.rateLimit.reset || 'N/A'}`);
                        if (resetTime) {
                            logger.error(`[🐦 Reply] Reset time: ${resetTime.toISOString()} (in ${waitMinutes} minutes)`);
                        }
                        logger.error(`[🐦 Reply] ========================================`);

                        // Warn about false rate limits
                        if (error.rateLimit.remaining > 0) {
                            logger.warn(`[🐦 Reply] ⚠️ FALSE RATE LIMIT? Remaining: ${error.rateLimit.remaining} (should be 0)`);
                        }
                    } else {
                        logger.error(`[🐦 Reply] ⚠️ No rate limit headers in error response`);
                        logger.error(`[🐦 Reply] Full error:`, JSON.stringify(error, null, 2));
                    }

                    if (isLastAttempt) {
                        logger.error(`[🐦 Reply] ❌ Max retries reached. Giving up.`);
                        return false;
                    }

                    // Use short delay for false 429s (remaining > 0), otherwise use exponential backoff
                    let backoffDelay: number;
                    let delaySource: string;

                    if (error.rateLimit && error.rateLimit.remaining > 0) {
                        backoffDelay = 5000; // 5 seconds for false 429s
                        delaySource = "short retry (false 429)";
                        logger.info(`[🐦 Reply] 🔄 Using SHORT DELAY for false rate limit (remaining: ${error.rateLimit.remaining})`);
                    } else {
                        backoffDelay = getExponentialBackoffDelay(attempt);
                        delaySource = "exponential backoff";
                    }

                    const backoffMinutes = Math.floor(backoffDelay / 60000);
                    const backoffSeconds = Math.round((backoffDelay % 60000) / 1000);
                    logger.info(`[🐦 Reply] ⏳ Retrying in ${backoffMinutes}m ${backoffSeconds}s (${delaySource})...`);
                    await sleep(backoffDelay);
                    continue;

                } else if (error.code === 403) {
                    // 403 errors usually aren't retryable (duplicate, permissions, etc.)
                    logger.error(`[🐦 Reply] ❌ Forbidden (403) - Not retrying. Error: ${error.message}`);
                    if (error.data?.errors) {
                        logger.error(`[🐦 Reply] Twitter API Errors: ${JSON.stringify(error.data.errors)}`);
                    }
                    return false;

                } else if (error.code && [500, 502, 503, 504].includes(error.code) && !isLastAttempt) {
                    // Server errors - retry with backoff
                    logger.error(`[🐦 Reply] ⚠️ Server error (${error.code}) - Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

                    const backoffDelay = getExponentialBackoffDelay(attempt);
                    const backoffMinutes = Math.floor(backoffDelay / 60000);
                    const backoffSeconds = Math.round((backoffDelay % 60000) / 1000);
                    logger.info(`[🐦 Reply] ⏳ Retrying in ${backoffMinutes}m ${backoffSeconds}s...`);
                    await sleep(backoffDelay);
                    continue;

                } else {
                    // Other errors - fail immediately
                    logger.error('[🐦 Reply] ❌ Error posting reply:', error);
                    if (error.code) {
                        logger.error(`[🐦 Reply] Twitter Error Code: ${error.code}, Message: ${error.message}`);
                    }
                    if (error.data?.errors) {
                        logger.error(`[🐦 Reply] Twitter API Errors: ${JSON.stringify(error.data.errors)}`);
                    }
                    return false;
                }
            }
        }

        logger.error('[🐦 Reply] ❌ Exhausted all retries without success');
        return false;
    } catch (outerError: any) {
        logger.error('[🐦 Reply] ❌ Unexpected error in postReplyWithMedia:', outerError);
        return false;
    }
}

/**
 * Get the latest tweet ID from a user (for sinceId tracking)
 * @param userId User ID to get latest tweet from
 * @returns Latest tweet ID or null
 */
export async function getLatestTweetId(userId: string): Promise<string | null> {
    try {
        const timeline = await rwClient.v2.userTimeline(userId, { max_results: 5 });

        if (timeline.data.data && timeline.data.data.length > 0) {
            return timeline.data.data[0].id;
        }

        return null;
    } catch (error: any) {
        logger.error('[🐦 Latest] ❌ Error getting latest tweet ID:', error);
        return null;
    }
}

/**
 * Fetch video URL for a specific mention's parent tweet
 * @param mentionId The mention tweet ID
 * @returns Video URL if found, undefined otherwise
 */
export async function fetchVideoForMention(mentionId: string): Promise<{ videoUrl?: string; parentTweetId?: string }> {
    try {
        // Get the mention tweet with media fields AND referenced tweets
        const mentionTweet = await rwClient.v2.singleTweet(mentionId, {
            'tweet.fields': 'referenced_tweets,attachments',
            expansions: 'referenced_tweets.id,attachments.media_keys',
            'media.fields': 'type,url,variants,duration_ms'
        });

        // FIRST: Check if the mention itself has a video attached
        if (mentionTweet.includes?.media && mentionTweet.includes.media.length > 0) {
            for (const media of mentionTweet.includes.media) {
                if (media.type === 'video') {
                    const videoVariants = media.variants || [];
                    if (videoVariants.length > 0) {
                        const bestVariant = videoVariants
                            .filter((v: any) => v.content_type === 'video/mp4')
                            .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                        if (bestVariant) {
                            const videoUrl = bestVariant.url;
                            logger.info(`[🐦 Video Fetch] ✅ Found video directly on mention tweet: ${videoUrl}`);
                            return { videoUrl, parentTweetId: undefined };
                        }
                    }
                }
            }
        }

        // SECOND: Check parent tweet if no video on mention itself
        const parentRef = mentionTweet.data.referenced_tweets?.find((ref: any) => ref.type === 'replied_to');
        if (!parentRef) {
            logger.warn(`[🐦 Video Fetch] ❌ Mention ${mentionId} has no video and no parent tweet`);
            return {};
        }

        const parentTweetId = parentRef.id;
        logger.info(`[🐦 Video Fetch] Found parent tweet ID: ${parentTweetId}`);

        // Check cache first
        const cached = parentTweetVideoCache.get(parentTweetId);
        const now = Date.now();

        if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
            logger.info(`[🐦 Video Fetch] ✅ Using cached video for parent tweet ${parentTweetId}: ${cached.videoUrl}`);
            return { videoUrl: cached.videoUrl, parentTweetId };
        }

        // Fetch parent tweet with media
        logger.info(`[🐦 Video Fetch] Fetching video from parent tweet ${parentTweetId}...`);
        const parentTweetData = await rwClient.v2.singleTweet(parentTweetId, {
            'tweet.fields': 'attachments',
            expansions: 'attachments.media_keys',
            'media.fields': 'type,url,variants,duration_ms'
        });

        logger.debug(`[🐦 Video Fetch] Parent tweet response: ${JSON.stringify(parentTweetData, null, 2)}`);

        let videoUrl: string | undefined;

        if (parentTweetData.includes?.media && parentTweetData.includes.media.length > 0) {
            logger.info(`[🐦 Video Fetch] Found ${parentTweetData.includes.media.length} media items in parent tweet`);
            for (const media of parentTweetData.includes.media) {
                logger.info(`[🐦 Video Fetch] Media type: ${media.type}`);
                if (media.type === 'video') {
                    const videoVariants = media.variants || [];
                    logger.info(`[🐦 Video Fetch] Found video with ${videoVariants.length} variants`);

                    // Get highest bitrate video variant
                    if (videoVariants.length > 0) {
                        const bestVariant = videoVariants
                            .filter((v: any) => v.content_type === 'video/mp4')
                            .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                        if (bestVariant) {
                            videoUrl = bestVariant.url;
                            logger.info(`[🐦 Video Fetch] ✅ Found video: ${videoUrl}`);
                        } else {
                            logger.warn(`[🐦 Video Fetch] ⚠️ No MP4 variants found`);
                        }
                    } else {
                        logger.warn(`[🐦 Video Fetch] ⚠️ Video has no variants`);
                    }
                    break;
                }
            }
        } else {
            logger.warn(`[🐦 Video Fetch] ❌ No media found in parent tweet ${parentTweetId}`);
            logger.warn(`[🐦 Video Fetch] Includes object: ${JSON.stringify(parentTweetData.includes)}`);
        }

        // Cache the result
        parentTweetVideoCache.set(parentTweetId, {
            videoUrl,
            videoVariants: undefined,
            timestamp: now
        });

        return { videoUrl, parentTweetId };

    } catch (error: any) {
        logger.error('[🐦 Video Fetch] Error fetching video:', error);
        return {};
    }
}

logger.info('[🐦 Service] Twitter Mention Service initialized');
