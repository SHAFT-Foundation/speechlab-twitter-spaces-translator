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
    status: 'pending' | 'initiating' | 'processing' | 'complete' | 'failed' | 'final_failure';
    retry_count?: number;
    third_party_id?: string;
    project_id?: string;
    m3u8_url?: string;
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
                status: mention.status,
                retry_count: mention.retry_count,
                third_party_id: mention.third_party_id,
                project_id: mention.project_id,
                m3u8_url: mention.m3u8_url,
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
 */
export async function getUnprocessedMentions(): Promise<MentionRecord[]> {
    try {
        const supabase = getSupabase();

        const { data, error} = await supabase
            .from('mentions')
            .select('*')
            .in('status', ['pending', 'failed', 'initiating', 'processing'])
            .lt('retry_count', 3)
            .order('created_at', { ascending: true });

        if (error) {
            logger.error(`[📊 Supabase] Error fetching unprocessed mentions:`, error);
            return [];
        }

        return data || [];
    } catch (error) {
        logger.error(`[📊 Supabase] Exception fetching unprocessed mentions:`, error);
        return [];
    }
}
