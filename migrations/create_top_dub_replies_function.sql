-- Create function to get top dub replies by view count
-- This efficiently gets the latest metrics for each dub reply and ranks them

CREATE OR REPLACE FUNCTION get_top_dub_replies(result_limit INTEGER DEFAULT 20)
RETURNS TABLE (
    tweet_id TEXT,
    mention_id TEXT,
    username TEXT,
    impression_count BIGINT,
    like_count INTEGER,
    retweet_count INTEGER,
    reply_count INTEGER,
    quote_count INTEGER,
    parent_tweet_url TEXT,
    parent_tweet_text TEXT,
    target_language TEXT,
    dub_reply_tweet_url TEXT,
    sharing_link TEXT,
    collected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    WITH latest_metrics AS (
        SELECT DISTINCT ON (tm.tweet_id)
            tm.tweet_id,
            tm.mention_id,
            tm.impression_count,
            tm.like_count,
            tm.retweet_count,
            tm.reply_count,
            tm.quote_count,
            tm.collected_at
        FROM tweet_metrics tm
        WHERE tm.tweet_type = 'dub_reply'
        ORDER BY tm.tweet_id, tm.collected_at DESC
    )
    SELECT
        lm.tweet_id,
        lm.mention_id,
        m.username,
        lm.impression_count,
        lm.like_count,
        lm.retweet_count,
        lm.reply_count,
        lm.quote_count,
        m.parent_tweet_url,
        m.parent_tweet_text,
        m.target_language,
        m.dub_reply_tweet_url,
        m.sharing_link,
        lm.collected_at,
        m.created_at
    FROM latest_metrics lm
    JOIN mentions m ON lm.mention_id = m.tweet_id
    ORDER BY lm.impression_count DESC
    LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Create index to speed up queries
CREATE INDEX IF NOT EXISTS idx_tweet_metrics_type_collected
    ON tweet_metrics(tweet_type, collected_at DESC);

-- Add comment
COMMENT ON FUNCTION get_top_dub_replies IS 'Returns top dub reply tweets ranked by view count (impression_count), with latest metrics for each tweet';
