-- Create mentions table for tracking Twitter mention processing status
CREATE TABLE IF NOT EXISTS mentions (
    id BIGSERIAL PRIMARY KEY,
    tweet_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    tweet_url TEXT NOT NULL,
    tweet_text TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'initiating', 'processing', 'complete', 'failed')),
    third_party_id TEXT,
    project_id TEXT,
    m3u8_url TEXT,
    source_language TEXT,
    target_language TEXT,
    sharing_link TEXT,
    public_video_url TEXT,
    public_mp3_url TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index on tweet_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_mentions_tweet_id ON mentions(tweet_id);

-- Create index on status for filtering
CREATE INDEX IF NOT EXISTS idx_mentions_status ON mentions(status);

-- Create index on created_at for time-based queries
CREATE INDEX IF NOT EXISTS idx_mentions_created_at ON mentions(created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;

-- Create policy to allow service role to do everything
CREATE POLICY "Service role can do everything" ON mentions
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Create policy to allow anon to read only
CREATE POLICY "Anon can read all" ON mentions
    FOR SELECT
    USING (true);
