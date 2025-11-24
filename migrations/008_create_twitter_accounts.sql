-- Create twitter_accounts table to store profile information for all Twitter users
-- This avoids storing duplicate profile images in mentions table
CREATE TABLE IF NOT EXISTS twitter_accounts (
    username TEXT PRIMARY KEY,
    profile_image_url TEXT,
    user_id TEXT,  -- Twitter user ID for API calls
    display_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index on user_id for lookups
CREATE INDEX IF NOT EXISTS idx_twitter_accounts_user_id ON twitter_accounts(user_id);

-- Create index on updated_at for finding stale records
CREATE INDEX IF NOT EXISTS idx_twitter_accounts_updated_at ON twitter_accounts(updated_at DESC);

-- Enable Row Level Security
ALTER TABLE twitter_accounts ENABLE ROW LEVEL SECURITY;

-- Create policy to allow service role to do everything
CREATE POLICY "Service role can do everything" ON twitter_accounts
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Create policy to allow anon to read only
CREATE POLICY "Anon can read all" ON twitter_accounts
    FOR SELECT
    USING (true);
