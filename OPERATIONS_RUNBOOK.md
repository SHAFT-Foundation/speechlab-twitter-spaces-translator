# Operations Runbook
**Twitter Spaces Translator / Dubbing Agent System**

## Table of Contents
1. [System Overview](#system-overview)
2. [Daily Operations](#daily-operations)
3. [Monitoring & Health Checks](#monitoring--health-checks)
4. [Common Issues & Resolutions](#common-issues--resolutions)
5. [Emergency Procedures](#emergency-procedures)
6. [Maintenance Tasks](#maintenance-tasks)
7. [Performance Optimization](#performance-optimization)
8. [Troubleshooting Decision Trees](#troubleshooting-decision-trees)

---

## System Overview

### Core Components

| Component | Purpose | Status Check |
|-----------|---------|--------------|
| **Mention Daemon** | Monitors @dubbingagent mentions, processes dubbing requests | `ps aux \| grep mentionDaemon` |
| **ElevenLabs API** | Video dubbing service | Check `third_party_id` population |
| **Twitter API** | Fetch mentions, post replies, collect metrics | Check rate limit status |
| **Supabase DB** | PostgreSQL database for mentions, metrics | Query `mentions` table |
| **OpenAI API** | Parent tweet translation | Check translation completion |

### System Architecture
```
Twitter → Mention Daemon → ElevenLabs → Video Processing → Twitter Reply
                ↓                                              ↓
           Supabase DB ← Translation (OpenAI)         Metrics Collection
```

---

## Daily Operations

### Morning Checklist (5 minutes)

```bash
# 1. Check system health
npx tsx scripts/check-recent-mentions.ts

# 2. Review failed mentions
psql $DATABASE_URL -c "SELECT tweet_id, error_message, retry_count FROM mentions WHERE status IN ('failed', 'final_failure') AND created_at > NOW() - INTERVAL '24 hours';"

# 3. Check daemon is running
ps aux | grep mentionDaemon
# If not running: npm run daemon:start

# 4. Check translation coverage
npx tsx scripts/check-recent-mentions.ts | grep "Translated:"

# 5. Review metrics collection
tail -f logs/metrics-collection.log
```

### Weekly Tasks (30 minutes)

```bash
# 1. Collect metrics for all recent mentions
npx tsx scripts/collect-mention-metrics.ts

# 2. Generate analytics reports
npx tsx scripts/generate-mention-engagement-report.ts
npx tsx scripts/generate-verification-report.ts

# 3. Review top performers
npx tsx scripts/generate-user-report.ts MarioNawfal

# 4. Database cleanup (optional)
# Remove old metrics older than 90 days
psql $DATABASE_URL -c "DELETE FROM tweet_metrics WHERE collected_at < NOW() - INTERVAL '90 days';"

# 5. Check storage usage
du -sh reports/ logs/
```

### Monthly Tasks (1-2 hours)

```bash
# 1. Backfill historical data (if needed)
npx tsx scripts/translate-parent-tweets.ts
npx tsx scripts/backfill-dub-reply-tweet-ids-timeline.ts

# 2. Database maintenance
psql $DATABASE_URL -c "VACUUM ANALYZE mentions;"
psql $DATABASE_URL -c "VACUUM ANALYZE tweet_metrics;"

# 3. Review API costs
# Check OpenAI usage dashboard
# Check ElevenLabs usage dashboard

# 4. Archive old reports
mkdir -p reports/archive/$(date +%Y-%m)
mv reports/*.html reports/archive/$(date +%Y-%m)/

# 5. Review system performance
# Check average processing time
# Identify bottlenecks
```

---

## Monitoring & Health Checks

### Automated Health Check Script

Create `scripts/health-check.ts`:

```typescript
#!/usr/bin/env tsx
import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function healthCheck() {
    const checks = {
        database: false,
        recent_mentions: false,
        failed_mentions: 0,
        translation_rate: 0,
        metrics_rate: 0
    };

    try {
        // 1. Database connectivity
        const { data, error } = await supabase.from('mentions').select('count').limit(1);
        checks.database = !error;

        // 2. Recent mentions (last hour)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: recentMentions } = await supabase
            .from('mentions')
            .select('*')
            .gte('created_at', oneHourAgo);

        checks.recent_mentions = (recentMentions?.length || 0) > 0;

        // 3. Failed mentions (last 24 hours)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: failedMentions } = await supabase
            .from('mentions')
            .select('count')
            .in('status', ['failed', 'final_failure'])
            .gte('created_at', oneDayAgo);

        checks.failed_mentions = failedMentions?.length || 0;

        // 4. Translation coverage
        const { data: complete } = await supabase
            .from('mentions')
            .select('count')
            .eq('status', 'complete')
            .gte('created_at', oneDayAgo);

        const { data: translated } = await supabase
            .from('mentions')
            .select('count')
            .eq('status', 'complete')
            .not('parent_tweet_text_translated', 'is', null)
            .gte('created_at', oneDayAgo);

        checks.translation_rate = (translated?.length || 0) / (complete?.length || 1) * 100;

        // 5. Print report
        console.log('\n========================================');
        console.log('🏥 System Health Check');
        console.log('========================================');
        console.log(`Database: ${checks.database ? '✅ Connected' : '❌ Failed'}`);
        console.log(`Recent Activity: ${checks.recent_mentions ? '✅ Active' : '⚠️  No mentions in last hour'}`);
        console.log(`Failed Mentions (24h): ${checks.failed_mentions > 5 ? '⚠️' : '✅'} ${checks.failed_mentions}`);
        console.log(`Translation Coverage: ${checks.translation_rate > 80 ? '✅' : '⚠️'} ${checks.translation_rate.toFixed(1)}%`);
        console.log('========================================\n');

        // Exit with error if critical issues
        if (!checks.database || checks.failed_mentions > 10) {
            process.exit(1);
        }

    } catch (error) {
        logger.error('Health check failed:', error);
        process.exit(1);
    }
}

healthCheck();
```

Run with: `npx tsx scripts/health-check.ts`

### Key Metrics to Monitor

#### 1. Processing Pipeline Health

```sql
-- Check mention distribution by status
SELECT
    status,
    COUNT(*) as count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
FROM mentions
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY status
ORDER BY count DESC;
```

**Expected:**
- `complete`: 60-80%
- `processing`: 10-20%
- `failed`: <5%
- `final_failure`: <2%

#### 2. Translation Coverage

```sql
SELECT
    COUNT(*) as total_complete,
    COUNT(parent_tweet_text_translated) as translated,
    ROUND(100.0 * COUNT(parent_tweet_text_translated) / COUNT(*), 2) as coverage_pct
FROM mentions
WHERE status = 'complete'
AND created_at > NOW() - INTERVAL '7 days';
```

**Expected:** >90% coverage for recent mentions

#### 3. Metrics Collection Status

```sql
SELECT
    COUNT(DISTINCT m.tweet_id) as total_mentions,
    COUNT(DISTINCT tm.mention_id) as with_metrics,
    ROUND(100.0 * COUNT(DISTINCT tm.mention_id) / COUNT(DISTINCT m.tweet_id), 2) as coverage_pct
FROM mentions m
LEFT JOIN tweet_metrics tm ON m.tweet_id = tm.mention_id
WHERE m.status = 'complete'
AND m.created_at > NOW() - INTERVAL '7 days';
```

**Expected:** >50% coverage (metrics collection runs periodically)

#### 4. Average Processing Time

```sql
SELECT
    AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/60) as avg_minutes,
    MIN(EXTRACT(EPOCH FROM (updated_at - created_at))/60) as min_minutes,
    MAX(EXTRACT(EPOCH FROM (updated_at - created_at))/60) as max_minutes
FROM mentions
WHERE status = 'complete'
AND created_at > NOW() - INTERVAL '24 hours';
```

**Expected:** 5-15 minutes average

---

## Common Issues & Resolutions

### Issue 1: Daemon Not Running

**Symptoms:**
- No new mentions being processed
- `ps aux | grep mentionDaemon` returns nothing

**Diagnosis:**
```bash
# Check if process exists
ps aux | grep mentionDaemon

# Check logs
tail -100 logs/daemon.log
```

**Resolution:**
```bash
# Start daemon
npm run daemon:start

# Or with PM2
pm2 start npm --name "dubbing-daemon" -- run daemon:start
pm2 save
```

**Prevention:**
- Set up process monitoring with PM2
- Configure auto-restart on failure
- Set up monitoring alerts

---

### Issue 2: High Failure Rate

**Symptoms:**
- Many mentions stuck in `failed` or `final_failure` status
- Error messages in database

**Diagnosis:**
```sql
-- Get top error messages
SELECT
    error_message,
    COUNT(*) as occurrences,
    MAX(created_at) as last_occurrence
FROM mentions
WHERE status IN ('failed', 'final_failure')
AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY error_message
ORDER BY occurrences DESC
LIMIT 10;
```

**Common Errors & Resolutions:**

#### A. "Failed to post reply"
**Cause:** Twitter API authentication or rate limit issues

**Resolution:**
```bash
# Check Twitter API credentials
env | grep TWITTER

# Test Twitter connection
npx tsx scripts/test-twitter-connection.ts

# Check rate limit status
curl -H "Authorization: Bearer $TWITTER_BEARER_TOKEN" \
  "https://api.twitter.com/2/tweets/search/recent?query=test&max_results=10"
```

#### B. "ElevenLabs processing timeout"
**Cause:** Video too long or ElevenLabs service issues

**Resolution:**
```bash
# Check ElevenLabs status
curl https://api.elevenlabs.io/v1/user

# Retry failed mentions manually
psql $DATABASE_URL -c "UPDATE mentions SET status='pending', retry_count=0 WHERE tweet_id='TWEET_ID';"
```

#### C. "No video found in parent tweet"
**Cause:** Parent tweet doesn't contain video

**Resolution:**
```bash
# This is expected behavior - mark as skipped
psql $DATABASE_URL -c "UPDATE mentions SET status='skipped_no_video' WHERE error_message LIKE '%No video%';"
```

---

### Issue 3: Translation Service Failing

**Symptoms:**
- `parent_tweet_text_translated` is NULL for recent mentions
- OpenAI errors in logs

**Diagnosis:**
```bash
# Check OpenAI API key
env | grep OPENAI_API_KEY

# Test translation
npx tsx scripts/translate-parent-tweets.ts --test
```

**Resolution:**

#### A. API Key Invalid
```bash
# Verify API key
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer $OPENAI_API_KEY"

# If invalid, update .env file
nano .env
# Update OPENAI_API_KEY=sk-...

# Restart daemon
pm2 restart dubbing-daemon
```

#### B. Rate Limit Exceeded
```bash
# Check usage
# Visit: https://platform.openai.com/usage

# Temporarily increase timeout in translationService.ts
# Or upgrade OpenAI plan
```

#### C. Backfill Translations
```bash
# Run backfill for missing translations
npx tsx scripts/translate-parent-tweets.ts
```

---

### Issue 4: Twitter API Rate Limits

**Symptoms:**
- Metrics collection paused frequently
- "Rate limited" messages in logs
- Twitter API errors

**Diagnosis:**
```bash
# Check current rate limit status
tail -f logs/metrics-collection.log | grep "Rate limit"

# Check how many requests we're making
tail -100 logs/metrics-collection.log | grep "Fetching" | wc -l
```

**Resolution:**

#### Immediate:
```bash
# Wait for rate limit to reset (15 minutes)
# Scripts automatically handle this

# Or reduce batch size
npx tsx scripts/collect-mention-metrics.ts --batch-size 25
```

#### Long-term:
1. **Reduce sampling:** Decrease sibling comment samples from 10 to 5
2. **Increase delays:** Add longer delays between requests
3. **Batch processing:** Process metrics during off-peak hours
4. **Upgrade Twitter API tier:** Purchase elevated access

**Edit `src/services/twitterMetricsService.ts`:**
```typescript
// Reduce sibling samples
const SIBLING_SAMPLE_SIZE = 5; // Was 10

// Increase delay
await sleep(2000); // Was 1000
```

---

### Issue 5: Database Connection Issues

**Symptoms:**
- "Connection refused" errors
- Timeouts on queries
- Cannot connect to Supabase

**Diagnosis:**
```bash
# Test database connection
psql $DATABASE_URL -c "SELECT NOW();"

# Check connection pool
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'postgres';"
```

**Resolution:**

#### A. Supabase Service Down
```bash
# Check Supabase status
# Visit: https://status.supabase.com/

# Wait for service restoration
```

#### B. Connection Pool Exhausted
```sql
-- Kill idle connections
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'postgres'
AND state = 'idle'
AND state_change < NOW() - INTERVAL '10 minutes';
```

#### C. Network Issues
```bash
# Test network connectivity
ping cemuqqzmamjmtefodbqs.supabase.co

# Check firewall rules
# Check VPN connection if applicable
```

---

### Issue 6: Missing Dub Reply Tweet IDs

**Symptoms:**
- `dub_reply_tweet_id` is NULL for completed mentions
- Analytics reports show missing data

**Diagnosis:**
```sql
SELECT
    COUNT(*) as total_complete,
    COUNT(dub_reply_tweet_id) as with_reply_id,
    ROUND(100.0 * COUNT(dub_reply_tweet_id) / COUNT(*), 2) as coverage
FROM mentions
WHERE status = 'complete';
```

**Resolution:**
```bash
# Backfill using timeline method (most reliable)
npx tsx scripts/backfill-dub-reply-tweet-ids-timeline.ts

# Or search method (last 7 days only)
npx tsx scripts/backfill-dub-reply-tweet-ids.ts
```

---

## Emergency Procedures

### System Down / Not Responding

1. **Check daemon status:**
   ```bash
   pm2 status
   pm2 logs dubbing-daemon --lines 100
   ```

2. **Restart daemon:**
   ```bash
   pm2 restart dubbing-daemon
   ```

3. **Check database:**
   ```bash
   psql $DATABASE_URL -c "SELECT COUNT(*) FROM mentions;"
   ```

4. **If database is down:**
   - Check Supabase dashboard
   - Check status page
   - Contact Supabase support

5. **If APIs are failing:**
   - Check Twitter API status
   - Check ElevenLabs status
   - Check OpenAI status

### Data Loss / Corruption

1. **Assess damage:**
   ```sql
   SELECT status, COUNT(*) FROM mentions GROUP BY status;
   ```

2. **Check backups:**
   - Supabase automatic backups (last 7 days)
   - Export current state before restoration

3. **Restore from backup:**
   ```bash
   # Via Supabase dashboard: Database > Backups
   # Select backup and restore
   ```

### Critical Bug in Production

1. **Stop daemon immediately:**
   ```bash
   pm2 stop dubbing-daemon
   ```

2. **Identify affected mentions:**
   ```sql
   SELECT * FROM mentions
   WHERE status = 'processing'
   AND updated_at > 'TIMESTAMP_OF_BUG';
   ```

3. **Reset affected mentions:**
   ```sql
   UPDATE mentions
   SET status = 'pending', retry_count = 0, error_message = NULL
   WHERE tweet_id IN (...);
   ```

4. **Deploy hotfix:**
   ```bash
   git checkout hotfix-branch
   npm install
   npm run build
   pm2 restart dubbing-daemon
   ```

5. **Monitor closely:**
   ```bash
   pm2 logs dubbing-daemon --lines 1000
   ```

---

## Maintenance Tasks

### Database Maintenance

#### Vacuum and Analyze (Monthly)
```sql
VACUUM ANALYZE mentions;
VACUUM ANALYZE tweet_metrics;
VACUUM ANALYZE category_mappings;
```

#### Rebuild Indexes (Quarterly)
```sql
REINDEX TABLE mentions;
REINDEX TABLE tweet_metrics;
```

#### Archive Old Data (Quarterly)
```sql
-- Export old metrics to CSV
COPY (
    SELECT * FROM tweet_metrics
    WHERE collected_at < NOW() - INTERVAL '180 days'
) TO '/tmp/tweet_metrics_archive.csv' CSV HEADER;

-- Delete after confirming export
DELETE FROM tweet_metrics
WHERE collected_at < NOW() - INTERVAL '180 days';
```

### Log Rotation

```bash
# Add to crontab
0 0 * * 0 find logs/ -name "*.log" -mtime +30 -exec gzip {} \;
0 0 1 * * find logs/ -name "*.log.gz" -mtime +90 -delete
```

### API Key Rotation

**OpenAI:**
1. Generate new key: https://platform.openai.com/api-keys
2. Update `.env` file
3. Restart daemon
4. Delete old key

**Twitter:**
1. Generate new tokens: https://developer.twitter.com
2. Update `.env` file
3. Restart daemon
4. Revoke old tokens

**Supabase:**
1. Generate new service role key
2. Update scripts
3. Test connection
4. Revoke old key

---

## Performance Optimization

### 1. Reduce API Calls

**Problem:** Too many Twitter API calls hitting rate limits

**Solution:**
```typescript
// Batch tweet lookups
const tweetIds = mentions.map(m => m.tweet_id);
const tweets = await client.v2.tweets(tweetIds, {
    'tweet.fields': 'public_metrics'
});
```

### 2. Database Query Optimization

**Problem:** Slow queries on large tables

**Solution:**
```sql
-- Add composite indexes
CREATE INDEX idx_mentions_status_created
ON mentions(status, created_at DESC);

CREATE INDEX idx_metrics_mention_collected
ON tweet_metrics(mention_id, collected_at DESC);
```

### 3. Caching Frequently Accessed Data

**Problem:** Repeatedly fetching same parent tweet data

**Solution:**
```typescript
// In-memory cache with TTL
const parentCache = new Map();

async function getParentTweet(tweetId: string) {
    if (parentCache.has(tweetId)) {
        return parentCache.get(tweetId);
    }
    const tweet = await fetchTweet(tweetId);
    parentCache.set(tweetId, tweet);
    setTimeout(() => parentCache.delete(tweetId), 3600000); // 1 hour TTL
    return tweet;
}
```

### 4. Parallel Processing

**Problem:** Sequential processing is slow

**Solution:**
```typescript
// Process mentions in parallel batches
const batchSize = 5;
for (let i = 0; i < mentions.length; i += batchSize) {
    const batch = mentions.slice(i, i + batchSize);
    await Promise.all(batch.map(m => processMention(m)));
}
```

---

## Troubleshooting Decision Trees

### Mention Not Processing

```
Is daemon running?
├─ NO → Start daemon → Check logs
└─ YES → Check mention status in DB
    ├─ pending → Should process soon (check daemon logs)
    ├─ processing → Check how long it's been processing
    │   ├─ < 20 min → Wait
    │   └─ > 20 min → Check ElevenLabs status
    ├─ failed → Check error_message
    │   ├─ retry_count < 3 → Set to pending to retry
    │   └─ retry_count >= 3 → Manual investigation needed
    └─ final_failure → Check error_message → Manual fix required
```

### Analytics Report Showing No Data

```
Are mentions complete?
├─ NO → Wait for processing
└─ YES → Check metrics collection
    ├─ No metrics → Run: collect-mention-metrics.ts
    ├─ No translations → Run: translate-parent-tweets.ts
    └─ No dub reply IDs → Run: backfill-dub-reply-tweet-ids-timeline.ts
```

### High Memory Usage

```
Check process memory
├─ > 2GB → Potential memory leak
│   ├─ Check for unclosed connections
│   ├─ Check for large arrays in memory
│   └─ Restart daemon
└─ Normal → Monitor over time
```

---

## Monitoring Dashboard Setup

### Using PM2 Plus (Recommended)

```bash
# Install PM2 Plus
pm2 install pm2-logrotate
pm2 install pm2-server-monit

# Link to PM2 Plus dashboard
pm2 plus

# Configure alerts
pm2 set pm2-plus:threshold 80  # CPU threshold
pm2 set pm2-plus:memory 1024   # Memory threshold (MB)
```

### Custom Monitoring Script

```bash
#!/bin/bash
# Save as: scripts/monitor.sh

while true; do
    clear
    echo "========================================="
    echo "Dubbing Agent System Monitor"
    echo "========================================="
    echo "Time: $(date)"
    echo ""

    echo "Daemon Status:"
    pm2 status | grep dubbing-daemon
    echo ""

    echo "Recent Mentions:"
    psql $DATABASE_URL -c "SELECT status, COUNT(*) FROM mentions WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY status;"
    echo ""

    echo "Translation Coverage:"
    psql $DATABASE_URL -c "SELECT COUNT(*) FILTER (WHERE parent_tweet_text_translated IS NOT NULL) * 100.0 / COUNT(*) as pct FROM mentions WHERE status='complete' AND created_at > NOW() - INTERVAL '24 hours';"
    echo ""

    sleep 60
done
```

Run with: `bash scripts/monitor.sh`

---

## Contact & Escalation

### Internal Team
- **Primary Engineer:** [Contact Info]
- **Backup Engineer:** [Contact Info]
- **Database Admin:** [Contact Info]

### External Services
- **Supabase Support:** https://supabase.com/support
- **Twitter API Support:** https://developer.twitter.com/support
- **ElevenLabs Support:** support@elevenlabs.io
- **OpenAI Support:** https://help.openai.com/

### On-Call Procedures
1. Check #alerts channel in Slack
2. Follow this runbook
3. If unresolved in 30 minutes, escalate to backup engineer
4. Document all actions taken
5. Post-incident review within 24 hours

---

**Last Updated:** 2025-11-17
**Version:** 1.0
**Maintained By:** Operations Team

