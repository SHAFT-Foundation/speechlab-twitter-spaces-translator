#!/usr/bin/env tsx
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/utils/config';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

const tweetId = '1989058337833644094';

(async () => {
    const { data, error } = await supabase
        .from('mentions')
        .select('*')
        .eq('tweet_id', tweetId);

    if (error) {
        console.log('Error:', error);
        return;
    }

    if (!data || data.length === 0) {
        console.log('❌ Tweet not found in database');
        console.log('This tweet may not have been processed yet');
        return;
    }

    console.log('\n========================================');
    console.log('Tweet Status:');
    console.log('========================================');
    console.log(JSON.stringify(data[0], null, 2));
    console.log('========================================\n');
})();
