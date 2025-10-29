-- Query to view all failed mentions with error messages
-- Run this in your Supabase SQL editor to see what errors are occurring

SELECT
    tweet_id,
    username,
    status,
    error_message,
    retry_count,
    third_party_id,
    project_id,
    created_at,
    updated_at
FROM mentions
WHERE status = 'failed'
    AND error_message IS NOT NULL
ORDER BY updated_at DESC
LIMIT 50;

-- Summary of error types
SELECT
    error_message,
    COUNT(*) as occurrence_count,
    MAX(updated_at) as last_occurrence
FROM mentions
WHERE status = 'failed'
    AND error_message IS NOT NULL
GROUP BY error_message
ORDER BY occurrence_count DESC;
