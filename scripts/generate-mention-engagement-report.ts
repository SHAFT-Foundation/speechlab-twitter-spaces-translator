#!/usr/bin/env tsx
/**
 * Generate Mention Engagement Report
 *
 * Shows how mention tweets perform compared to other comments on parent threads
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function generateReport() {
    console.log('[📊 Report] Generating mention engagement report...');

    // Get all mentions with metrics
    const { data: mentionMetrics } = await supabase
        .from('tweet_metrics_latest')
        .select('*')
        .eq('tweet_type', 'mention');

    if (!mentionMetrics || mentionMetrics.length === 0) {
        console.log('⚠️  No mention metrics found. Run collect-mention-metrics.ts first.');
        return;
    }

    console.log(`[📊 Report] Found ${mentionMetrics.length} mentions with metrics`);

    // For each mention, get parent and sibling metrics
    const reportData = [];

    for (const mention of mentionMetrics) {
        const mentionId = mention.mention_id;

        // Get parent metrics
        const { data: parentMetrics } = await supabase
            .from('tweet_metrics_latest')
            .select('*')
            .eq('mention_id', mentionId)
            .eq('tweet_type', 'parent')
            .single();

        // Get sibling comment metrics
        const { data: siblingMetrics } = await supabase
            .from('tweet_metrics_latest')
            .select('*')
            .eq('mention_id', mentionId)
            .eq('tweet_type', 'sibling_comment');

        // Calculate average sibling views
        const avgSiblingViews = siblingMetrics && siblingMetrics.length > 0
            ? siblingMetrics.reduce((sum, s) => sum + (s.impression_count || 0), 0) / siblingMetrics.length
            : 0;

        // Get mention details from mentions table
        const { data: mentionDetails } = await supabase
            .from('mentions')
            .select('username, parent_username, parent_tweet_url, tweet_url, target_language, custom_category, created_at')
            .eq('tweet_id', mentionId)
            .single();

        reportData.push({
            mention_id: mentionId,
            mention_views: mention.impression_count || 0,
            mention_likes: mention.like_count || 0,
            parent_views: parentMetrics?.impression_count || 0,
            parent_likes: parentMetrics?.like_count || 0,
            avg_sibling_views: avgSiblingViews,
            sibling_count: siblingMetrics?.length || 0,
            mention_vs_avg_sibling: avgSiblingViews > 0 ? (mention.impression_count / avgSiblingViews) : 0,
            mention_to_parent_rate: parentMetrics?.impression_count > 0
                ? (mention.impression_count / parentMetrics.impression_count * 100)
                : 0,
            ...mentionDetails
        });
    }

    // Sort by mention_vs_avg_sibling descending
    reportData.sort((a, b) => b.mention_vs_avg_sibling - a.mention_vs_avg_sibling);

    // Calculate totals
    const totalMentionViews = reportData.reduce((sum, d) => sum + d.mention_views, 0);
    const totalParentViews = reportData.reduce((sum, d) => sum + d.parent_views, 0);
    const avgMentionViews = totalMentionViews / reportData.length;
    const avgSiblingViewsOverall = reportData.reduce((sum, d) => sum + d.avg_sibling_views, 0) / reportData.length;
    const overallMultiplier = avgSiblingViewsOverall > 0 ? avgMentionViews / avgSiblingViewsOverall : 0;

    // Generate HTML
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mention Tweet Engagement Report</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1600px;
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
        .highlight {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            border-radius: 12px;
            margin: 30px 0;
            text-align: center;
        }
        .highlight h2 {
            color: white;
            border: none;
            margin: 0 0 20px 0;
            font-size: 32px;
        }
        .highlight .big-number {
            font-size: 72px;
            font-weight: bold;
            margin: 20px 0;
        }
        table {
            width: 100%;
            background: white;
            border-collapse: collapse;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
            margin: 20px 0;
        }
        th {
            background: #1da1f2;
            color: white;
            padding: 15px;
            text-align: left;
            font-weight: 600;
            position: sticky;
            top: 0;
        }
        td {
            padding: 12px 15px;
            border-bottom: 1px solid #eee;
        }
        tr:hover {
            background: #f8f9fa;
        }
        .good { color: #28a745; font-weight: bold; }
        .great { color: #007bff; font-weight: bold; }
        .amazing { color: #dc3545; font-weight: bold; }
        a { color: #1da1f2; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .info {
            background: #d1ecf1;
            border: 1px solid #0dcaf0;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <h1>🎤 Mention Tweet Engagement Report</h1>
    <p style="color: #666; margin-bottom: 30px;">Generated: ${new Date().toLocaleString()}</p>

    <div class="summary">
        <h2>📊 Overall Statistics</h2>
        <div class="stat">
            <span class="stat-value">${reportData.length}</span>
            <span class="stat-label">Mentions Analyzed</span>
        </div>
        <div class="stat">
            <span class="stat-value">${totalMentionViews.toLocaleString()}</span>
            <span class="stat-label">Total Mention Views</span>
        </div>
        <div class="stat">
            <span class="stat-value">${Math.round(avgMentionViews).toLocaleString()}</span>
            <span class="stat-label">Avg Mention Views</span>
        </div>
        <div class="stat">
            <span class="stat-value">${Math.round(avgSiblingViewsOverall).toLocaleString()}</span>
            <span class="stat-label">Avg Other Comment Views</span>
        </div>
    </div>

    <div class="highlight">
        <h2>🚀 Key Insight</h2>
        <p style="font-size: 20px; margin: 10px 0;">@dubbingagent mention tweets get</p>
        <div class="big-number">${overallMultiplier.toFixed(1)}x</div>
        <p style="font-size: 20px; margin: 10px 0;">more views than average comments on the same threads</p>
    </div>

    <div class="info">
        <h3>📈 What This Means</h3>
        <p><strong>Engagement Multiplier:</strong> When users mention @dubbingagent to request a dub, their comment gets significantly more attention than typical replies on the same thread.</p>
        <p><strong>Why:</strong> The dubbing request creates anticipation and follow-up engagement as people wait for and watch the dubbed version.</p>
        <p><strong>Impact:</strong> Users who engage with @dubbingagent see ${overallMultiplier.toFixed(1)}x more visibility for their comments compared to regular replies.</p>
    </div>

    <h2>📋 Detailed Breakdown</h2>
    <table>
        <thead>
            <tr>
                <th>User</th>
                <th>Date</th>
                <th>Mention Views</th>
                <th>Avg Other Comment Views</th>
                <th>Performance vs Others</th>
                <th>Parent Thread Views</th>
                <th>% of Parent Views</th>
                <th>Language</th>
                <th>Links</th>
            </tr>
        </thead>
        <tbody>
            ${reportData.map(d => {
                let performanceClass = 'good';
                let performanceLabel = d.mention_vs_avg_sibling.toFixed(1) + 'x';

                if (d.mention_vs_avg_sibling > 5) {
                    performanceClass = 'great';
                } else if (d.mention_vs_avg_sibling > 10) {
                    performanceClass = 'amazing';
                }

                return `
                <tr>
                    <td>@${d.username}</td>
                    <td>${new Date(d.created_at).toLocaleDateString()}</td>
                    <td><strong>${d.mention_views.toLocaleString()}</strong></td>
                    <td>${Math.round(d.avg_sibling_views).toLocaleString()} <small>(${d.sibling_count} sampled)</small></td>
                    <td class="${performanceClass}">${performanceLabel}</td>
                    <td>${d.parent_views.toLocaleString()}</td>
                    <td>${d.mention_to_parent_rate.toFixed(1)}%</td>
                    <td>${d.target_language || 'N/A'}</td>
                    <td>
                        <a href="${d.tweet_url}" target="_blank">Mention</a> |
                        <a href="${d.parent_tweet_url}" target="_blank">Parent</a>
                    </td>
                </tr>
                `;
            }).join('')}
        </tbody>
    </table>

    <div style="margin-top: 50px; padding: 20px; background: white; border-radius: 8px;">
        <h3>📊 Methodology</h3>
        <p><strong>Mention Views:</strong> Views on the tweet where user mentions @dubbingagent</p>
        <p><strong>Avg Other Comment Views:</strong> Average views of other replies to the same parent tweet (sampled up to 10 random comments)</p>
        <p><strong>Performance vs Others:</strong> How many times more views the mention tweet gets compared to average comment</p>
        <p><strong>Parent Thread Views:</strong> Total views on the original tweet being dubbed</p>
    </div>

    <div style="margin-top: 30px; padding: 20px; background: white; border-radius: 8px; text-align: center;">
        <p style="color: #666;">🤖 Generated by Dubbing Agent Analytics System</p>
    </div>
</body>
</html>`;

    // Create reports directory
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Write HTML
    const htmlPath = path.join(reportsDir, 'mention-engagement-report.html');
    fs.writeFileSync(htmlPath, html);

    console.log('\n========================================');
    console.log('📊 Mention Engagement Report Generated!');
    console.log('========================================');
    console.log(`Mentions analyzed: ${reportData.length}`);
    console.log(`Overall performance: ${overallMultiplier.toFixed(1)}x more views than average comment`);
    console.log('\n📄 HTML Report: reports/mention-engagement-report.html');
    console.log('========================================\n');
}

generateReport().then(() => process.exit(0)).catch(console.error);
