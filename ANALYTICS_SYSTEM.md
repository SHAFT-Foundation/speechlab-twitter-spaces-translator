# Analytics System - Engagement Tracking & Reporting

## Overview

The analytics system tracks tweet engagement metrics (views, likes, retweets) to demonstrate the value of dubbed content. It compares your dub reply performance against:

1. **Parent tweets** - Original content being dubbed
2. **Sibling comments** - Other replies to the same parent tweet
3. **Category trends** - Performance by content category
4. **Language trends** - Performance by target language

---

## Key Metrics Tracked

### Views (Impressions) 🎯
**The most important metric** - Shows how many people saw the tweet

### Engagement
- **Likes** - User approval
- **Retweets** - Content sharing
- **Replies** - Discussion generated
- **Quotes** - Referenced in other tweets

---

## System Components

### 1. Database Schema

**Table: `tweet_metrics`**
Stores historical metrics data over time

```sql
CREATE TABLE tweet_metrics (
    tweet_id TEXT,
    tweet_type TEXT, -- 'mention', 'dub_reply', 'parent', 'sibling_comment'
    mention_id TEXT, -- Links back to mentions table
    impression_count BIGINT, -- VIEWS!
    like_count INTEGER,
    reply_count INTEGER,
    retweet_count INTEGER,
    quote_count INTEGER,
    collected_at TIMESTAMPTZ
);
```

**Views:**
- `tweet_metrics_latest` - Most recent metrics for each tweet
- `dub_engagement_comparison` - Pre-calculated comparison stats

**Mentions Table Additions:**
- `dub_reply_tweet_id` - Tweet ID of your video reply
- `dub_reply_tweet_url` - URL to your video reply

### 2. Metrics Collection Service

**File:** `src/services/twitterMetricsService.ts`

Functions:
- `fetchTweetMetrics()` - Get metrics for single tweet
- `fetchTweetMetricsBatch()` - Get metrics for multiple tweets
- `collectMentionMetrics()` - Collect for mention + dub + parent
- `collectSiblingCommentMetrics()` - Sample other comments for comparison

### 3. Collection Script

**File:** `scripts/collect-metrics.ts`

Collects metrics for all completed dubs.

```bash
# Basic collection
npx tsx scripts/collect-metrics.ts

# Include sibling comment sampling (for comparison)
npx tsx scripts/collect-metrics.ts --include-siblings

# Collect for specific mention only
npx tsx scripts/collect-metrics.ts --mention-id 1989787665672388880

# Collect with more samples
npx tsx scripts/collect-metrics.ts --include-siblings --sample-size 20
```

### 4. Report Generation

**File:** `scripts/generate-engagement-report.ts`

Generates comprehensive analytics reports.

```bash
# Markdown report (default)
npx tsx scripts/generate-engagement-report.ts

# JSON report (for programmatic use)
npx tsx scripts/generate-engagement-report.ts json

# HTML report (for sharing)
npx tsx scripts/generate-engagement-report.ts html
```

---

## Getting Started

### Step 1: Run Migration

```bash
# Add required tables and columns
psql -h cemuqqzmamjmtefodbqs.supabase.co -U postgres -d postgres -f migrations/006_create_tweet_metrics.sql
```

Or in Supabase SQL Editor:
```sql
-- Run the contents of migrations/006_create_tweet_metrics.sql
```

### Step 2: Update Mentions with Dub Reply Tweet IDs

First, you need to track which tweet ID is your dub reply. When posting the dub video, save the tweet ID:

```typescript
// In mentionDaemon.ts or wherever you post the dub reply
const replyTweet = await client.v2.reply(dubVideoWithText, mentionTweetId);

// Save the reply tweet ID
await supabase
  .from('mentions')
  .update({
    dub_reply_tweet_id: replyTweet.data.id,
    dub_reply_tweet_url: `https://twitter.com/dubbingagent/status/${replyTweet.data.id}`
  })
  .eq('tweet_id', mentionTweetId);
```

### Step 3: Collect Metrics

```bash
# Collect metrics for all completed dubs
npx tsx scripts/collect-metrics.ts --include-siblings

# This will:
# 1. Fetch views/likes for mention tweets
# 2. Fetch views/likes for dub reply tweets
# 3. Fetch views/likes for parent tweets
# 4. Sample other comments on parent tweets for comparison
```

**Rate Limiting:** The script respects Twitter's rate limits (900 requests per 15 min). It will pause automatically if rate limited.

### Step 4: Generate Report

```bash
# Generate markdown report
npx tsx scripts/generate-engagement-report.ts

# View report
cat reports/engagement-report.md
```

---

## Report Contents

### Executive Summary
- Total dubs analyzed
- Total views across all dubs
- Average views per dub
- Average conversion rate (dub views / parent views)
- Total likes and retweets

### Top Performing Dubs
Table showing:
- Dub reply views
- Parent tweet views
- Conversion percentage
- Categories
- Target language
- Requesting user

### Dub vs Other Comments
**This is the key comparison showing your competitive advantage!**

Shows:
- Your dub reply views
- Average views of other comments on same parent
- Number of sibling comments sampled
- **Performance multiplier** (how many times more views than average comment)

Example output:
```
| Dub Views | Avg Other Comment Views | Sibling Count | Performance Multiplier |
|-----------|------------------------|---------------|------------------------|
| 45,000    | 2,300                  | 10            | 19.6x                  |
| 32,500    | 1,800                  | 8             | 18.1x                  |
```

### Category Performance
Shows which content categories get the most engagement:
- Cryptocurrencies
- Gaming
- Entertainment
- etc.

### Language Performance
Shows which target languages perform best:
- Spanish (es)
- Japanese (ja)
- Chinese (zh)
- etc.

---

## Example Workflow

### Weekly Metrics Collection

```bash
#!/bin/bash
# weekly-metrics.sh

# Collect metrics with sibling comparison
npx tsx scripts/collect-metrics.ts --include-siblings --sample-size 15

# Generate all report formats
npx tsx scripts/generate-engagement-report.ts markdown
npx tsx scripts/generate-engagement-report.ts html
npx tsx scripts/generate-engagement-report.ts json

# Archive reports with timestamp
TIMESTAMP=$(date +%Y-%m-%d)
cp reports/engagement-report.md reports/archive/report-$TIMESTAMP.md
cp reports/engagement-report.html reports/archive/report-$TIMESTAMP.html

echo "Reports generated and archived!"
```

### Daily Quick Check

```bash
# Collect metrics for recent dubs only
npx tsx scripts/collect-metrics.ts

# Quick preview in terminal
npx tsx scripts/generate-engagement-report.ts | head -50
```

---

## Understanding the Metrics

### Impression Count (Views)
**Most Important!** This is the total number of times the tweet was displayed to users, regardless of engagement.

- High views = Content is being shown to many people
- Dub views / Parent views = Your reach percentage
- Dub views / Avg sibling views = Your competitive advantage

### Like Count
Shows user approval and content quality.

### Retweet Count
Shows content is valuable enough to share.

### Reply Count
Shows content sparks discussion.

---

## Interpreting Results

### Good Performance Indicators

✅ **High conversion rate** (dub views / parent views > 5%)
- Shows your dub is capturing parent tweet's audience

✅ **High multiplier vs siblings** (>10x average comment views)
- Shows your dub stands out from other comments

✅ **Growing trends** (metrics improving over time)
- Shows increasing audience recognition

✅ **Strong category performance** (certain categories consistently high)
- Shows product-market fit for specific content types

### What to Optimize

🔍 **Low conversion rate** (<2%)
- Parent audience may not be interested in dubs
- Consider different content categories

🔍 **Similar to sibling comments** (<3x)
- Dub may not be standing out visually
- Consider thumbnail/video quality improvements

🔍 **Language-specific underperformance**
- May indicate audience mismatch
- Consider focusing on better-performing languages

---

## Sharing Reports

### For Investors/Stakeholders

Use the **HTML report** for visual presentation:
```bash
npx tsx scripts/generate-engagement-report.ts html
open reports/engagement-report.html
```

Key metrics to highlight:
1. **Total views generated**
2. **Performance multiplier vs other comments** (e.g., "19x more views than average comment")
3. **Conversion rate trend** (show growth over time)

### For Marketing

Use the **Markdown report** for easy copying to presentations:
```bash
cat reports/engagement-report.md
```

Pull out key stats:
- "Generated 1.2M views across 50 dubs"
- "Average dub gets 25x more views than other comments"
- "89% of parent tweet views converted to dub views in Crypto category"

### For Development

Use the **JSON report** for programmatic analysis:
```bash
npx tsx scripts/generate-engagement-report.ts json
node -e "console.log(require('./reports/engagement-report.json').summary)"
```

---

## Automation

### Automatic Metrics Collection

Add to cron job or scheduled task:

```bash
# Every 6 hours
0 */6 * * * cd /path/to/project && npx tsx scripts/collect-metrics.ts --include-siblings >> logs/metrics-collection.log 2>&1

# Daily report generation at 8am
0 8 * * * cd /path/to/project && npx tsx scripts/generate-engagement-report.ts html && /usr/bin/mail -s "Daily Engagement Report" team@example.com < reports/engagement-report.html
```

---

## API Access

### Query Metrics Programmatically

```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('URL', 'KEY');

// Get latest metrics for a specific dub
const { data } = await supabase
  .from('tweet_metrics_latest')
  .select('*')
  .eq('mention_id', 'MENTION_TWEET_ID')
  .eq('tweet_type', 'dub_reply')
  .single();

console.log(`Dub views: ${data.impression_count}`);

// Get all dub performance data
const { data: comparison } = await supabase
  .from('dub_engagement_comparison')
  .select('*')
  .order('dub_reply_views', { ascending: false });

// Calculate average multiplier
// (requires sibling metrics collection)
```

---

## Troubleshooting

### No metrics appearing

**Check 1:** Is `dub_reply_tweet_id` populated?
```sql
SELECT tweet_id, dub_reply_tweet_id FROM mentions WHERE status = 'complete' LIMIT 5;
```

If null, update your daemon to save reply tweet IDs.

**Check 2:** Did metrics collection run?
```sql
SELECT COUNT(*) FROM tweet_metrics;
```

If 0, run metrics collection script.

**Check 3:** Twitter API rate limits
Check logs for rate limit errors. Script will auto-pause for 15 minutes.

### Sibling comparison not showing

**Issue:** Need at least 3 sibling comments per mention for comparison.

**Solution:** Run with `--include-siblings` flag:
```bash
npx tsx scripts/collect-metrics.ts --include-siblings --sample-size 15
```

### Metrics seem old

**Issue:** Metrics are point-in-time snapshots.

**Solution:** Run collection regularly to track trends over time. Views typically grow for 24-48 hours after posting.

---

## Performance Notes

### Rate Limits

Twitter API v2 limits:
- 900 requests per 15 minutes
- 300 user timeline requests per 15 minutes

The scripts automatically handle this with delays and backoff.

### Collection Time

Approximate times:
- 100 dubs: ~5 minutes (without siblings)
- 100 dubs with siblings: ~20 minutes (sampling 10 per dub)

### Storage

Database storage per metric record: ~100 bytes

For 100 dubs collected daily:
- ~30KB per day
- ~11MB per year

Very lightweight!

---

## Next Steps

1. **Run migration** to create tables
2. **Update daemon** to save dub reply tweet IDs
3. **Collect initial metrics** for existing dubs
4. **Generate first report** to see baseline
5. **Set up automation** for regular collection
6. **Share results** with stakeholders!

For questions or issues, see `DATABASE_INTEGRATION_GUIDE.md` or check logs.
