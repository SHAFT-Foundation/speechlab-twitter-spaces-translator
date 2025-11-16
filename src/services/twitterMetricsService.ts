/**
 * Twitter Metrics Service
 * Collects public metrics (views, likes, retweets) from Twitter API
 */

import { TwitterApi } from 'twitter-api-v2';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { getSupabase } from './supabaseService';

const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});

const rwClient = twitterClient.readWrite;

export interface TweetMetrics {
    tweet_id: string;
    impression_count: number;
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
}

/**
 * Fetch public metrics for a single tweet
 */
export async function fetchTweetMetrics(tweetId: string): Promise<TweetMetrics | null> {
    try {
        const tweet = await rwClient.v2.singleTweet(tweetId, {
            'tweet.fields': 'public_metrics'
        });

        if (!tweet.data || !tweet.data.public_metrics) {
            logger.warn(`[📊 Metrics] No public metrics available for tweet ${tweetId}`);
            return null;
        }

        const metrics = tweet.data.public_metrics;

        return {
            tweet_id: tweetId,
            impression_count: metrics.impression_count || 0,
            like_count: metrics.like_count || 0,
            reply_count: metrics.reply_count || 0,
            retweet_count: metrics.retweet_count || 0,
            quote_count: metrics.quote_count || 0
        };
    } catch (error: any) {
        if (error.code === 429) {
            logger.warn('[📊 Metrics] Rate limited fetching tweet metrics');
            throw error;
        }
        logger.error(`[📊 Metrics] Error fetching metrics for tweet ${tweetId}:`, error);
        return null;
    }
}

/**
 * Fetch metrics for multiple tweets (batch)
 */
export async function fetchTweetMetricsBatch(tweetIds: string[]): Promise<Map<string, TweetMetrics>> {
    const results = new Map<string, TweetMetrics>();

    if (tweetIds.length === 0) {
        return results;
    }

    try {
        // Twitter API allows up to 100 tweets per request
        const batchSize = 100;
        for (let i = 0; i < tweetIds.length; i += batchSize) {
            const batch = tweetIds.slice(i, i + batchSize);

            const tweets = await rwClient.v2.tweets(batch, {
                'tweet.fields': 'public_metrics'
            });

            if (tweets.data) {
                for (const tweet of tweets.data) {
                    if (tweet.public_metrics) {
                        results.set(tweet.id, {
                            tweet_id: tweet.id,
                            impression_count: tweet.public_metrics.impression_count || 0,
                            like_count: tweet.public_metrics.like_count || 0,
                            reply_count: tweet.public_metrics.reply_count || 0,
                            retweet_count: tweet.public_metrics.retweet_count || 0,
                            quote_count: tweet.public_metrics.quote_count || 0
                        });
                    }
                }
            }

            // Rate limit: 300 requests per 15 min = 1 per 3 seconds
            if (i + batchSize < tweetIds.length) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        logger.info(`[📊 Metrics] Fetched metrics for ${results.size}/${tweetIds.length} tweets`);
    } catch (error: any) {
        if (error.code === 429) {
            logger.warn('[📊 Metrics] Rate limited fetching batch metrics');
        } else {
            logger.error('[📊 Metrics] Error fetching batch metrics:', error);
        }
    }

    return results;
}

/**
 * Save tweet metrics to database
 */
export async function saveTweetMetrics(
    metrics: TweetMetrics,
    tweetType: 'mention' | 'dub_reply' | 'parent' | 'sibling_comment',
    mentionId?: string
): Promise<boolean> {
    try {
        const supabase = getSupabase();

        const { error } = await supabase
            .from('tweet_metrics')
            .insert({
                tweet_id: metrics.tweet_id,
                tweet_type: tweetType,
                mention_id: mentionId,
                impression_count: metrics.impression_count,
                like_count: metrics.like_count,
                reply_count: metrics.reply_count,
                retweet_count: metrics.retweet_count,
                quote_count: metrics.quote_count,
                collected_at: new Date().toISOString()
            });

        if (error) {
            logger.error(`[📊 Metrics] Error saving metrics for ${metrics.tweet_id}:`, error);
            return false;
        }

        logger.debug(`[📊 Metrics] Saved ${tweetType} metrics for ${metrics.tweet_id}: ${metrics.impression_count} views`);
        return true;
    } catch (error) {
        logger.error('[📊 Metrics] Error saving metrics:', error);
        return false;
    }
}

/**
 * Collect metrics for a completed mention (mention + dub reply + parent)
 */
export async function collectMentionMetrics(mentionTweetId: string): Promise<boolean> {
    try {
        const supabase = getSupabase();

        // Get mention record
        const { data: mention, error } = await supabase
            .from('mentions')
            .select('tweet_id, dub_reply_tweet_id, parent_tweet_url')
            .eq('tweet_id', mentionTweetId)
            .single();

        if (error || !mention) {
            logger.error(`[📊 Metrics] Mention ${mentionTweetId} not found`);
            return false;
        }

        const tweetIds: string[] = [mention.tweet_id];

        // Add dub reply tweet if exists
        if (mention.dub_reply_tweet_id) {
            tweetIds.push(mention.dub_reply_tweet_id);
        }

        // Add parent tweet if exists
        if (mention.parent_tweet_url) {
            const parentIdMatch = mention.parent_tweet_url.match(/status\/(\d+)/);
            if (parentIdMatch) {
                tweetIds.push(parentIdMatch[1]);
            }
        }

        // Fetch all metrics
        const metricsMap = await fetchTweetMetricsBatch(tweetIds);

        // Save mention metrics
        const mentionMetrics = metricsMap.get(mention.tweet_id);
        if (mentionMetrics) {
            await saveTweetMetrics(mentionMetrics, 'mention', mention.tweet_id);
        }

        // Save dub reply metrics
        if (mention.dub_reply_tweet_id) {
            const dubMetrics = metricsMap.get(mention.dub_reply_tweet_id);
            if (dubMetrics) {
                await saveTweetMetrics(dubMetrics, 'dub_reply', mention.tweet_id);
            }
        }

        // Save parent metrics
        if (mention.parent_tweet_url) {
            const parentIdMatch = mention.parent_tweet_url.match(/status\/(\d+)/);
            if (parentIdMatch) {
                const parentMetrics = metricsMap.get(parentIdMatch[1]);
                if (parentMetrics) {
                    await saveTweetMetrics(parentMetrics, 'parent', mention.tweet_id);
                }
            }
        }

        logger.info(`[📊 Metrics] Collected metrics for mention ${mentionTweetId} and related tweets`);
        return true;
    } catch (error) {
        logger.error(`[📊 Metrics] Error collecting mention metrics:`, error);
        return false;
    }
}

/**
 * Collect metrics for sibling comments (other replies to parent tweet)
 * Used to compare our dub reply performance vs other comments
 */
export async function collectSiblingCommentMetrics(
    parentTweetUrl: string,
    mentionId: string,
    sampleSize: number = 10
): Promise<number> {
    try {
        const parentIdMatch = parentTweetUrl.match(/status\/(\d+)/);
        if (!parentIdMatch) {
            return 0;
        }

        const parentTweetId = parentIdMatch[1];

        // Search for replies to the parent tweet
        const searchQuery = `conversation_id:${parentTweetId}`;

        const replies = await rwClient.v2.search(searchQuery, {
            'tweet.fields': 'public_metrics,author_id',
            max_results: Math.min(sampleSize + 5, 100) // Get a few extra to filter out ours
        });

        if (!replies.data || replies.data.data.length === 0) {
            logger.warn(`[📊 Metrics] No replies found for parent tweet ${parentTweetId}`);
            return 0;
        }

        let savedCount = 0;

        // Save metrics for sibling comments (excluding our own bot replies)
        for (const reply of replies.data.data.slice(0, sampleSize)) {
            if (reply.public_metrics) {
                const metrics: TweetMetrics = {
                    tweet_id: reply.id,
                    impression_count: reply.public_metrics.impression_count || 0,
                    like_count: reply.public_metrics.like_count || 0,
                    reply_count: reply.public_metrics.reply_count || 0,
                    retweet_count: reply.public_metrics.retweet_count || 0,
                    quote_count: reply.public_metrics.quote_count || 0
                };

                await saveTweetMetrics(metrics, 'sibling_comment', mentionId);
                savedCount++;
            }
        }

        logger.info(`[📊 Metrics] Collected ${savedCount} sibling comment metrics for comparison`);
        return savedCount;
    } catch (error: any) {
        if (error.code === 429) {
            logger.warn('[📊 Metrics] Rate limited collecting sibling comments');
        } else {
            logger.error('[📊 Metrics] Error collecting sibling comment metrics:', error);
        }
        return 0;
    }
}
