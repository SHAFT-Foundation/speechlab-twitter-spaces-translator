-- Add content_type column to distinguish Spaces vs Videos
-- Migration: add_content_type
-- Date: 2025-11-18

-- Add content_type column
ALTER TABLE mentions
ADD COLUMN IF NOT EXISTS content_type TEXT CHECK (content_type IN ('space', 'video', 'unknown'));

-- Create index for filtering
CREATE INDEX IF NOT EXISTS idx_mentions_content_type ON mentions(content_type);

-- Backfill existing data based on m3u8_url patterns
-- Twitter Spaces M3U8 URLs typically contain 'dynamic_playlist' or 'prod/dynamic_playlist'
-- Video M3U8 URLs typically contain 'amplify_video' or 'ext_tw_video'
UPDATE mentions
SET content_type = CASE
    WHEN m3u8_url IS NULL THEN 'unknown'
    WHEN m3u8_url LIKE '%dynamic_playlist%' OR m3u8_url LIKE '%prod/dynamic_playlist%' THEN 'space'
    WHEN m3u8_url LIKE '%amplify_video%' OR m3u8_url LIKE '%ext_tw_video%' THEN 'video'
    ELSE 'unknown'
END
WHERE content_type IS NULL;

-- Add comment
COMMENT ON COLUMN mentions.content_type IS 'Type of content being dubbed: space (Twitter Spaces), video (Tweet video), or unknown';
