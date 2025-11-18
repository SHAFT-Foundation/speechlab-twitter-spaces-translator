import { createClient, SupabaseClient } from '@supabase/supabase-js';
import logger from '../utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

let supabase: SupabaseClient | null = null;

/**
 * Initialize Supabase client
 */
export function initSupabase(): SupabaseClient {
    if (!supabase) {
        supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        logger.info('[📊 Supabase] Client initialized');
    }
    return supabase;
}

/**
 * Get Supabase client instance
 */
export function getSupabase(): SupabaseClient {
    if (!supabase) {
        return initSupabase();
    }
    return supabase;
}

export interface MentionRecord {
    tweet_id: string;
    username: string;
    parent_username?: string;
    tweet_url: string;
    tweet_text: string;
    parent_tweet_url?: string;
    parent_tweet_text?: string;
    parent_tweet_text_translated?: string;
    parent_tweet_category?: string;
    parent_tweet_category_id?: string;
    parent_tweet_domains?: any;
    custom_category?: string[];
    twitter_profile_image_url?: string;
    dub_reply_tweet_id?: string;
    dub_reply_tweet_url?: string;
    status: 'pending' | 'initiating' | 'processing' | 'complete' | 'failed' | 'final_failure' | 'skipped_no_video';
    retry_count?: number;
    third_party_id?: string;
    project_id?: string;
    m3u8_url?: string;
    content_type?: 'space' | 'video' | 'unknown';
    source_language?: string;
    target_language?: string;
    sharing_link?: string;
    public_video_url?: string;
    public_mp3_url?: string;
    error_message?: string;
    created_at?: string;
    updated_at?: string;
}

/**
 * Detect content type from M3U8 URL
 * Twitter Spaces URLs contain 'dynamic_playlist' or 'prod/dynamic_playlist'
 * Video URLs contain 'amplify_video' or 'ext_tw_video'
 */
export function detectContentType(m3u8Url?: string): 'space' | 'video' | 'unknown' {
    if (!m3u8Url) {
        return 'unknown';
    }

    // Twitter Spaces patterns
    if (m3u8Url.includes('dynamic_playlist') || m3u8Url.includes('prod/dynamic_playlist')) {
        return 'space';
    }

    // Twitter Video patterns
    if (m3u8Url.includes('amplify_video') || m3u8Url.includes('ext_tw_video') || m3u8Url.includes('video')) {
        return 'video';
    }

    return 'unknown';
}

/**
 * Map Twitter domains to custom categories
 */
export async function mapDomainsToCategories(domains: any[]): Promise<string[]> {
    try {
        if (!domains || domains.length === 0) {
            return [];
        }

        const supabase = getSupabase();
        const twitterCategories = domains
            .filter(d => d.domain_name)
            .map(d => d.domain_name);

        if (twitterCategories.length === 0) {
            return [];
        }

        // Look up mappings for all Twitter categories
        const { data: mappings, error } = await supabase
            .from('category_mappings')
            .select('custom_category')
            .in('twitter_category', twitterCategories);

        if (error || !mappings || mappings.length === 0) {
            return [];
        }

        // Get unique custom categories
        const customCategories = [...new Set(mappings.map(m => m.custom_category))];
        return customCategories;
    } catch (error) {
        logger.error('[📊 Supabase] Error mapping domains to categories:', error);
        return [];
    }
}

/**
 * Create or update a mention record in Supabase
 */
export async function upsertMention(mention: MentionRecord): Promise<boolean> {
    try {
        const supabase = getSupabase();

        const { error } = await supabase
            .from('mentions')
            .upsert({
                tweet_id: mention.tweet_id,
                username: mention.username,
                parent_username: mention.parent_username,
                tweet_url: mention.tweet_url,
                tweet_text: mention.tweet_text,
                parent_tweet_url: mention.parent_tweet_url,
                parent_tweet_text: mention.parent_tweet_text,
                parent_tweet_text_translated: mention.parent_tweet_text_translated,
                parent_tweet_category: mention.parent_tweet_category,
                parent_tweet_category_id: mention.parent_tweet_category_id,
                parent_tweet_domains: mention.parent_tweet_domains,
                custom_category: mention.custom_category,
                twitter_profile_image_url: mention.twitter_profile_image_url,
                status: mention.status,
                retry_count: mention.retry_count,
                third_party_id: mention.third_party_id,
                project_id: mention.project_id,
                m3u8_url: mention.m3u8_url,
                content_type: mention.content_type || detectContentType(mention.m3u8_url),
                source_language: mention.source_language,
                target_language: mention.target_language,
                sharing_link: mention.sharing_link,
                public_video_url: mention.public_video_url,
                public_mp3_url: mention.public_mp3_url,
                error_message: mention.error_message,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'tweet_id'
            });

        if (error) {
            // Don't log error if table doesn't exist - just silently fail
            if (error.message && !error.message.includes('table') && !error.message.includes('schema')) {
                logger.error(`[📊 Supabase] Error upserting mention ${mention.tweet_id}:`, error);
            }
            return false;
        }

        logger.debug(`[📊 Supabase] Mention ${mention.tweet_id} upserted successfully with status: ${mention.status}`);
        return true;
    } catch (error) {
        logger.error(`[📊 Supabase] Exception upserting mention:`, error);
        return false;
    }
}

/**
 * Update mention status
 */
export async function updateMentionStatus(
    tweetId: string,
    status: MentionRecord['status'],
    additionalData?: Partial<MentionRecord>
): Promise<boolean> {
    try {
        const supabase = getSupabase();

        const updateData: any = {
            status,
            updated_at: new Date().toISOString(),
            ...additionalData
        };

        const { error } = await supabase
            .from('mentions')
            .update(updateData)
            .eq('tweet_id', tweetId);

        if (error) {
            // Don't log error if table doesn't exist
            if (error.message && !error.message.includes('table') && !error.message.includes('schema')) {
                logger.error(`[📊 Supabase] Error updating status for ${tweetId}:`, error);
            }
            return false;
        }

        logger.info(`[📊 Supabase] Mention ${tweetId} status updated to: ${status}`);
        return true;
    } catch (error) {
        logger.error(`[📊 Supabase] Exception updating mention status:`, error);
        return false;
    }
}

/**
 * Get mention by tweet ID
 */
export async function getMention(tweetId: string): Promise<MentionRecord | null> {
    try {
        const supabase = getSupabase();

        const { data, error } = await supabase
            .from('mentions')
            .select('*')
            .eq('tweet_id', tweetId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                // Not found
                return null;
            }
            logger.error(`[📊 Supabase] Error fetching mention ${tweetId}:`, error);
            return null;
        }

        return data as MentionRecord;
    } catch (error) {
        logger.error(`[📊 Supabase] Exception fetching mention:`, error);
        return null;
    }
}

/**
 * Get all processed mentions (to populate local cache on startup)
 */
export async function getAllProcessedMentions(): Promise<Set<string>> {
    try {
        const supabase = getSupabase();

        const { data, error } = await supabase
            .from('mentions')
            .select('tweet_id')
            .in('status', ['complete', 'final_failure']);

        if (error) {
            logger.error(`[📊 Supabase] Error fetching processed mentions:`, error);
            return new Set();
        }

        const tweetIds = new Set(data.map((row: any) => row.tweet_id));
        logger.info(`[📊 Supabase] Loaded ${tweetIds.size} processed mentions from database`);
        return tweetIds;
    } catch (error) {
        logger.error(`[📊 Supabase] Exception fetching processed mentions:`, error);
        return new Set();
    }
}

/**
 * Get mentions stuck in 'initiating', 'processing', or 'failed' status (with retry limit)
 */
export async function getStuckMentions(): Promise<MentionRecord[]> {
    try {
        const supabase = getSupabase();

        const { data, error } = await supabase
            .from('mentions')
            .select('tweet_id, tweet_url, status, updated_at, tweet_text, username, retry_count')
            .in('status', ['initiating', 'processing', 'failed'])
            .order('updated_at', { ascending: true });

        if (error) {
            logger.error(`[📊 Supabase] Error fetching stuck mentions:`, error);
            return [];
        }

        return data || [];
    } catch (error) {
        logger.error(`[📊 Supabase] Exception fetching stuck mentions:`, error);
        return [];
    }
}

/**
 * Get all unprocessed mentions (pending, failed, initiating, processing) with retry_count < 3
 * Only returns mentions created within the last 6 hours to avoid processing stale mentions
 */
/**
 * Get processing mentions that have video/audio URLs ready (regardless of age)
 * These are ready to be posted as replies
 */
export async function getProcessingMentionsWithMedia(): Promise<MentionRecord[]> {
    try {
        const supabase = getSupabase();

        logger.info(`[📊 Supabase] Querying processing mentions with media URLs ready...`);

        const { data, error } = await supabase
            .from('mentions')
            .select('*')
            .eq('status', 'processing')
            .or('public_video_url.not.is.null,public_mp3_url.not.is.null')
            .order('created_at', { ascending: true });

        if (error) {
            logger.error(`[📊 Supabase] Error fetching processing mentions with media:`, error);
            return [];
        }

        logger.info(`[📊 Supabase] Found ${data?.length || 0} processing mentions with media ready`);
        return data || [];
    } catch (error) {
        logger.error(`[📊 Supabase] Exception in getProcessingMentionsWithMedia:`, error);
        return [];
    }
}

export async function getUnprocessedMentions(): Promise<MentionRecord[]> {
    try {
        const supabase = getSupabase();

        // Calculate 6 hours ago timestamp
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

        logger.info(`[📊 Supabase] Querying mentions created after: ${sixHoursAgo}`);
        logger.info(`[📊 Supabase] Current time: ${new Date().toISOString()}`);

        const { data, error} = await supabase
            .from('mentions')
            .select('*')
            .in('status', ['pending', 'failed', 'initiating'])  // Removed 'processing' - handled separately
            .gte('created_at', sixHoursAgo)  // Only mentions < 6 hours old
            .order('created_at', { ascending: true });

        if (error) {
            logger.error(`[📊 Supabase] Error fetching unprocessed mentions:`, error);
            return [];
        }

        logger.info(`[📊 Supabase] Raw query returned ${data?.length || 0} mentions in last 6 hours`);

        // Log details for debugging
        if (data && data.length > 0) {
            logger.debug(`[📊 Supabase] Status breakdown:`);
            const statusCounts: Record<string, number> = {};
            data.forEach(m => {
                statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
            });
            Object.entries(statusCounts).forEach(([status, count]) => {
                logger.debug(`[📊 Supabase]   ${status}: ${count}`);
            });
        }

        // Filter by retry_count in memory (handles NULL as 0)
        const filtered = (data || []).filter(m => (m.retry_count || 0) < 3);

        logger.info(`[📊 Supabase] After retry_count filter: ${filtered.length} mentions (retry_count < 3)`);

        if (filtered.length > 0) {
            logger.info(`[📊 Supabase] Sample mentions to process:`);
            filtered.slice(0, 3).forEach(m => {
                logger.info(`[📊 Supabase]   - ${m.tweet_id}: status=${m.status}, retry=${m.retry_count || 0}, age=${Math.floor((Date.now() - new Date(m.created_at as string).getTime()) / 60000)}min`);
            });
        }

        return filtered;
    } catch (error) {
        logger.error(`[📊 Supabase] Exception fetching unprocessed mentions:`, error);
        return [];
    }
}
