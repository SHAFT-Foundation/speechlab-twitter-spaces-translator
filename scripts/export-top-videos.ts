#!/usr/bin/env tsx
/**
 * Export Top Videos to JSON/CSV
 *
 * Exports top dubbed videos data for analytics or sharing
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../src/utils/config';
import logger from '../src/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

async function exportTopVideos() {
    try {
        const format = process.argv[2] || 'json'; // json or csv
        const limit = parseInt(process.argv[3] || '100', 10);

        console.log(`\n📊 Exporting top ${limit} videos to ${format.toUpperCase()}...\n`);

        const { data: topVideos, error } = await supabase.rpc('get_top_dub_replies', {
            result_limit: limit
        });

        if (error) {
            console.error('Error fetching top videos:', error);
            return;
        }

        if (!topVideos || topVideos.length === 0) {
            console.log('No data to export');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
        const outputDir = path.join(process.cwd(), 'exports');

        // Create exports directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        if (format === 'json') {
            const outputFile = path.join(outputDir, `top-dub-videos-${timestamp}.json`);
            fs.writeFileSync(outputFile, JSON.stringify(topVideos, null, 2));
            console.log(`✅ Exported to: ${outputFile}`);
        } else if (format === 'csv') {
            const outputFile = path.join(outputDir, `top-dub-videos-${timestamp}.csv`);

            // CSV headers
            const headers = [
                'Rank',
                'Views',
                'Likes',
                'Retweets',
                'Replies',
                'Quotes',
                'Username',
                'Target Language',
                'Tweet URL',
                'Parent Tweet URL',
                'Parent Text',
                'ElevenLabs Link',
                'Created At',
                'Last Updated'
            ];

            const rows = topVideos.map((video: any, index: number) => [
                index + 1,
                video.impression_count,
                video.like_count,
                video.retweet_count,
                video.reply_count,
                video.quote_count,
                video.username,
                video.target_language || '',
                video.dub_reply_tweet_url || `https://twitter.com/i/status/${video.tweet_id}`,
                video.parent_tweet_url || '',
                `"${(video.parent_tweet_text || '').replace(/"/g, '""')}"`,
                video.sharing_link || '',
                video.created_at,
                video.collected_at
            ]);

            const csv = [
                headers.join(','),
                ...rows.map(row => row.join(','))
            ].join('\n');

            fs.writeFileSync(outputFile, csv);
            console.log(`✅ Exported to: ${outputFile}`);
        } else {
            console.error('Invalid format. Use "json" or "csv"');
            process.exit(1);
        }

        console.log(`\n📈 Statistics:`);
        console.log(`   Total videos: ${topVideos.length}`);
        console.log(`   Total views: ${topVideos.reduce((sum: number, v: any) => sum + parseInt(v.impression_count), 0).toLocaleString()}`);
        console.log(`   Total engagement: ${topVideos.reduce((sum: number, v: any) =>
            sum + parseInt(v.like_count) + parseInt(v.retweet_count) + parseInt(v.reply_count), 0).toLocaleString()}`);

    } catch (error) {
        logger.error('Error:', error);
        process.exit(1);
    }
}

exportTopVideos()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });
