-- Update the status check constraint to include 'final_failure'
-- This allows mentions to be marked as permanently failed after 3 retry attempts

-- First, drop the old constraint
ALTER TABLE mentions DROP CONSTRAINT IF EXISTS mentions_status_check;

-- Add the new constraint with 'final_failure' included
ALTER TABLE mentions ADD CONSTRAINT mentions_status_check
CHECK (status IN ('pending', 'initiating', 'processing', 'complete', 'failed', 'final_failure'));

-- Add comment to document the constraint
COMMENT ON CONSTRAINT mentions_status_check ON mentions IS
'Valid status values: pending (new), initiating (starting), processing (in progress), failed (retryable), final_failure (permanent), complete (done)';
