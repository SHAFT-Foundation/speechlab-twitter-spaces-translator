-- Add retry_count column to track retry attempts
-- This column tracks how many times a mention has been retried before being marked as final_failure

ALTER TABLE mentions
ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;

-- Add comment to document the column
COMMENT ON COLUMN mentions.retry_count IS 'Number of retry attempts for this mention (max 3)';

-- Create index for efficient querying of failed mentions by retry count
CREATE INDEX IF NOT EXISTS idx_mentions_retry_count ON mentions(retry_count)
WHERE status IN ('failed', 'initiating', 'processing');
