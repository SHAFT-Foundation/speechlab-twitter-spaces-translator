-- Create table to store tweet metrics over time
-- Tracks views, likes, retweets for mentions, dub replies, and parent tweets

CREATE TABLE IF NOT EXISTS tweet_metrics (
    id BIGSERIAL PRIMARY KEY,
    tweet_id TEXT NOT NULL,
    tweet_type TEXT NOT NULL CHECK (tweet_type IN ('mention', 'dub_reply', 'parent', 'sibling_comment')),
    mention_id TEXT, -- References mentions.tweet_id for tracking which dub this relates to

    -- Public metrics from Twitter API
    impression_count BIGINT DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    retweet_count INTEGER DEFAULT 0,
    quote_count INTEGER DEFAULT 0,

    -- Metadata
    collected_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(tweet_id, collected_at)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_tweet_metrics_tweet_id ON tweet_metrics(tweet_id);
CREATE INDEX IF NOT EXISTS idx_tweet_metrics_mention_id ON tweet_metrics(mention_id);
CREATE INDEX IF NOT EXISTS idx_tweet_metrics_type ON tweet_metrics(tweet_type);
CREATE INDEX IF NOT EXISTS idx_tweet_metrics_collected_at ON tweet_metrics(collected_at DESC);

-- Add columns to mentions table to track dub reply tweet
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS dub_reply_tweet_id TEXT;
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS dub_reply_tweet_url TEXT;

CREATE INDEX IF NOT EXISTS idx_mentions_dub_reply_tweet_id ON mentions(dub_reply_tweet_id);

COMMENT ON TABLE tweet_metrics IS
'Stores Twitter public metrics over time for mentions, dub replies, parent tweets, and sibling comments. Used for engagement analytics and comparison reports.';

COMMENT ON COLUMN tweet_metrics.tweet_type IS
'Type of tweet: mention (user asking for dub), dub_reply (our video reply), parent (original content), sibling_comment (other replies to parent)';

COMMENT ON COLUMN tweet_metrics.impression_count IS
'Total views of the tweet (KEY METRIC for engagement analysis)';

COMMENT ON COLUMN mentions.dub_reply_tweet_id IS
'Tweet ID of the reply we posted with the dubbed video';

-- Create view for latest metrics per tweet
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

COMMENT ON VIEW tweet_metrics_latest IS
'Shows the most recent metrics for each tweet. Use this for current engagement stats.';

-- Create view for engagement comparison
CREATE OR REPLACE VIEW dub_engagement_comparison AS
SELECT
    m.tweet_id as mention_tweet_id,
    m.username,
    m.parent_username,
    m.parent_tweet_url,
    m.dub_reply_tweet_id,
    m.target_language,
    m.custom_category,
    m.status,
    m.created_at as dub_created_at,

    -- Mention tweet metrics
    mention_metrics.impression_count as mention_views,
    mention_metrics.like_count as mention_likes,

    -- Dub reply metrics (KEY METRIC)
    dub_metrics.impression_count as dub_reply_views,
    dub_metrics.like_count as dub_reply_likes,
    dub_metrics.retweet_count as dub_reply_retweets,

    -- Parent tweet metrics
    parent_metrics.impression_count as parent_views,
    parent_metrics.like_count as parent_likes,

    -- Calculate engagement rates
    CASE
        WHEN parent_metrics.impression_count > 0
        THEN ROUND(100.0 * dub_metrics.impression_count / parent_metrics.impression_count, 2)
        ELSE 0
    END as dub_to_parent_view_rate,

    -- Timestamps
    dub_metrics.collected_at as metrics_collected_at

FROM mentions m
LEFT JOIN tweet_metrics_latest mention_metrics
    ON m.tweet_id = mention_metrics.tweet_id
    AND mention_metrics.tweet_type = 'mention'
LEFT JOIN tweet_metrics_latest dub_metrics
    ON m.dub_reply_tweet_id = dub_metrics.tweet_id
    AND dub_metrics.tweet_type = 'dub_reply'
LEFT JOIN tweet_metrics_latest parent_metrics
    ON m.parent_tweet_url IS NOT NULL
    AND parent_metrics.tweet_id = SUBSTRING(m.parent_tweet_url FROM 'status/(\d+)')
    AND parent_metrics.tweet_type = 'parent'

WHERE m.status = 'complete'
  AND m.dub_reply_tweet_id IS NOT NULL;

COMMENT ON VIEW dub_engagement_comparison IS
'Compares engagement metrics between mention tweets, dub reply videos, and parent tweets. Shows conversion rates and relative performance.';
