#!/usr/bin/env tsx
/**
 * Generate Engagement Analytics Report
 *
 * Shows:
 * 1. Dub reply views vs parent tweet views
 * 2. Dub reply views vs average sibling comment views
 * 3. Category-level engagement analysis
 * 4. Language-specific performance
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface EngagementData {
    mention_tweet_id: string;
    username: string;
    parent_username: string;
    dub_reply_tweet_id: string;
    target_language: string;
    custom_category: string[];

    mention_views: number;
    mention_likes: number;

    dub_reply_views: number;
    dub_reply_likes: number;
    dub_reply_retweets: number;

    parent_views: number;
    parent_likes: number;

    dub_to_parent_view_rate: number;
    metrics_collected_at: string;
    dub_created_at: string;
}

interface SiblingComparison {
    mention_id: string;
    dub_reply_views: number;
    avg_sibling_views: number;
    sibling_count: number;
    performance_multiplier: number;
}

async function generateReport(outputFormat: 'json' | 'markdown' | 'html' = 'markdown') {
    try {
        logger.info('[📊 Report] Starting engagement analytics report generation...');

        // 1. Get engagement comparison data
        const { data: engagementData, error: engagementError } = await supabase
            .from('dub_engagement_comparison')
            .select('*')
            .not('dub_reply_views', 'is', null)
            .order('dub_reply_views', { ascending: false });

        if (engagementError) {
            logger.error('[📊 Report] Error fetching engagement data:', engagementError);
            return;
        }

        if (!engagementData || engagementData.length === 0) {
            logger.warn('[📊 Report] No engagement data available. Collect metrics first.');
            return;
        }

        logger.info(`[📊 Report] Found ${engagementData.length} dubs with metrics`);

        // 2. Get sibling comment comparisons
        const siblingComparisons = await getSiblingComparisons();

        // 3. Calculate aggregate stats
        const stats = calculateAggregateStats(engagementData as EngagementData[]);

        // 4. Category analysis
        const categoryStats = analyzeCategoryPerformance(engagementData as EngagementData[]);

        // 5. Language analysis
        const languageStats = analyzeLanguagePerformance(engagementData as EngagementData[]);

        // 6. Generate report
        const report = {
            generated_at: new Date().toISOString(),
            summary: stats,
            category_performance: categoryStats,
            language_performance: languageStats,
            top_performing_dubs: engagementData.slice(0, 10),
            sibling_comparisons: siblingComparisons
        };

        // 7. Output report
        if (outputFormat === 'json') {
            await outputJSON(report);
        } else if (outputFormat === 'html') {
            await outputHTML(report, engagementData as EngagementData[], siblingComparisons);
        } else {
            await outputMarkdown(report, engagementData as EngagementData[], siblingComparisons);
        }

        logger.info('[📊 Report] Engagement report generated successfully!');
    } catch (error) {
        logger.error('[📊 Report] Fatal error generating report:', error);
        process.exit(1);
    }
}

async function getSiblingComparisons(): Promise<SiblingComparison[]> {
    const { data, error } = await supabase.rpc('exec_sql', {
        sql: `
            SELECT
                tm.mention_id,
                dub.impression_count as dub_reply_views,
                AVG(tm.impression_count) as avg_sibling_views,
                COUNT(tm.tweet_id) as sibling_count,
                CASE
                    WHEN AVG(tm.impression_count) > 0
                    THEN ROUND(dub.impression_count::numeric / AVG(tm.impression_count), 2)
                    ELSE 0
                END as performance_multiplier
            FROM tweet_metrics tm
            CROSS JOIN LATERAL (
                SELECT impression_count
                FROM tweet_metrics
                WHERE mention_id = tm.mention_id
                  AND tweet_type = 'dub_reply'
                ORDER BY collected_at DESC
                LIMIT 1
            ) dub
            WHERE tm.tweet_type = 'sibling_comment'
            GROUP BY tm.mention_id, dub.impression_count
            HAVING COUNT(tm.tweet_id) >= 3
            ORDER BY performance_multiplier DESC
        `
    }).catch(() => ({ data: null, error: 'RPC not available' }));

    if (error || !data) {
        // Fallback: manual calculation
        const comparisons: SiblingComparison[] = [];

        const { data: mentions } = await supabase
            .from('tweet_metrics')
            .select('mention_id')
            .eq('tweet_type', 'sibling_comment')
            .not('mention_id', 'is', null);

        if (!mentions) return [];

        const uniqueMentions = [...new Set(mentions.map(m => m.mention_id))];

        for (const mentionId of uniqueMentions) {
            const { data: siblings } = await supabase
                .from('tweet_metrics')
                .select('impression_count')
                .eq('mention_id', mentionId)
                .eq('tweet_type', 'sibling_comment');

            const { data: dubReply } = await supabase
                .from('tweet_metrics')
                .select('impression_count')
                .eq('mention_id', mentionId)
                .eq('tweet_type', 'dub_reply')
                .order('collected_at', { ascending: false })
                .limit(1)
                .single();

            if (siblings && siblings.length >= 3 && dubReply) {
                const avgSiblingViews = siblings.reduce((sum, s) => sum + (s.impression_count || 0), 0) / siblings.length;
                const dubViews = dubReply.impression_count || 0;

                comparisons.push({
                    mention_id: mentionId || '',
                    dub_reply_views: dubViews,
                    avg_sibling_views: Math.round(avgSiblingViews),
                    sibling_count: siblings.length,
                    performance_multiplier: avgSiblingViews > 0 ? Number((dubViews / avgSiblingViews).toFixed(2)) : 0
                });
            }
        }

        return comparisons.sort((a, b) => b.performance_multiplier - a.performance_multiplier);
    }

    return data || [];
}

function calculateAggregateStats(data: EngagementData[]) {
    const totalDubs = data.length;
    const totalDubViews = data.reduce((sum, d) => sum + (d.dub_reply_views || 0), 0);
    const totalParentViews = data.reduce((sum, d) => sum + (d.parent_views || 0), 0);
    const avgDubViews = totalDubViews / totalDubs;
    const avgParentViews = totalParentViews / totalDubs;
    const avgConversionRate = data.reduce((sum, d) => sum + (d.dub_to_parent_view_rate || 0), 0) / totalDubs;

    return {
        total_dubs: totalDubs,
        total_dub_views: totalDubViews,
        total_parent_views: totalParentViews,
        avg_dub_views: Math.round(avgDubViews),
        avg_parent_views: Math.round(avgParentViews),
        avg_conversion_rate: Number(avgConversionRate.toFixed(2)),
        total_dub_likes: data.reduce((sum, d) => sum + (d.dub_reply_likes || 0), 0),
        total_dub_retweets: data.reduce((sum, d) => sum + (d.dub_reply_retweets || 0), 0)
    };
}

function analyzeCategoryPerformance(data: EngagementData[]) {
    const categoryMap = new Map<string, { views: number; count: number; likes: number }>();

    data.forEach(d => {
        if (d.custom_category) {
            d.custom_category.forEach(cat => {
                const existing = categoryMap.get(cat) || { views: 0, count: 0, likes: 0 };
                categoryMap.set(cat, {
                    views: existing.views + (d.dub_reply_views || 0),
                    count: existing.count + 1,
                    likes: existing.likes + (d.dub_reply_likes || 0)
                });
            });
        }
    });

    const categoryStats = Array.from(categoryMap.entries()).map(([category, stats]) => ({
        category,
        total_dubs: stats.count,
        total_views: stats.views,
        total_likes: stats.likes,
        avg_views: Math.round(stats.views / stats.count),
        avg_likes: Math.round(stats.likes / stats.count)
    }));

    return categoryStats.sort((a, b) => b.avg_views - a.avg_views);
}

function analyzeLanguagePerformance(data: EngagementData[]) {
    const languageMap = new Map<string, { views: number; count: number; likes: number }>();

    data.forEach(d => {
        const lang = d.target_language || 'unknown';
        const existing = languageMap.get(lang) || { views: 0, count: 0, likes: 0 };
        languageMap.set(lang, {
            views: existing.views + (d.dub_reply_views || 0),
            count: existing.count + 1,
            likes: existing.likes + (d.dub_reply_likes || 0)
        });
    });

    const languageStats = Array.from(languageMap.entries()).map(([language, stats]) => ({
        language,
        total_dubs: stats.count,
        total_views: stats.views,
        total_likes: stats.likes,
        avg_views: Math.round(stats.views / stats.count),
        avg_likes: Math.round(stats.likes / stats.count)
    }));

    return languageStats.sort((a, b) => b.avg_views - a.avg_views);
}

async function outputJSON(report: any) {
    const outputPath = path.join(process.cwd(), 'reports', 'engagement-report.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    logger.info(`[📊 Report] JSON report saved to: ${outputPath}`);
}

async function outputMarkdown(report: any, engagementData: EngagementData[], siblingComparisons: SiblingComparison[]) {
    const md = `# Dubbingagent Engagement Analytics Report

**Generated:** ${new Date(report.generated_at).toLocaleString()}

---

## 📊 Executive Summary

- **Total Dubs Analyzed:** ${report.summary.total_dubs.toLocaleString()}
- **Total Dub Reply Views:** ${report.summary.total_dub_views.toLocaleString()}
- **Total Parent Tweet Views:** ${report.summary.total_parent_views.toLocaleString()}
- **Average Dub Reply Views:** ${report.summary.avg_dub_views.toLocaleString()}
- **Average Parent Views:** ${report.summary.avg_parent_views.toLocaleString()}
- **Average Conversion Rate:** ${report.summary.avg_conversion_rate}% (dub views / parent views)
- **Total Likes on Dubs:** ${report.summary.total_dub_likes.toLocaleString()}
- **Total Retweets of Dubs:** ${report.summary.total_dub_retweets.toLocaleString()}

---

## 🏆 Top Performing Dubs

| Rank | Dub Views | Parent Views | Conversion % | Categories | Language | User |
|------|-----------|--------------|--------------|------------|----------|------|
${report.top_performing_dubs.slice(0, 10).map((d: EngagementData, i: number) =>
    `| ${i + 1} | ${(d.dub_reply_views || 0).toLocaleString()} | ${(d.parent_views || 0).toLocaleString()} | ${d.dub_to_parent_view_rate}% | ${(d.custom_category || []).join(', ')} | ${d.target_language} | @${d.username} |`
).join('\n')}

---

## 🎯 Dub vs Other Comments Comparison

${siblingComparisons.length > 0 ? `
Our dub replies compared to other comments on the same parent tweets:

| Dub Views | Avg Other Comment Views | Sibling Count | **Performance Multiplier** |
|-----------|------------------------|---------------|---------------------------|
${siblingComparisons.slice(0, 10).map(s =>
    `| ${s.dub_reply_views.toLocaleString()} | ${s.avg_sibling_views.toLocaleString()} | ${s.sibling_count} | **${s.performance_multiplier}x** |`
).join('\n')}

**Key Insight:** On average, our dub replies get **${siblingComparisons.length > 0 ? (siblingComparisons.reduce((sum, s) => sum + s.performance_multiplier, 0) / siblingComparisons.length).toFixed(1) : 'N/A'}x more views** than other comments on the same parent tweets!
` : '*No sibling comparison data available yet. Run metrics collection with sibling sampling.*'}

---

## 📈 Category Performance

| Category | Dubs | Total Views | Avg Views | Avg Likes |
|----------|------|-------------|-----------|-----------|
${report.category_performance.map((c: any) =>
    `| ${c.category} | ${c.total_dubs} | ${c.total_views.toLocaleString()} | ${c.avg_views.toLocaleString()} | ${c.avg_likes} |`
).join('\n')}

---

## 🌍 Language Performance

| Language | Dubs | Total Views | Avg Views | Avg Likes |
|----------|------|-------------|-----------|-----------|
${report.language_performance.map((l: any) =>
    `| ${l.language} | ${l.total_dubs} | ${l.total_views.toLocaleString()} | ${l.avg_views.toLocaleString()} | ${l.avg_likes} |`
).join('\n')}

---

## 💡 Key Takeaways

1. **Engagement Rate:** Dub replies achieve ${report.summary.avg_conversion_rate}% of parent tweet views on average
2. **Best Category:** ${report.category_performance[0]?.category || 'N/A'} performs best with ${report.category_performance[0]?.avg_views.toLocaleString() || 'N/A'} avg views
3. **Best Language:** ${report.language_performance[0]?.language || 'N/A'} performs best with ${report.language_performance[0]?.avg_views.toLocaleString() || 'N/A'} avg views
4. **Social Proof:** ${report.summary.total_dub_likes.toLocaleString()} total likes demonstrate strong user approval

---

*Report generated by Dubbingagent Analytics System*
`;

    const outputPath = path.join(process.cwd(), 'reports', 'engagement-report.md');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, md);
    logger.info(`[📊 Report] Markdown report saved to: ${outputPath}`);

    // Also print to console
    console.log('\n' + md);
}

async function outputHTML(report: any, engagementData: EngagementData[], siblingComparisons: SiblingComparison[]) {
    // HTML report implementation (basic version)
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>Dubbingagent Engagement Report</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #1DA1F2; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #1DA1F2; color: white; }
        tr:hover { background-color: #f5f5f5; }
        .metric { background: #f0f8ff; padding: 20px; margin: 10px 0; border-radius: 8px; }
        .metric h3 { margin: 0 0 10px 0; }
        .highlight { color: #1DA1F2; font-weight: bold; font-size: 1.2em; }
    </style>
</head>
<body>
    <h1>📊 Dubbingagent Engagement Analytics Report</h1>
    <p><strong>Generated:</strong> ${new Date(report.generated_at).toLocaleString()}</p>

    <div class="metric">
        <h3>Executive Summary</h3>
        <p><span class="highlight">${report.summary.total_dub_views.toLocaleString()}</span> Total Dub Reply Views</p>
        <p><span class="highlight">${report.summary.avg_conversion_rate}%</span> Average Conversion Rate</p>
        <p><span class="highlight">${report.summary.total_dubs}</span> Total Dubs Analyzed</p>
    </div>

    <h2>🏆 Top Performing Dubs</h2>
    <table>
        <tr>
            <th>Rank</th><th>Dub Views</th><th>Parent Views</th><th>Conversion %</th><th>Categories</th><th>Language</th>
        </tr>
        ${report.top_performing_dubs.slice(0, 10).map((d: EngagementData, i: number) => `
        <tr>
            <td>${i + 1}</td>
            <td>${(d.dub_reply_views || 0).toLocaleString()}</td>
            <td>${(d.parent_views || 0).toLocaleString()}</td>
            <td>${d.dub_to_parent_view_rate}%</td>
            <td>${(d.custom_category || []).join(', ')}</td>
            <td>${d.target_language}</td>
        </tr>
        `).join('')}
    </table>

    <p><em>Report generated by Dubbingagent Analytics System</em></p>
</body>
</html>`;

    const outputPath = path.join(process.cwd(), 'reports', 'engagement-report.html');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html);
    logger.info(`[📊 Report] HTML report saved to: ${outputPath}`);
}

// Parse command line arguments
const format = process.argv[2] as 'json' | 'markdown' | 'html' || 'markdown';

generateReport(format)
    .then(() => {
        logger.info('[📊 Report] Report generation completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[📊 Report] Report generation failed:', error);
        process.exit(1);
    });
