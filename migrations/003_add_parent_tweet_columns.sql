-- Add parent tweet columns to mentions table
-- These columns store information about the parent tweet that was mentioned

ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_url TEXT;
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_text TEXT;

-- Create index on parent_tweet_url for faster lookups
CREATE INDEX IF NOT EXISTS idx_mentions_parent_tweet_url ON mentions(parent_tweet_url);
