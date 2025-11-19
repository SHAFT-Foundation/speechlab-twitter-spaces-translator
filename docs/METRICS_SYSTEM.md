# Metrics Tracking System

## Overview

This system tracks engagement metrics (views, likes, retweets, replies) for dubbed video replies over time, allowing you to:
- Identify top-performing dubbed content
- Track view count growth over time
- Analyze engagement patterns
- Export data for reporting

## Architecture

### Components

1. **tweetMetricsService.ts** - Core service for fetching/saving metrics
2. **metricsDaemon.ts** - Background daemon that polls every 30 minutes
3. **backfill-dub-reply-views.ts** - One-time script to populate historical data
4. **Database Function** - `get_top_dub_replies()` - Efficiently queries top videos

### Database Schema

The `tweet_metrics` table stores time-series data:

```sql
- tweet_id: ID of the tweet being tracked
- tweet_type: 'dub_reply' for our dubbed videos
- mention_id: Links back to the original mention
- impression_count: VIEW COUNT (primary metric)
- like_count, retweet_count, reply_count, quote_count
- collected_at: Timestamp of when metrics were captured
```

## Setup

### 1. Run Database Migration

First, create the database function:

```bash
# Run this SQL in Supabase SQL Editor
cat migrations/create_top_dub_replies_function.sql
```

### 2. Add Required Environment Variables

Ensure your `.env` has:
```bash
SUPABASE_URL=your_url
SUPABASE_SERVICE_KEY=your_key
TWITTER_API_KEY=your_key
TWITTER_API_SECRET=your_secret
TWITTER_ACCESS_TOKEN=your_token
TWITTER_ACCESS_SECRET=your_secret
```

### 3. Backfill Historical Data

Populate metrics for all existing dub replies:

```bash
npx tsx scripts/backfill-dub-reply-views.ts
```

This will:
- Find all completed mentions with `dub_reply_tweet_id`
- Fetch current metrics from Twitter API
- Store in `tweet_metrics` table
- Skip tweets with metrics collected in last hour
- Rate limit: 5 seconds between requests

**Expected runtime**: ~5 seconds per tweet (rate limiting)

### 4. Start Metrics Daemon

Run continuously to track metrics over time:

```bash
npx tsx src/metricsDaemon.ts
```

The daemon will:
- Poll every 30 minutes
- Track all completed dub replies
- Store timestamped metrics for historical analysis
- Handle rate limiting automatically

**Running as a service**:
```bash
# Using PM2
pm2 start src/metricsDaemon.ts --name metrics-daemon --interpreter tsx

# Or nohup
nohup npx tsx src/metricsDaemon.ts > logs/metrics-daemon.log 2>&1 &
```

## Usage

### View Top Videos

Display top videos in terminal:

```bash
# Top 20 (default)
npx tsx scripts/show-top-dub-videos.ts

# Top 50
npx tsx scripts/show-top-dub-videos.ts 50
```

Output:
```
╔════════════════════════════════════════════════════════════╗
║          TOP DUBBED VIDEOS BY VIEW COUNT                  ║
╚════════════════════════════════════════════════════════════╝

1. 👁️  1,245,678 views | ❤️  3,421 | 🔁 892 | 💬 234
   @username → spanish
   🔗 https://twitter.com/dubbingagent/status/123...
   📝 Original: "Check out this amazing video..."
   🎥 ElevenLabs: https://elevenlabs.io/...
   📊 Last updated: 11/18/2025, 2:30:00 PM
```

### Export Data

Export to JSON or CSV:

```bash
# Export to JSON (default 100 videos)
npx tsx scripts/export-top-videos.ts json

# Export to CSV (top 50)
npx tsx scripts/export-top-videos.ts csv 50
```

Files saved to: `exports/top-dub-videos-YYYY-MM-DD.{json,csv}`

### Query Database Directly

Using the database function:

```sql
-- Top 20 dub replies
SELECT * FROM get_top_dub_replies(20);

-- Get specific video's metrics history
SELECT
    impression_count,
    like_count,
    collected_at
FROM tweet_metrics
WHERE tweet_id = '1234567890'
  AND tweet_type = 'dub_reply'
ORDER BY collected_at DESC;

-- View count growth rate
WITH metrics_timeline AS (
    SELECT
        tweet_id,
        impression_count,
        collected_at,
        LAG(impression_count) OVER (PARTITION BY tweet_id ORDER BY collected_at) as prev_count,
        LAG(collected_at) OVER (PARTITION BY tweet_id ORDER BY collected_at) as prev_time
    FROM tweet_metrics
    WHERE tweet_type = 'dub_reply'
)
SELECT
    tweet_id,
    impression_count - COALESCE(prev_count, 0) as views_gained,
    EXTRACT(EPOCH FROM (collected_at - prev_time)) / 3600 as hours_elapsed,
    (impression_count - COALESCE(prev_count, 0)) / NULLIF(EXTRACT(EPOCH FROM (collected_at - prev_time)) / 3600, 0) as views_per_hour
FROM metrics_timeline
WHERE prev_count IS NOT NULL
ORDER BY views_gained DESC
LIMIT 20;
```

## Monitoring

### Check Daemon Status

```bash
# If using PM2
pm2 status metrics-daemon
pm2 logs metrics-daemon

# Check last collection time
psql $DATABASE_URL -c "
SELECT MAX(collected_at) as last_collection
FROM tweet_metrics
WHERE tweet_type = 'dub_reply';
"
```

### Metrics Collection Rate

Expected API usage:
- Number of dub replies × Collections per day
- Example: 100 dub replies × 48 collections/day = 4,800 API calls/day
- Twitter API v2 limit: 300 requests per 15 min = 28,800 per day
- **Well within limits** with 5 second delay

## Troubleshooting

### Rate Limiting

If you hit rate limits:
1. Daemon automatically waits 15 minutes
2. Increase `RATE_LIMIT_DELAY_MS` in metricsDaemon.ts
3. Reduce `POLL_INTERVAL_MS` (poll less frequently)

### Missing Metrics

If videos don't show up:
```bash
# Check if dub_reply_tweet_id is set
npx tsx scripts/check-specific-tweet.ts <mention_tweet_id>

# Manually backfill specific mention
npx tsx -e "
import { trackDubReplyMetrics } from './src/services/tweetMetricsService';
await trackDubReplyMetrics('dub_reply_tweet_id', 'mention_id');
"
```

### Database Function Missing

Re-run migration:
```bash
cat migrations/create_top_dub_replies_function.sql | psql $DATABASE_URL
```

## Analytics Ideas

### View Growth Analysis
Track how quickly videos gain views in first 24/48/72 hours

### Engagement Rate
Compare views vs. likes/retweets to find most engaging content

### Language Performance
Which target languages get the most views?

```sql
SELECT
    m.target_language,
    COUNT(*) as video_count,
    AVG(tm.impression_count) as avg_views,
    SUM(tm.impression_count) as total_views
FROM (
    SELECT DISTINCT ON (tweet_id)
        tweet_id, impression_count
    FROM tweet_metrics
    WHERE tweet_type = 'dub_reply'
    ORDER BY tweet_id, collected_at DESC
) tm
JOIN mentions m ON tm.tweet_id = m.dub_reply_tweet_id
GROUP BY m.target_language
ORDER BY total_views DESC;
```

### Category Performance
Which content categories perform best?

```sql
SELECT
    m.parent_tweet_category,
    COUNT(*) as video_count,
    AVG(tm.impression_count) as avg_views
FROM (
    SELECT DISTINCT ON (tweet_id)
        tweet_id, impression_count, mention_id
    FROM tweet_metrics
    WHERE tweet_type = 'dub_reply'
    ORDER BY tweet_id, collected_at DESC
) tm
JOIN mentions m ON tm.mention_id = m.tweet_id
WHERE m.parent_tweet_category IS NOT NULL
GROUP BY m.parent_tweet_category
ORDER BY avg_views DESC;
```

## Roadmap

Future enhancements:
- [ ] Track parent tweet metrics for comparison
- [ ] Calculate view conversion rate (parent views → dub views)
- [ ] Alert on viral videos (rapid view growth)
- [ ] A/B testing different languages/categories
- [ ] Predict view counts using historical patterns
- [ ] Dashboard with charts/graphs
