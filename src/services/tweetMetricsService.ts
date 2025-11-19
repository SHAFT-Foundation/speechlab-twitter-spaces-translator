/**
 * Tweet Metrics Service
 * Fetches and stores engagement metrics (views, likes, retweets) for tweets
 */

import { TwitterApi } from 'twitter-api-v2';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});

const rwClient = twitterClient.readWrite;

export interface TweetMetrics {
    tweetId: string;
    tweetType: 'mention' | 'dub_reply' | 'parent' | 'sibling_comment';
    mentionId?: string;
    impressionCount: number;
    likeCount: number;
    replyCount: number;
    retweetCount: number;
    quoteCount: number;
    collectedAt: Date;
}

/**
 * Fetch tweet metrics from Twitter API v2
 */
export async function fetchTweetMetrics(tweetId: string): Promise<TweetMetrics | null> {
    try {
        logger.info(`[📊 Metrics] Fetching metrics for tweet ${tweetId}...`);

        const tweet = await rwClient.v2.singleTweet(tweetId, {
            'tweet.fields': 'public_metrics',
        });

        if (!tweet.data) {
            logger.warn(`[📊 Metrics] Tweet ${tweetId} not found`);
            return null;
        }

        const metrics = tweet.data.public_metrics;
        if (!metrics) {
            logger.warn(`[📊 Metrics] No metrics available for tweet ${tweetId}`);
            return null;
        }

        logger.info(`[📊 Metrics] ✅ Fetched metrics for ${tweetId}: ${metrics.impression_count || 0} views`);

        return {
            tweetId,
            tweetType: 'dub_reply', // Default, will be overridden by caller
            impressionCount: metrics.impression_count || 0,
            likeCount: metrics.like_count || 0,
            replyCount: metrics.reply_count || 0,
            retweetCount: metrics.retweet_count || 0,
            quoteCount: metrics.quote_count || 0,
            collectedAt: new Date(),
        };
    } catch (error: any) {
        if (error.code === 429) {
            logger.error('[📊 Metrics] Rate limited! Waiting...');
            throw error;
        }
        logger.error(`[📊 Metrics] Error fetching metrics for ${tweetId}:`, error);
        return null;
    }
}

/**
 * Save tweet metrics to database
 */
export async function saveTweetMetrics(metrics: TweetMetrics): Promise<void> {
    try {
        const { error } = await supabase
            .from('tweet_metrics')
            .insert({
                tweet_id: metrics.tweetId,
                tweet_type: metrics.tweetType,
                mention_id: metrics.mentionId,
                impression_count: metrics.impressionCount,
                like_count: metrics.likeCount,
                reply_count: metrics.replyCount,
                retweet_count: metrics.retweetCount,
                quote_count: metrics.quoteCount,
                collected_at: metrics.collectedAt.toISOString(),
            });

        if (error) {
            logger.error(`[📊 Metrics] Error saving metrics for ${metrics.tweetId}:`, error);
            throw error;
        }

        logger.info(`[📊 Metrics] ✅ Saved metrics for ${metrics.tweetId}`);
    } catch (error) {
        logger.error(`[📊 Metrics] Failed to save metrics:`, error);
        throw error;
    }
}

/**
 * Fetch and save metrics for a dub reply tweet
 */
export async function trackDubReplyMetrics(
    dubReplyTweetId: string,
    mentionId: string
): Promise<void> {
    try {
        const metrics = await fetchTweetMetrics(dubReplyTweetId);
        if (!metrics) {
            logger.warn(`[📊 Metrics] Could not fetch metrics for dub reply ${dubReplyTweetId}`);
            return;
        }

        metrics.tweetType = 'dub_reply';
        metrics.mentionId = mentionId;

        await saveTweetMetrics(metrics);
    } catch (error) {
        logger.error(`[📊 Metrics] Error tracking dub reply ${dubReplyTweetId}:`, error);
        throw error;
    }
}

/**
 * Get latest metrics for a tweet from database
 */
export async function getLatestMetrics(tweetId: string): Promise<TweetMetrics | null> {
    try {
        const { data, error } = await supabase
            .from('tweet_metrics')
            .select('*')
            .eq('tweet_id', tweetId)
            .order('collected_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) {
            return null;
        }

        return {
            tweetId: data.tweet_id,
            tweetType: data.tweet_type,
            mentionId: data.mention_id,
            impressionCount: data.impression_count,
            likeCount: data.like_count,
            replyCount: data.reply_count,
            retweetCount: data.retweet_count,
            quoteCount: data.quote_count,
            collectedAt: new Date(data.collected_at),
        };
    } catch (error) {
        logger.error(`[📊 Metrics] Error fetching latest metrics for ${tweetId}:`, error);
        return null;
    }
}

/**
 * Get top viewed dub replies
 */
export async function getTopDubReplies(limit: number = 20): Promise<any[]> {
    try {
        // Get latest metrics for each dub reply
        const { data, error } = await supabase.rpc('get_top_dub_replies', {
            result_limit: limit
        });

        if (error) {
            logger.error('[📊 Metrics] Error fetching top dub replies:', error);
            return [];
        }

        return data || [];
    } catch (error) {
        logger.error('[📊 Metrics] Error in getTopDubReplies:', error);
        return [];
    }
}
