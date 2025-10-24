/**
 * Migration script to add retry_count column to mentions table
 * Run with: npx ts-node scripts/run-migration.ts
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

async function runMigration() {
    logger.info('[Migration] Starting migration to add retry_count column...');

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    try {
        // Check if column already exists
        logger.info('[Migration] Checking if retry_count column already exists...');
        const { data: existingColumns, error: checkError } = await supabase
            .from('mentions')
            .select('retry_count')
            .limit(1);

        if (!checkError) {
            logger.info('[Migration] ✅ Column retry_count already exists. Skipping migration.');
            return;
        }

        // Column doesn't exist, add it
        logger.info('[Migration] Adding retry_count column...');

        // Use raw SQL to add the column
        const { error: alterError } = await supabase.rpc('exec_sql', {
            sql: 'ALTER TABLE mentions ADD COLUMN retry_count INTEGER DEFAULT 0;'
        });

        if (alterError) {
            // If rpc function doesn't exist, try direct SQL execution
            logger.warn('[Migration] RPC method failed, trying alternative approach...');
            logger.error('[Migration] Error:', alterError);

            logger.info('[Migration] Please run this SQL manually in Supabase SQL Editor:');
            logger.info('');
            logger.info('ALTER TABLE mentions ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;');
            logger.info('');
            logger.info('CREATE INDEX IF NOT EXISTS idx_mentions_retry_count ON mentions(retry_count)');
            logger.info('WHERE status IN (\'failed\', \'initiating\', \'processing\');');
            logger.info('');

            throw new Error('Manual SQL execution required. See logs above.');
        }

        logger.info('[Migration] ✅ Successfully added retry_count column!');
        logger.info('[Migration] Creating index...');

        // Create index
        const { error: indexError } = await supabase.rpc('exec_sql', {
            sql: `CREATE INDEX IF NOT EXISTS idx_mentions_retry_count ON mentions(retry_count)
                  WHERE status IN ('failed', 'initiating', 'processing');`
        });

        if (indexError) {
            logger.warn('[Migration] Failed to create index:', indexError);
            logger.info('[Migration] You may want to create it manually for better performance.');
        } else {
            logger.info('[Migration] ✅ Successfully created index!');
        }

        logger.info('[Migration] 🎉 Migration completed successfully!');

    } catch (error) {
        logger.error('[Migration] ❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run the migration
runMigration()
    .then(() => {
        logger.info('[Migration] Done.');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[Migration] Fatal error:', error);
        process.exit(1);
    });
