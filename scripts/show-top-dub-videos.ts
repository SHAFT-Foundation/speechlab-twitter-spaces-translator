#!/usr/bin/env tsx
/**
 * Show Top Dubbed Videos
 *
 * Displays the top dubbed videos ranked by view count
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../src/utils/config';
import logger from '../src/utils/logger';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

async function showTopDubVideos() {
    try {
        const limit = parseInt(process.argv[2] || '20', 10);

        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║          TOP DUBBED VIDEOS BY VIEW COUNT                  ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        const { data: topVideos, error } = await supabase.rpc('get_top_dub_replies', {
            result_limit: limit
        });

        if (error) {
            console.error('Error fetching top videos:', error);
            return;
        }

        if (!topVideos || topVideos.length === 0) {
            console.log('No dub reply metrics found. Run backfill first:');
            console.log('  npx tsx scripts/backfill-dub-reply-views.ts');
            return;
        }

        console.log(`Showing top ${topVideos.length} dubbed videos:\n`);

        topVideos.forEach((video: any, index: number) => {
            const rank = index + 1;
            const views = video.impression_count.toLocaleString();
            const likes = video.like_count.toLocaleString();
            const retweets = video.retweet_count.toLocaleString();
            const replies = video.reply_count.toLocaleString();

            console.log(`${rank}. 👁️  ${views} views | ❤️  ${likes} | 🔁 ${retweets} | 💬 ${replies}`);
            console.log(`   @${video.username} → ${video.target_language || 'unknown'}`);
            console.log(`   🔗 ${video.dub_reply_tweet_url || 'https://twitter.com/i/status/' + video.tweet_id}`);

            if (video.parent_tweet_text) {
                const preview = video.parent_tweet_text.substring(0, 80);
                console.log(`   📝 Original: "${preview}${video.parent_tweet_text.length > 80 ? '...' : ''}"`);
            }

            if (video.sharing_link) {
                console.log(`   🎥 ElevenLabs: ${video.sharing_link}`);
            }

            console.log(`   📊 Last updated: ${new Date(video.collected_at).toLocaleString()}`);
            console.log('');
        });

        console.log('═'.repeat(60));
        console.log(`Total videos tracked: ${topVideos.length}`);
        console.log(`Total views: ${topVideos.reduce((sum: number, v: any) => sum + parseInt(v.impression_count), 0).toLocaleString()}`);
        console.log(`Total engagement: ${topVideos.reduce((sum: number, v: any) =>
            sum + parseInt(v.like_count) + parseInt(v.retweet_count) + parseInt(v.reply_count), 0).toLocaleString()}`);
        console.log('═'.repeat(60));

        console.log('\n💡 Tips:');
        console.log('  • Run metrics daemon to keep data fresh: npx tsx src/metricsDaemon.ts');
        console.log('  • Export to JSON: npx tsx scripts/export-top-videos.ts');
        console.log('  • Specify limit: npx tsx scripts/show-top-dub-videos.ts 50');

    } catch (error) {
        logger.error('Error:', error);
        process.exit(1);
    }
}

showTopDubVideos()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });
