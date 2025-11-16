#!/usr/bin/env tsx
/**
 * Generate Detailed Verification Report
 *
 * Creates a detailed breakdown of EVERY dub with direct Twitter links
 * so you can manually verify the metrics are accurate
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface DubDetail {
    mention_tweet_id: string;
    username: string;
    parent_username: string;
    parent_tweet_url: string;
    dub_reply_tweet_id: string;
    dub_reply_tweet_url: string;
    target_language: string;
    custom_category: string[];
    created_at: string;

    // Metrics
    mention_views: number | null;
    mention_likes: number | null;
    dub_reply_views: number | null;
    dub_reply_likes: number | null;
    dub_reply_retweets: number | null;
    parent_views: number | null;
    parent_likes: number | null;

    // Calculated
    dub_to_parent_view_rate: number | null;
    metrics_collected_at: string | null;
}

async function generateVerificationReport() {
    try {
        logger.info('[🔍 Verification] Starting detailed verification report...');

        // Get all completed dubs with metrics
        const { data: dubDetails, error } = await supabase
            .from('dub_engagement_comparison')
            .select('*');

        if (error) {
            logger.error('[🔍 Verification] Error fetching dub details:', error);
            return;
        }

        if (!dubDetails || dubDetails.length === 0) {
            logger.warn('[🔍 Verification] No dubs with metrics found');
            return;
        }

        logger.info(`[🔍 Verification] Found ${dubDetails.length} dubs to verify`);

        // Also get dubs WITHOUT metrics for completeness
        const { data: allDubs } = await supabase
            .from('mentions')
            .select('tweet_id, username, parent_username, parent_tweet_url, dub_reply_tweet_id, dub_reply_tweet_url, target_language, custom_category, created_at, status')
            .eq('status', 'complete')
            .order('created_at', { ascending: false });

        const dubsWithoutMetrics = allDubs?.filter(d =>
            !dubDetails.some(dd => dd.mention_tweet_id === d.tweet_id)
        ) || [];

        // Generate HTML report
        await generateHTML(dubDetails as DubDetail[], dubsWithoutMetrics);

        logger.info('[🔍 Verification] Verification report generated successfully!');
        logger.info('[🔍 Verification] Open: reports/verification-report.html');

    } catch (error) {
        logger.error('[🔍 Verification] Fatal error:', error);
        process.exit(1);
    }
}

async function generateHTML(dubDetails: DubDetail[], dubsWithoutMetrics: any[]) {
    const totalDubs = dubDetails.length;
    const totalDubViews = dubDetails.reduce((sum, d) => sum + (d.dub_reply_views || 0), 0);
    const totalParentViews = dubDetails.reduce((sum, d) => sum + (d.parent_views || 0), 0);
    const avgDubViews = totalDubs > 0 ? Math.round(totalDubViews / totalDubs) : 0;
    const avgParentViews = totalDubs > 0 ? Math.round(totalParentViews / totalDubs) : 0;

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Dubbingagent Metrics Verification Report</title>
    <meta charset="UTF-8">
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f8fa;
            color: #14171a;
        }
        h1 {
            color: #1DA1F2;
            font-size: 2em;
            margin-bottom: 10px;
        }
        h2 {
            color: #14171a;
            margin-top: 40px;
            padding-bottom: 10px;
            border-bottom: 2px solid #1DA1F2;
        }
        .summary {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin: 20px 0;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
        }
        .stat {
            text-align: center;
        }
        .stat-number {
            font-size: 2.5em;
            font-weight: bold;
            color: #1DA1F2;
            display: block;
        }
        .stat-label {
            color: #657786;
            font-size: 0.9em;
            margin-top: 5px;
            display: block;
        }
        .alert {
            background: #fff3cd;
            border: 1px solid #ffc107;
            padding: 15px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .alert strong {
            color: #856404;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin: 20px 0;
        }
        th {
            background: #1DA1F2;
            color: white;
            padding: 15px 12px;
            text-align: left;
            font-weight: 600;
            font-size: 0.85em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid #e1e8ed;
            font-size: 0.9em;
        }
        tr:hover {
            background: #f5f8fa;
        }
        tr:last-child td {
            border-bottom: none;
        }
        .link {
            color: #1DA1F2;
            text-decoration: none;
            font-weight: 500;
        }
        .link:hover {
            text-decoration: underline;
        }
        .metric-high {
            color: #17bf63;
            font-weight: bold;
        }
        .metric-low {
            color: #657786;
        }
        .metric-zero {
            color: #e0245e;
            font-style: italic;
        }
        .categories {
            font-size: 0.85em;
            color: #657786;
        }
        .category-tag {
            background: #e1f5fe;
            padding: 2px 8px;
            border-radius: 12px;
            display: inline-block;
            margin: 2px;
            font-size: 0.85em;
        }
        .timestamp {
            color: #657786;
            font-size: 0.85em;
        }
        .no-metrics {
            background: #ffebee;
            padding: 8px;
            border-radius: 4px;
            font-size: 0.9em;
            color: #c62828;
        }
        .section-note {
            background: #e3f2fd;
            padding: 15px;
            border-left: 4px solid #1DA1F2;
            margin: 20px 0;
            border-radius: 4px;
        }
        .number-cell {
            text-align: right;
            font-variant-numeric: tabular-nums;
        }
        .footer {
            text-align: center;
            color: #657786;
            margin-top: 40px;
            padding: 20px;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <h1>🔍 Dubbingagent Metrics Verification Report</h1>
    <p class="timestamp">Generated: ${new Date().toLocaleString()}</p>

    <div class="summary">
        <div class="stat">
            <span class="stat-number">${totalDubs}</span>
            <span class="stat-label">Dubs with Metrics</span>
        </div>
        <div class="stat">
            <span class="stat-number">${totalDubViews.toLocaleString()}</span>
            <span class="stat-label">Total Dub Reply Views</span>
        </div>
        <div class="stat">
            <span class="stat-number">${avgDubViews.toLocaleString()}</span>
            <span class="stat-label">Avg Dub Reply Views</span>
        </div>
        <div class="stat">
            <span class="stat-number">${totalParentViews.toLocaleString()}</span>
            <span class="stat-label">Total Parent Views</span>
        </div>
        <div class="stat">
            <span class="stat-number">${avgParentViews.toLocaleString()}</span>
            <span class="stat-label">Avg Parent Views</span>
        </div>
    </div>

    <div class="alert">
        <strong>⚠️ Verification Instructions:</strong>
        <ol style="margin: 10px 0 0 20px;">
            <li>Click the "View Tweet" links to open each tweet on Twitter</li>
            <li>Compare the actual views shown on Twitter with the numbers in this report</li>
            <li>Note: Twitter may show slightly different numbers due to real-time updates</li>
            <li>If you see major discrepancies (>10%), the API data may be stale - run metrics collection again</li>
        </ol>
    </div>

    <h2>📋 Complete Dub List - Verify Each One</h2>

    <div class="section-note">
        <strong>How to verify on Twitter:</strong>
        <ul style="margin: 5px 0 0 20px;">
            <li><strong>Views:</strong> Look for "Views" count under the tweet (eye icon)</li>
            <li><strong>Likes:</strong> Heart icon count</li>
            <li><strong>Retweets:</strong> Retweet icon count</li>
            <li>If metrics seem wrong, click "View on Twitter" to manually check</li>
        </ul>
    </div>

    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>Created</th>
                <th>User → Parent</th>
                <th>Categories</th>
                <th>Lang</th>
                <th>Mention Views</th>
                <th>Dub Reply Views</th>
                <th>Parent Views</th>
                <th>Conv %</th>
                <th>Links</th>
            </tr>
        </thead>
        <tbody>
${dubDetails.map((dub, i) => {
    const mentionUrl = `https://twitter.com/${dub.username}/status/${dub.mention_tweet_id}`;
    const dubUrl = dub.dub_reply_tweet_url || `https://twitter.com/dubbingagent/status/${dub.dub_reply_tweet_id}`;
    const parentUrl = dub.parent_tweet_url;

    const mentionViews = dub.mention_views !== null ? dub.mention_views.toLocaleString() : '<span class="metric-zero">No data</span>';
    const dubViews = dub.dub_reply_views !== null ? dub.dub_reply_views.toLocaleString() : '<span class="metric-zero">No data</span>';
    const parentViews = dub.parent_views !== null ? dub.parent_views.toLocaleString() : '<span class="metric-zero">No data</span>';
    const convRate = dub.dub_to_parent_view_rate !== null ? `${dub.dub_to_parent_view_rate}%` : '-';

    const categories = (dub.custom_category || []).map(c => `<span class="category-tag">${c}</span>`).join(' ');
    const date = new Date(dub.created_at).toLocaleDateString();

    return `
            <tr>
                <td><strong>${i + 1}</strong></td>
                <td class="timestamp">${date}</td>
                <td>
                    @${dub.username}<br/>
                    <small style="color: #657786;">→ @${dub.parent_username}</small>
                </td>
                <td class="categories">${categories || '<em>None</em>'}</td>
                <td>${dub.target_language || '-'}</td>
                <td class="number-cell">${mentionViews}</td>
                <td class="number-cell ${dub.dub_reply_views && dub.dub_reply_views > 1000 ? 'metric-high' : 'metric-low'}">${dubViews}</td>
                <td class="number-cell">${parentViews}</td>
                <td class="number-cell">${convRate}</td>
                <td>
                    <a href="${mentionUrl}" class="link" target="_blank" rel="noopener">Mention</a> •
                    <a href="${dubUrl}" class="link" target="_blank" rel="noopener">Dub</a> •
                    <a href="${parentUrl}" class="link" target="_blank" rel="noopener">Parent</a>
                </td>
            </tr>`;
}).join('')}
        </tbody>
    </table>

${dubsWithoutMetrics.length > 0 ? `
    <h2>⚠️ Dubs Without Metrics (${dubsWithoutMetrics.length})</h2>

    <div class="alert">
        <strong>These dubs are complete but don't have metrics collected yet.</strong>
        Run: <code>npx tsx scripts/collect-metrics.ts</code> to collect their metrics.
    </div>

    <table>
        <thead>
            <tr>
                <th>#</th>
                <th>Created</th>
                <th>User → Parent</th>
                <th>Lang</th>
                <th>Dub Reply Tweet ID</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody>
${dubsWithoutMetrics.slice(0, 20).map((dub, i) => {
    const dubUrl = dub.dub_reply_tweet_url || (dub.dub_reply_tweet_id ? `https://twitter.com/dubbingagent/status/${dub.dub_reply_tweet_id}` : null);
    const date = new Date(dub.created_at).toLocaleDateString();

    return `
            <tr>
                <td>${i + 1}</td>
                <td class="timestamp">${date}</td>
                <td>@${dub.username} → @${dub.parent_username}</td>
                <td>${dub.target_language || '-'}</td>
                <td>${dub.dub_reply_tweet_id || '<span class="no-metrics">Not recorded</span>'}</td>
                <td>
                    ${dubUrl ? `<a href="${dubUrl}" class="link" target="_blank" rel="noopener">View Dub</a>` : '<span class="no-metrics">No link</span>'}
                </td>
            </tr>`;
}).join('')}
        </tbody>
    </table>
${dubsWithoutMetrics.length > 20 ? `<p><em>Showing first 20 of ${dubsWithoutMetrics.length} dubs without metrics</em></p>` : ''}
` : ''}

    <div class="section-note">
        <strong>💡 Next Steps:</strong>
        <ol style="margin: 10px 0 0 20px;">
            <li>Click through each dub link and verify the view counts match Twitter</li>
            <li>If numbers are significantly different, note which ones</li>
            <li>Run <code>npx tsx scripts/collect-metrics.ts</code> to refresh metrics</li>
            <li>Metrics are point-in-time snapshots - they don't auto-update</li>
        </ol>
    </div>

    <div class="footer">
        <p>Dubbingagent Verification Report • Generated ${new Date().toLocaleString()}</p>
        <p style="font-size: 0.9em;">To refresh metrics: <code>npx tsx scripts/collect-metrics.ts</code></p>
    </div>
</body>
</html>`;

    const outputPath = path.join(process.cwd(), 'reports', 'verification-report.html');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html);

    logger.info(`[🔍 Verification] HTML report saved to: ${outputPath}`);

    // Also create a simple CSV for easy spreadsheet verification
    const csv = `#,Created,Username,Parent Username,Target Language,Mention Views,Dub Reply Views,Parent Views,Conversion %,Mention URL,Dub URL,Parent URL
${dubDetails.map((dub, i) => {
    const mentionUrl = `https://twitter.com/${dub.username}/status/${dub.mention_tweet_id}`;
    const dubUrl = dub.dub_reply_tweet_url || `https://twitter.com/dubbingagent/status/${dub.dub_reply_tweet_id}`;
    const date = new Date(dub.created_at).toLocaleDateString();

    return `${i+1},${date},${dub.username},${dub.parent_username},${dub.target_language || ''},${dub.mention_views || ''},${dub.dub_reply_views || ''},${dub.parent_views || ''},${dub.dub_to_parent_view_rate || ''},${mentionUrl},${dubUrl},${dub.parent_tweet_url}`;
}).join('\n')}`;

    const csvPath = path.join(process.cwd(), 'reports', 'verification-report.csv');
    fs.writeFileSync(csvPath, csv);
    logger.info(`[🔍 Verification] CSV report saved to: ${csvPath}`);
}

generateVerificationReport()
    .then(() => {
        logger.info('[🔍 Verification] Verification report completed');
        console.log('\n✅ Reports generated:');
        console.log('   📄 HTML: reports/verification-report.html');
        console.log('   📊 CSV:  reports/verification-report.csv');
        console.log('\n👉 Open the HTML file to verify each dub on Twitter');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🔍 Verification] Report generation failed:', error);
        process.exit(1);
    });
