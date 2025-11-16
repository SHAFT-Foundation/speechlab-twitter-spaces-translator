#!/usr/bin/env tsx
/**
 * Generate Current Status Report
 *
 * Shows what we have so far - all completed dubs
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function generateReport() {
    // Get all completed mentions
    const { data: mentions, error } = await supabase
        .from('mentions')
        .select('tweet_id, username, parent_username, parent_tweet_url, dub_reply_tweet_id, dub_reply_tweet_url, target_language, custom_category, created_at')
        .eq('status', 'complete')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error:', error);
        return;
    }

    const total = mentions?.length || 0;
    const withReplyId = mentions?.filter(m => m.dub_reply_tweet_id)?.length || 0;
    const withoutReplyId = total - withReplyId;

    // Group by language
    const byLanguage: Record<string, number> = {};
    mentions?.forEach(m => {
        const lang = m.target_language || 'unknown';
        byLanguage[lang] = (byLanguage[lang] || 0) + 1;
    });

    // Group by category
    const byCategory: Record<string, number> = {};
    mentions?.forEach(m => {
        const cats = m.custom_category || [];
        cats.forEach((cat: string) => {
            byCategory[cat] = (byCategory[cat] || 0) + 1;
        });
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dubbing Agent - Current Status Report</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1400px;
            margin: 0 auto;
            padding: 40px 20px;
            background: #f5f5f5;
        }
        h1 { color: #1da1f2; margin-bottom: 10px; }
        h2 { color: #333; margin-top: 40px; border-bottom: 2px solid #1da1f2; padding-bottom: 10px; }
        .summary {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        .stat {
            display: inline-block;
            margin: 10px 30px 10px 0;
        }
        .stat-value {
            font-size: 48px;
            font-weight: bold;
            color: #1da1f2;
            display: block;
        }
        .stat-label {
            color: #666;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .warning {
            background: #fff3cd;
            border: 1px solid #ffc107;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .info {
            background: #d1ecf1;
            border: 1px solid #0dcaf0;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        table {
            width: 100%;
            background: white;
            border-collapse: collapse;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
        }
        th {
            background: #1da1f2;
            color: white;
            padding: 15px;
            text-align: left;
            font-weight: 600;
        }
        td {
            padding: 12px 15px;
            border-bottom: 1px solid #eee;
        }
        tr:hover {
            background: #f8f9fa;
        }
        .category-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .category-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .category-name {
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }
        .category-count {
            font-size: 24px;
            color: #1da1f2;
            font-weight: bold;
        }
        a { color: #1da1f2; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h1>🎤 Dubbing Agent Status Report</h1>
    <p style="color: #666; margin-bottom: 30px;">Generated: ${new Date().toLocaleString()}</p>

    <div class="summary">
        <h2>📊 Overview</h2>
        <div class="stat">
            <span class="stat-value">${total}</span>
            <span class="stat-label">Total Completed Dubs</span>
        </div>
        <div class="stat">
            <span class="stat-value">${withReplyId}</span>
            <span class="stat-label">With Reply Tweet ID</span>
        </div>
        <div class="stat">
            <span class="stat-value">${withoutReplyId}</span>
            <span class="stat-label">Missing Reply Tweet ID</span>
        </div>
    </div>

    <div class="warning">
        <h3>⚠️ Analytics Not Available Yet</h3>
        <p><strong>Why:</strong> We need reply tweet IDs to collect metrics (views, likes, etc.) from Twitter.</p>
        <p><strong>Status:</strong> Currently ${withoutReplyId} out of ${total} dubs (${Math.round((withoutReplyId/total)*100)}%) are missing reply tweet IDs.</p>
        <p><strong>Next Steps:</strong></p>
        <ol>
            <li>Wait for backfill script to complete (currently running, waiting for Twitter rate limits)</li>
            <li>Once backfill completes, run: <code>npx tsx scripts/collect-metrics.ts</code></li>
            <li>Generate analytics report: <code>npx tsx scripts/generate-engagement-report.ts</code></li>
        </ol>
    </div>

    <div class="info">
        <h3>✅ What's Working</h3>
        <p><strong>All future dubs</strong> will automatically track reply tweet IDs thanks to the updated daemon code.</p>
        <p><strong>Analytics infrastructure</strong> is fully in place - database tables, metrics collection scripts, and report generators are ready.</p>
        <p><strong>Once backfill completes</strong>, you'll be able to track:</p>
        <ul>
            <li>View counts for mentions vs dub replies vs parent tweets</li>
            <li>Engagement rates (likes, retweets, replies)</li>
            <li>Performance by language and category</li>
            <li>Comparison with other comments on the same parent tweet</li>
        </ul>
    </div>

    <h2>🌍 Dubs by Language</h2>
    <div class="category-grid">
        ${Object.entries(byLanguage)
            .sort((a, b) => b[1] - a[1])
            .map(([lang, count]) => `
                <div class="category-card">
                    <div class="category-name">${lang}</div>
                    <div class="category-count">${count}</div>
                </div>
            `).join('')}
    </div>

    <h2>📁 Dubs by Category</h2>
    <div class="category-grid">
        ${Object.entries(byCategory)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, count]) => `
                <div class="category-card">
                    <div class="category-name">${cat || 'Uncategorized'}</div>
                    <div class="category-count">${count}</div>
                </div>
            `).join('')}
    </div>

    <h2>📋 Recent Dubs (Last 50)</h2>
    <table>
        <thead>
            <tr>
                <th>Date</th>
                <th>User</th>
                <th>Parent User</th>
                <th>Language</th>
                <th>Mention Tweet</th>
                <th>Parent Tweet</th>
                <th>Reply Tweet ID</th>
            </tr>
        </thead>
        <tbody>
            ${mentions?.slice(0, 50).map(m => `
                <tr>
                    <td>${new Date(m.created_at).toLocaleDateString()}</td>
                    <td>@${m.username}</td>
                    <td>@${m.parent_username || 'N/A'}</td>
                    <td>${m.target_language || 'N/A'}</td>
                    <td><a href="https://twitter.com/user/status/${m.tweet_id}" target="_blank">View →</a></td>
                    <td>${m.parent_tweet_url ? `<a href="${m.parent_tweet_url}" target="_blank">View →</a>` : 'N/A'}</td>
                    <td>${m.dub_reply_tweet_id ? `<a href="${m.dub_reply_tweet_url}" target="_blank">${m.dub_reply_tweet_id}</a>` : '⏳ Pending backfill'}</td>
                </tr>
            `).join('')}
        </tbody>
    </table>

    <div style="margin-top: 50px; padding: 20px; background: white; border-radius: 8px; text-align: center;">
        <p style="color: #666;">🤖 Generated by Dubbing Agent Analytics System</p>
        <p style="color: #999; font-size: 12px;">Once backfill completes, you'll see full engagement metrics with views, likes, and comparative analytics.</p>
    </div>
</body>
</html>`;

    // Create reports directory
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Write HTML
    const htmlPath = path.join(reportsDir, 'current-status-report.html');
    fs.writeFileSync(htmlPath, html);

    console.log('\n========================================');
    console.log('📊 Current Status Report Generated!');
    console.log('========================================');
    console.log(`Total Completed Dubs: ${total}`);
    console.log(`With Reply Tweet ID: ${withReplyId}`);
    console.log(`Missing Reply Tweet ID: ${withoutReplyId}`);
    console.log('\n📄 HTML Report: reports/current-status-report.html');
    console.log('\n👉 Next: Wait for backfill to complete, then collect metrics');
    console.log('========================================\n');
}

generateReport().then(() => process.exit(0)).catch(console.error);
