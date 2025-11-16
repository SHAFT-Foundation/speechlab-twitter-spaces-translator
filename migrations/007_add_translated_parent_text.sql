-- Add translated parent tweet text column to mentions table
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_text_translated TEXT;

-- Add comment explaining the column
COMMENT ON COLUMN mentions.parent_tweet_text_translated IS 'Parent tweet text translated to the target language using LLM';
