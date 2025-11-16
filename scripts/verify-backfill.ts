#!/usr/bin/env tsx
/**
 * Verify the backfill worked - check a sample of mentions
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function verifyBackfill() {
    logger.info('[Verify] Checking backfill results...');

    // Get sample of recent mentions
    const { data: mentions, error } = await supabase
        .from('mentions')
        .select('tweet_id, source_language, target_language, parent_tweet_url, parent_tweet_text')
        .order('created_at', { ascending: false })
        .limit(10);

    if (error) {
        logger.error('[Verify] Error:', error);
        return;
    }

    logger.info(`\n[Verify] Sample of 10 most recent mentions:\n`);

    let completeCount = 0;
    let missingLanguages = 0;
    let missingParent = 0;

    mentions?.forEach((m, i) => {
        const hasLanguages = m.source_language && m.target_language;
        const hasParent = m.parent_tweet_url && m.parent_tweet_text;
        const isComplete = hasLanguages && hasParent;

        if (isComplete) completeCount++;
        if (!hasLanguages) missingLanguages++;
        if (!hasParent) missingParent++;

        logger.info(`${i + 1}. Tweet ${m.tweet_id}`);
        logger.info(`   Languages: ${m.source_language || 'MISSING'} → ${m.target_language || 'MISSING'}`);
        logger.info(`   Parent URL: ${m.parent_tweet_url ? '✅' : '❌'}`);
        logger.info(`   Parent Text: ${m.parent_tweet_text ? '✅' : '❌'}`);
        logger.info(`   Status: ${isComplete ? '✅ COMPLETE' : '⚠️ INCOMPLETE'}\n`);
    });

    logger.info('========================================');
    logger.info(`Complete (all fields): ${completeCount}/10`);
    logger.info(`Missing languages: ${missingLanguages}/10`);
    logger.info(`Missing parent data: ${missingParent}/10`);
    logger.info('========================================');
}

verifyBackfill()
    .then(() => process.exit(0))
    .catch((error) => {
        logger.error('[Verify] Error:', error);
        process.exit(1);
    });
