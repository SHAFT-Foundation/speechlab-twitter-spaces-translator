# Database Schema Documentation

## Overview
Complete database schema for the Twitter Spaces Translator / Dubbing Agent system.

---

## Tables

### `mentions`
Primary table tracking all @dubbingagent mentions and dubbing requests.

```sql
CREATE TABLE mentions (
    -- Core Identification
    tweet_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    tweet_url TEXT NOT NULL,
    tweet_text TEXT NOT NULL,
    twitter_profile_image_url TEXT,

    -- Parent Tweet Information
    parent_username TEXT,
    parent_tweet_url TEXT,
    parent_tweet_text TEXT,
    parent_tweet_text_translated TEXT,  -- NEW: Translated to target language
    parent_video_preview_url TEXT,      -- NEW: Preview/thumbnail URL for videos in parent tweet
    parent_tweet_category TEXT,
    parent_tweet_category_id TEXT,
    parent_tweet_domains JSONB,
    custom_category TEXT[],

    -- Dub Reply Tracking (NEW)
    dub_reply_tweet_id TEXT,  -- Tweet ID of bot's video reply
    dub_reply_tweet_url TEXT, -- URL to bot's video reply

    -- Processing Status
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'initiating', 'processing',
        'complete', 'failed', 'final_failure', 'skipped_no_video'
    )),
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,

    -- Third-Party Service
    third_party_id TEXT,      -- ElevenLabs dubbing ID
    project_id TEXT,
    m3u8_url TEXT,
    content_type TEXT CHECK (content_type IN ('space', 'video', 'unknown')),  -- NEW: Content type classification
    source_language TEXT,
    target_language TEXT,
    sharing_link TEXT,
    public_video_url TEXT,
    public_mp3_url TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_mentions_status ON mentions(status);
CREATE INDEX idx_mentions_created_at ON mentions(created_at DESC);
CREATE INDEX idx_mentions_parent_username ON mentions(parent_username);
CREATE INDEX idx_mentions_target_language ON mentions(target_language);
CREATE INDEX idx_mentions_content_type ON mentions(content_type);  -- NEW: For filtering by type
CREATE INDEX idx_mentions_custom_category ON mentions USING GIN(custom_category);
```

### `tweet_metrics`
Stores engagement metrics (views, likes, retweets) over time.

```sql
CREATE TABLE tweet_metrics (
    id BIGSERIAL PRIMARY KEY,
    tweet_id TEXT NOT NULL,
    tweet_type TEXT NOT NULL CHECK (tweet_type IN (
        'mention',           -- User's @dubbingagent request tweet
        'dub_reply',        -- Bot's video reply tweet
        'parent',           -- Original content being dubbed
        'sibling_comment'   -- Other replies to parent (for comparison)
    )),
    mention_id TEXT,    -- Links to mentions.tweet_id

    -- Engagement Metrics
    impression_count BIGINT DEFAULT 0,  -- VIEWS (most important!)
    like_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    retweet_count INTEGER DEFAULT 0,
    quote_count INTEGER DEFAULT 0,

    -- Timestamps
    collected_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(tweet_id, collected_at)  -- Allow historical tracking
);

-- Indexes
CREATE INDEX idx_tweet_metrics_tweet_id ON tweet_metrics(tweet_id);
CREATE INDEX idx_tweet_metrics_mention_id ON tweet_metrics(mention_id);
CREATE INDEX idx_tweet_metrics_type ON tweet_metrics(tweet_type);
CREATE INDEX idx_tweet_metrics_collected ON tweet_metrics(collected_at DESC);
```

### `category_mappings`
Maps Twitter's tweet categories to custom categories.

```sql
CREATE TABLE category_mappings (
    id SERIAL PRIMARY KEY,
    twitter_category TEXT NOT NULL UNIQUE,
    custom_category TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Example mappings
INSERT INTO category_mappings (twitter_category, custom_category) VALUES
    ('Sports', 'Sports & Entertainment'),
    ('Music', 'Sports & Entertainment'),
    ('Technology', 'Tech & Innovation'),
    ('Crypto', 'Tech & Innovation'),
    ('News', 'News & Politics'),
    ('Politics', 'News & Politics');
```

---

## Views

### `tweet_metrics_latest`
Returns most recent metrics for each tweet.

```sql
CREATE OR REPLACE VIEW tweet_metrics_latest AS
SELECT DISTINCT ON (tweet_id, tweet_type)
    tweet_id,
    tweet_type,
    mention_id,
    impression_count,
    like_count,
    reply_count,
    retweet_count,
    quote_count,
    collected_at
FROM tweet_metrics
ORDER BY tweet_id, tweet_type, collected_at DESC;
```

### `dub_engagement_comparison`
Pre-calculated engagement comparison stats.

```sql
CREATE OR REPLACE VIEW dub_engagement_comparison AS
SELECT
    m.tweet_id as mention_tweet_id,
    m.username,
    m.parent_username,
    m.parent_tweet_url,
    m.dub_reply_tweet_id,
    m.target_language,
    m.custom_category,

    -- Metrics
    mention_metrics.impression_count as mention_views,
    dub_metrics.impression_count as dub_reply_views,
    parent_metrics.impression_count as parent_views,

    -- Calculated Rates
    CASE
        WHEN parent_metrics.impression_count > 0
        THEN ROUND(100.0 * dub_metrics.impression_count / parent_metrics.impression_count, 2)
        ELSE 0
    END as dub_to_parent_view_rate

FROM mentions m
LEFT JOIN tweet_metrics_latest mention_metrics
    ON m.tweet_id = mention_metrics.tweet_id
LEFT JOIN tweet_metrics_latest dub_metrics
    ON m.dub_reply_tweet_id = dub_metrics.tweet_id
LEFT JOIN tweet_metrics_latest parent_metrics
    ON SUBSTRING(m.parent_tweet_url FROM 'status/(\d+)') = parent_metrics.tweet_id
WHERE m.status = 'complete'
  AND m.dub_reply_tweet_id IS NOT NULL;
```

---

## Key Fields Explained

### Status Values

| Status | Description |
|--------|-------------|
| `pending` | New mention, not yet processed |
| `initiating` | Dubbing request sent to ElevenLabs |
| `processing` | ElevenLabs is processing the dub |
| `complete` | Dub completed and posted to Twitter |
| `failed` | Processing failed (will retry) |
| `final_failure` | Failed after max retries |
| `skipped_no_video` | Parent tweet has no video to dub |

### Tweet Types (in tweet_metrics)

| Type | Description |
|------|-------------|
| `mention` | User's @dubbingagent request tweet |
| `dub_reply` | Bot's video reply with dubbed content |
| `parent` | Original tweet being dubbed |
| `sibling_comment` | Other replies to parent (comparison) |

### New Analytics Fields

| Field | Purpose | Populated By |
|-------|---------|--------------|
| `dub_reply_tweet_id` | Track bot's reply tweet | Daemon when posting reply |
| `dub_reply_tweet_url` | Direct link to reply | Daemon when posting reply |
| `parent_tweet_text_translated` | Parent tweet in target language | Daemon on mention save OR backfill script |

---

## Migrations

Execute migrations in order:

1. **006_create_tweet_metrics.sql** - Creates tweet_metrics table and views
2. **007_add_translated_parent_text.sql** - Adds translation column

```sql
-- Run in Supabase SQL Editor:

-- Migration 006
CREATE TABLE tweet_metrics (...);
CREATE VIEW tweet_metrics_latest AS ...;
CREATE VIEW dub_engagement_comparison AS ...;
ALTER TABLE mentions ADD COLUMN dub_reply_tweet_id TEXT;
ALTER TABLE mentions ADD COLUMN dub_reply_tweet_url TEXT;

-- Migration 007
ALTER TABLE mentions ADD COLUMN parent_tweet_text_translated TEXT;
```

---

## Query Examples

### Get all completed dubs with metrics
```sql
SELECT * FROM dub_engagement_comparison
ORDER BY dub_reply_views DESC;
```

### Get mentions for specific user's tweets
```sql
SELECT * FROM mentions
WHERE parent_username = 'MarioNawfal'
  AND status = 'complete';
```

### Get trending categories
```sql
SELECT
    UNNEST(custom_category) as category,
    COUNT(*) as dub_count,
    AVG(impression_count) as avg_views
FROM mentions m
JOIN tweet_metrics_latest tm ON m.tweet_id = tm.tweet_id
WHERE m.status = 'complete'
  AND tm.tweet_type = 'mention'
GROUP BY category
ORDER BY dub_count DESC;
```

### Get language performance
```sql
SELECT
    m.target_language,
    COUNT(*) as dub_count,
    AVG(tm.impression_count) as avg_mention_views
FROM mentions m
JOIN tweet_metrics_latest tm ON m.tweet_id = tm.tweet_id
WHERE m.status = 'complete'
  AND tm.tweet_type = 'mention'
GROUP BY m.target_language
ORDER BY avg_mention_views DESC;
```

---

## Data Flow

1. **Mention Detection** → Daemon fetches new @dubbingagent mentions
2. **Parent Analysis** → Extract parent tweet info and translate text
3. **Dubbing** → Send to ElevenLabs for processing
4. **Reply Posting** → Post dubbed video, save `dub_reply_tweet_id`
5. **Metrics Collection** → Periodically fetch engagement metrics
6. **Reporting** → Generate HTML/CSV reports with analytics

---

## External Integrations

### Twitter API v2
- Fetch mentions
- Get tweet metrics (public_metrics)
- Post video replies
- Search for sibling comments

### OpenAI API
- Translate parent tweet text to target language
- Uses `gpt-4o-mini` model

### ElevenLabs API
- Video dubbing service
- Tracks via `third_party_id` and `project_id`

### Supabase
- PostgreSQL database hosting
- Real-time subscriptions (future)
- Row-level security (if needed)

---

## Performance Considerations

### Indexes
- `mentions.status` - Fast filtering by processing state
- `mentions.created_at` - Chronological queries
- `mentions.parent_username` - User-specific reports
- `tweet_metrics.mention_id` - Join performance
- `tweet_metrics.collected_at` - Historical queries

### Rate Limits
- **Twitter API:** 900 requests / 15 min (tweet lookups)
- **Twitter Search:** 450 requests / 15 min (sibling comments)
- **OpenAI:** 10,000 requests / min (translations)

### Best Practices
1. Collect metrics periodically (daily/weekly), not real-time
2. Sample sibling comments (10 per parent) instead of fetching all
3. Use views for complex queries instead of joins in application code
4. Index custom_category array for fast filtering

---

*Last Updated: November 16, 2025*
