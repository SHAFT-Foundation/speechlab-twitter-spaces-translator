-- Add parent_video_preview_url column to mentions table
-- This stores the Twitter API preview_image_url for videos in parent tweets

ALTER TABLE mentions
ADD COLUMN IF NOT EXISTS parent_video_preview_url TEXT;

-- Add comment
COMMENT ON COLUMN mentions.parent_video_preview_url IS 'Preview/thumbnail image URL for video content in the parent tweet';

-- Create index for potential queries
CREATE INDEX IF NOT EXISTS idx_mentions_parent_video_preview_url ON mentions(parent_video_preview_url) WHERE parent_video_preview_url IS NOT NULL;
