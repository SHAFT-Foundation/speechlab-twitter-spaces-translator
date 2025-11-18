# Documentation Index
**Twitter Spaces Translator / Dubbing Agent**

## 📚 Documentation Overview

This project has comprehensive documentation covering all aspects of development, operations, and analytics.

---

## Core Documentation

### 1. [README.md](../README.md)
**Primary project documentation**

- System architecture and data flow
- Setup and configuration instructions
- API integrations (Twitter, ElevenLabs, OpenAI)
- Running the daemon
- Troubleshooting guide

**When to use:** Getting started, understanding the system, initial setup

---

### 2. [OPERATIONS_RUNBOOK.md](../OPERATIONS_RUNBOOK.md)
**Complete operations manual** - 📖 **YOUR GO-TO FOR DAY-TO-DAY OPERATIONS**

**Contents:**
- Daily/Weekly/Monthly operations checklists
- System health monitoring procedures
- Common issues and resolutions (with commands)
- Emergency procedures
- Maintenance tasks
- Performance optimization
- Troubleshooting decision trees

**When to use:**
- Daily system monitoring
- Troubleshooting issues
- Incident response
- Performance problems
- Database maintenance

**Key sections:**
- Issue 1: Daemon Not Running → Resolution steps
- Issue 2: High Failure Rate → Error analysis queries
- Issue 3: Translation Service Failing → API key validation
- Issue 4: Twitter API Rate Limits → Batch size optimization
- Issue 5: Database Connection Issues → Connection pool management
- Issue 6: Missing Dub Reply Tweet IDs → Backfill procedures

---

### 3. [ANALYTICS_SYSTEM.md](../ANALYTICS_SYSTEM.md)
**Analytics and engagement tracking guide**

**Contents:**
- Key metrics tracked (views, likes, retweets, replies)
- System components (database, services, scripts)
- Getting started with analytics
- Report generation (mention engagement, user-specific, verification)
- Translation system
- Understanding metrics and interpreting results

**When to use:**
- Generating engagement reports
- Understanding tweet performance
- Analyzing dub effectiveness vs other comments
- Translating parent tweets
- Sharing reports with stakeholders

**Key scripts:**
- `collect-mention-metrics.ts` - Collect engagement data
- `generate-mention-engagement-report.ts` - HTML reports
- `generate-user-report.ts` - User-specific analytics
- `translate-parent-tweets.ts` - Backfill translations

---

### 4. [SCHEMA_DOCUMENTATION.md](../SCHEMA_DOCUMENTATION.md)
**Database schema reference**

**Contents:**
- Complete `mentions` table schema
- `tweet_metrics` table structure
- `category_mappings` table
- Database views (tweet_metrics_latest, dub_engagement_comparison)
- Migration instructions
- Query examples
- External integrations
- Performance considerations

**When to use:**
- Writing custom queries
- Understanding database structure
- Running migrations
- Database maintenance
- Creating new analytics queries

**Key queries:**
- Get completed dubs with metrics
- Get mentions for specific user
- Get trending categories
- Get language performance

---

## Operational Scripts

### Monitoring & Health

| Script | Purpose | Frequency | Command |
|--------|---------|-----------|---------|
| `health-check.ts` | System health status | Daily | `npx tsx scripts/health-check.ts` |
| `check-recent-mentions.ts` | Recent activity analysis (7 days) | Daily/Weekly | `npx tsx scripts/check-recent-mentions.ts` |
| `check-and-backfill-today.ts` | Today's data status | As needed | `npx tsx scripts/check-and-backfill-today.ts` |

### Data Collection

| Script | Purpose | Frequency | Command |
|--------|---------|-----------|---------|
| `collect-mention-metrics.ts` | Collect engagement metrics | Weekly | `npx tsx scripts/collect-mention-metrics.ts` |
| `translate-parent-tweets.ts` | Backfill translations (last 2 weeks) | Weekly | `npx tsx scripts/translate-parent-tweets.ts` |
| `backfill-dub-reply-tweet-ids-timeline.ts` | Backfill reply tweet IDs | As needed | `npx tsx scripts/backfill-dub-reply-tweet-ids-timeline.ts` |

### Reporting

| Script | Purpose | Output | Command |
|--------|---------|--------|---------|
| `generate-mention-engagement-report.ts` | Overall engagement report | `reports/mention-engagement-report.html` | `npx tsx scripts/generate-mention-engagement-report.ts` |
| `generate-user-report.ts` | User-specific analytics | `reports/{username}-engagement-report.html` | `npx tsx scripts/generate-user-report.ts MarioNawfal` |
| `generate-verification-report.ts` | Detailed verification report | `reports/verification-report.html` | `npx tsx scripts/generate-verification-report.ts` |

---

## Quick Reference

### Daily Operations (5 minutes)

```bash
# 1. Check system health
npx tsx scripts/health-check.ts

# 2. View recent activity
npx tsx scripts/check-recent-mentions.ts

# 3. Check daemon is running
ps aux | grep mentionDaemon
```

### Weekly Analytics (30 minutes)

```bash
# 1. Collect metrics for recent mentions
npx tsx scripts/collect-mention-metrics.ts

# 2. Generate reports
npx tsx scripts/generate-mention-engagement-report.ts

# 3. View report
open reports/mention-engagement-report.html
```

### Monthly Maintenance (1-2 hours)

```bash
# 1. Backfill historical data
npx tsx scripts/translate-parent-tweets.ts
npx tsx scripts/backfill-dub-reply-tweet-ids-timeline.ts

# 2. Database optimization
# See OPERATIONS_RUNBOOK.md → Database Maintenance

# 3. Archive old reports
mkdir -p reports/archive/$(date +%Y-%m)
mv reports/*.html reports/archive/$(date +%Y-%m)/
```

---

## Common Workflows

### Troubleshooting Performance Issues

1. Run health check: `npx tsx scripts/health-check.ts`
2. Check for errors in [OPERATIONS_RUNBOOK.md](../OPERATIONS_RUNBOOK.md)
3. Review daemon logs: `tail -100 logs/daemon.log`
4. Check database status in Supabase dashboard

### Generating Analytics for Stakeholders

1. Collect latest metrics: `npx tsx scripts/collect-mention-metrics.ts`
2. Generate HTML report: `npx tsx scripts/generate-mention-engagement-report.ts`
3. For specific user: `npx tsx scripts/generate-user-report.ts MarioNawfal`
4. Open and share: `open reports/mention-engagement-report.html`

### Backfilling Missing Data

1. Check what's missing: `npx tsx scripts/check-recent-mentions.ts`
2. Translate parent tweets: `npx tsx scripts/translate-parent-tweets.ts`
3. Collect metrics: `npx tsx scripts/collect-mention-metrics.ts`
4. Backfill reply IDs: `npx tsx scripts/backfill-dub-reply-tweet-ids-timeline.ts`

### Emergency Response

1. Stop daemon: `pm2 stop dubbing-daemon`
2. Check health: `npx tsx scripts/health-check.ts`
3. Follow [OPERATIONS_RUNBOOK.md](../OPERATIONS_RUNBOOK.md) → Emergency Procedures
4. Restart daemon: `pm2 restart dubbing-daemon`
5. Monitor logs: `pm2 logs dubbing-daemon`

---

## Key Metrics to Monitor

### System Health
- ✅ Database connectivity
- ✅ Recent activity (new mentions in last hour)
- ⚠️ Failed mentions (should be <5 in 24h)
- ✅ Translation coverage (should be >90%)
- ✅ Metrics coverage (should be >50%)
- ✅ Average processing time (should be <15 min)

### Processing Pipeline
- Complete: 60-80% (expected)
- Processing: 10-20% (expected)
- Failed: <5% (expected)
- Final Failure: <2% (expected)

### Engagement Performance
- **Dub views vs parent views:** 5-20% conversion rate
- **Dub views vs other comments:** 10-25x multiplier
- **Top performing categories:** Crypto, Gaming, Tech
- **Top performing languages:** Spanish (es_la), Portuguese (pt_br), Japanese (ja)

---

## Getting Help

### Self-Service
1. Check [OPERATIONS_RUNBOOK.md](../OPERATIONS_RUNBOOK.md) for issue
2. Run `npx tsx scripts/health-check.ts`
3. Search documentation for error message
4. Check relevant logs

### Escalation
1. GitHub Issues: https://github.com/SHAFT-Foundation/speechlab-twitter-spaces-translator/issues
2. Include:
   - Health check output
   - Relevant log excerpts
   - Steps to reproduce
   - Expected vs actual behavior

---

## Documentation Maintenance

### When to Update

**README.md:**
- New features added
- Architecture changes
- Setup/configuration changes

**OPERATIONS_RUNBOOK.md:**
- New common issues discovered
- Updated resolution procedures
- New monitoring scripts

**ANALYTICS_SYSTEM.md:**
- New metrics added
- New report types
- Updated analysis methods

**SCHEMA_DOCUMENTATION.md:**
- Database schema changes
- New migrations
- Updated query examples

### Update Checklist
- [ ] Update documentation
- [ ] Update this index if needed
- [ ] Test all commands/scripts referenced
- [ ] Commit with clear message: `docs: [brief description]`

---

**Last Updated:** 2025-11-17
**Version:** 1.0
**Maintained By:** Operations Team

