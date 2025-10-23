import { TwitterApi, TweetV2, EUploadMimeType } from 'twitter-api-v2';
import logger from '../utils/logger';
import { config } from '../utils/config';
import * as fs from 'fs';

/**
 * Service for polling Twitter mentions and posting replies using the Twitter API v2
 */

// Initialize Twitter API client
const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});

const rwClient = twitterClient.readWrite;

// Rate limiting state
let lastPollTime = 0;
const MIN_POLL_INTERVAL_MS = 60000; // 1 minute between polls to avoid rate limits

// Cache for parent tweet video data (to avoid refetching same tweet multiple times)
const parentTweetVideoCache = new Map<string, { videoUrl: string | undefined; videoVariants: any[] | undefined; timestamp: number }>();
const CACHE_TTL_MS = 3600000; // 1 hour cache

/**
 * Interface for mention data
 */
export interface MentionData {
    tweetId: string;
    tweetUrl: string;
    username: string;
    text: string;
    createdAt: Date;
    authorId: string;
    hasVideo?: boolean;
    videoUrl?: string;
    videoVariants?: Array<{url: string; bitrate?: number; content_type: string}>;
}

/**
 * Get mentions from Twitter API
 * @param sinceId Optional tweet ID to only fetch mentions newer than this
 * @param skipVideoFetch Optional flag to skip fetching parent tweet videos (default true - fetch videos on demand)
 * @returns Array of mention data
 */
export async function fetchMentions(sinceId?: string, skipVideoFetch: boolean = true): Promise<MentionData[]> {
    logger.info('[🐦 Mentions] Fetching mentions from Twitter API...');

    try {
        // Rate limit protection
        const now = Date.now();
        const timeSinceLastPoll = now - lastPollTime;
        if (timeSinceLastPoll < MIN_POLL_INTERVAL_MS) {
            const waitTime = MIN_POLL_INTERVAL_MS - timeSinceLastPoll;
            logger.info(`[🐦 Mentions] Rate limit protection: waiting ${Math.ceil(waitTime / 1000)}s before polling...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Get authenticated user info to fetch their mentions
        const me = await rwClient.v2.me();
        logger.info(`[🐦 Mentions] Fetching mentions for @${me.data.username} (ID: ${me.data.id})`);

        // Build query parameters - include media fields and referenced tweets
        const params: any = {
            max_results: 100, // Maximum allowed
            'tweet.fields': 'created_at,author_id,conversation_id,attachments,referenced_tweets',
            'user.fields': 'username',
            expansions: 'author_id,attachments.media_keys,referenced_tweets.id',
            'media.fields': 'type,url,variants,duration_ms',
        };

        if (sinceId) {
            params.since_id = sinceId;
            logger.info(`[🐦 Mentions] Fetching mentions since tweet ID: ${sinceId}`);
        }

        // Fetch mentions timeline
        const mentionsTimeline = await rwClient.v2.userMentionTimeline(me.data.id, params);

        lastPollTime = Date.now();

        // Process mentions
        const mentions: MentionData[] = [];

        for (const tweet of mentionsTimeline.data.data || []) {
            // Get author username from includes
            const author = mentionsTimeline.data.includes?.users?.find(u => u.id === tweet.author_id);
            const username = author?.username || 'unknown';

            // Check for video attachments in parent tweet (referenced tweet)
            let hasVideo = false;
            let videoUrl: string | undefined;
            let videoVariants: Array<{url: string; bitrate?: number; content_type: string}> | undefined;
            let parentTweetId: string | undefined;

            // If this is a reply, check the parent tweet for video
            if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
                const parentRef = tweet.referenced_tweets.find((ref: any) => ref.type === 'replied_to');
                if (parentRef) {
                    parentTweetId = parentRef.id;
                    const parentTweet = mentionsTimeline.data.includes?.tweets?.find((t: any) => t.id === parentRef.id);

                    // Check if parent tweet has media keys
                    if (parentTweet?.attachments?.media_keys) {
                        // Try to find media in the includes first
                        if (mentionsTimeline.data.includes?.media) {
                            for (const mediaKey of parentTweet.attachments.media_keys) {
                                const media = mentionsTimeline.data.includes.media.find((m: any) => m.media_key === mediaKey);
                                if (media && media.type === 'video') {
                                    hasVideo = true;
                                    videoVariants = media.variants || [];

                                    // Get highest bitrate video variant
                                    if (videoVariants.length > 0) {
                                        const bestVariant = videoVariants
                                            .filter(v => v.content_type === 'video/mp4')
                                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                                        if (bestVariant) {
                                            videoUrl = bestVariant.url;
                                            logger.info(`[🐦 Mentions] Found video in parent tweet ${parentRef.id}: ${videoUrl}`);
                                        }
                                    }
                                    break;
                                }
                            }
                        }

                        // FALLBACK: If no video found and we're not skipping video fetch,
                        // fetch the parent tweet separately to get video (with caching)
                        if (!hasVideo && !skipVideoFetch) {
                        // Check cache first
                        const cached = parentTweetVideoCache.get(parentRef.id);
                        const now = Date.now();

                        if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
                            // Use cached data
                            hasVideo = !!cached.videoUrl;
                            videoUrl = cached.videoUrl;
                            videoVariants = cached.videoVariants;
                            logger.debug(`[🐦 Mentions] Using cached video data for parent tweet ${parentRef.id}`);
                        } else {
                            // Fetch from API
                            logger.info(`[🐦 Mentions] Parent tweet ${parentRef.id} has media but not included in response. Fetching separately...`);
                            try {
                                const parentTweetData = await rwClient.v2.singleTweet(parentRef.id, {
                                    'tweet.fields': 'attachments',
                                    expansions: 'attachments.media_keys',
                                    'media.fields': 'type,url,variants,duration_ms'
                                });

                                if (parentTweetData.includes?.media && parentTweetData.includes.media.length > 0) {
                                    for (const media of parentTweetData.includes.media) {
                                        if (media.type === 'video') {
                                            hasVideo = true;
                                            videoVariants = media.variants || [];

                                            // Get highest bitrate video variant
                                            if (videoVariants.length > 0) {
                                                const bestVariant = videoVariants
                                                    .filter((v: any) => v.content_type === 'video/mp4')
                                                    .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                                                if (bestVariant) {
                                                    videoUrl = bestVariant.url;
                                                    logger.info(`[🐦 Mentions] ✅ Fetched video from parent tweet ${parentRef.id}: ${videoUrl}`);
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }

                                // Cache the result (even if no video found)
                                parentTweetVideoCache.set(parentRef.id, {
                                    videoUrl,
                                    videoVariants,
                                    timestamp: now
                                });

                                // Add small delay to avoid rate limits
                                await new Promise(resolve => setTimeout(resolve, 100));

                            } catch (fetchError: any) {
                                // Check if it's a rate limit error
                                if (fetchError.code === 429) {
                                    logger.warn(`[🐦 Mentions] Rate limited fetching parent tweet ${parentRef.id}. Will retry later.`);
                                } else {
                                    logger.error(`[🐦 Mentions] Failed to fetch parent tweet ${parentRef.id}:`, fetchError);
                                }
                            }
                        }
                    }
                }
            }
            }

            // If no parent video, check mention tweet itself
            if (!hasVideo && tweet.attachments?.media_keys && mentionsTimeline.data.includes?.media) {
                for (const mediaKey of tweet.attachments.media_keys) {
                    const media = mentionsTimeline.data.includes.media.find((m: any) => m.media_key === mediaKey);
                    if (media && media.type === 'video') {
                        hasVideo = true;
                        videoVariants = media.variants || [];

                        // Get highest bitrate video variant
                        if (videoVariants.length > 0) {
                            const bestVariant = videoVariants
                                .filter(v => v.content_type === 'video/mp4')
                                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                            if (bestVariant) {
                                videoUrl = bestVariant.url;
                                logger.info(`[🐦 Mentions] Found video in mention tweet ${tweet.id}: ${videoUrl}`);
                            }
                        }
                        break;
                    }
                }
            }

            mentions.push({
                tweetId: tweet.id,
                tweetUrl: `https://twitter.com/${username}/status/${tweet.id}`,
                username: username,
                text: tweet.text,
                createdAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
                authorId: tweet.author_id || '',
                hasVideo,
                videoUrl,
                videoVariants,
            });
        }

        logger.info(`[🐦 Mentions] ✅ Fetched ${mentions.length} mentions`);

        if (mentions.length > 0) {
            logger.debug(`[🐦 Mentions] Latest mention: @${mentions[0].username}: "${mentions[0].text.substring(0, 50)}..."`);
        }

        return mentions;

    } catch (error: any) {
        logger.error('[🐦 Mentions] ❌ Error fetching mentions:', error);
        if (error.code) {
            logger.error(`[🐦 Mentions] Twitter Error Code: ${error.code}, Message: ${error.message}`);
        }
        return [];
    }
}

/**
 * Upload media to Twitter
 * @param mediaPath Path to media file
 * @returns Media ID string or null if failed
 */
export async function uploadMedia(mediaPath: string): Promise<string | null> {
    logger.info(`[🐦 Upload] Starting media upload for: ${mediaPath}`);

    try {
        if (!fs.existsSync(mediaPath)) {
            logger.error(`[🐦 Upload] File not found: ${mediaPath}`);
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

        logger.debug(`[🐦 Upload] Uploading with mime type: ${mimeType}`);

        // Upload using v1.1 API
        const mediaId = await twitterClient.v1.uploadMedia(mediaPath, { mimeType });

        logger.info(`[🐦 Upload] ✅ Media uploaded successfully. Media ID: ${mediaId}`);
        return mediaId;

    } catch (error: any) {
        logger.error('[🐦 Upload] ❌ Media upload failed:', error);
        if (error.code) {
            logger.error(`[🐦 Upload] Twitter Error Code: ${error.code}, Message: ${error.message}`);
        }
        return null;
    }
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
    logger.info(`[🐦 Reply] Posting reply to tweet ID: ${replyToTweetId}`);
    logger.info(`[🐦 Reply] Reply text: "${tweetText}"`);

    try {
        // Upload media if provided
        let mediaId: string | null = null;
        if (mediaPath) {
            logger.info(`[🐦 Reply] Uploading media: ${mediaPath}`);
            mediaId = await uploadMedia(mediaPath);
            if (!mediaId) {
                logger.error('[🐦 Reply] ❌ Failed to upload media');
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

        // Post tweet
        logger.info(`[🐦 Reply] Posting tweet...`);
        const result = await rwClient.v2.tweet(tweetPayload);

        if (result.data?.id) {
            logger.info(`[🐦 Reply] ✅ Reply posted successfully! Tweet ID: ${result.data.id}`);
            return true;
        } else {
            logger.error('[🐦 Reply] ❌ No tweet ID in response', result.errors);
            return false;
        }

    } catch (error: any) {
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
        // Get the mention tweet to find its parent
        const mentionTweet = await rwClient.v2.singleTweet(mentionId, {
            'tweet.fields': 'referenced_tweets',
            expansions: 'referenced_tweets.id',
        });

        const parentRef = mentionTweet.data.referenced_tweets?.find((ref: any) => ref.type === 'replied_to');
        if (!parentRef) {
            logger.debug(`[🐦 Video Fetch] Mention ${mentionId} has no parent tweet`);
            return {};
        }

        const parentTweetId = parentRef.id;

        // Check cache first
        const cached = parentTweetVideoCache.get(parentTweetId);
        const now = Date.now();

        if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
            logger.debug(`[🐦 Video Fetch] Using cached video for parent tweet ${parentTweetId}`);
            return { videoUrl: cached.videoUrl, parentTweetId };
        }

        // Fetch parent tweet with media
        logger.info(`[🐦 Video Fetch] Fetching video from parent tweet ${parentTweetId}...`);
        const parentTweetData = await rwClient.v2.singleTweet(parentTweetId, {
            'tweet.fields': 'attachments',
            expansions: 'attachments.media_keys',
            'media.fields': 'type,url,variants,duration_ms'
        });

        let videoUrl: string | undefined;

        if (parentTweetData.includes?.media && parentTweetData.includes.media.length > 0) {
            for (const media of parentTweetData.includes.media) {
                if (media.type === 'video') {
                    const videoVariants = media.variants || [];

                    // Get highest bitrate video variant
                    if (videoVariants.length > 0) {
                        const bestVariant = videoVariants
                            .filter((v: any) => v.content_type === 'video/mp4')
                            .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];

                        if (bestVariant) {
                            videoUrl = bestVariant.url;
                            logger.info(`[🐦 Video Fetch] ✅ Found video: ${videoUrl}`);
                        }
                    }
                    break;
                }
            }
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
