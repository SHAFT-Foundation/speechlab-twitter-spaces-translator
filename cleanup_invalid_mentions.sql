-- Cleanup script to remove invalid mentions from Supabase
-- Run this in your Supabase SQL editor to clean up existing invalid mentions

-- First, let's see what we're about to delete (DRY RUN)
SELECT
    tweet_id,
    username,
    tweet_text,
    status,
    created_at
FROM mentions
WHERE
    -- Invalid mentions that don't contain dubbing keywords
    (
        tweet_text NOT ILIKE '%dub%'
        AND tweet_text NOT ILIKE '%translate%'
        AND tweet_text NOT ILIKE '% in %'
        AND tweet_text NOT ILIKE '% to %'
        AND tweet_text NOT ILIKE '% from %'
    )
    OR
    -- Mentions that are just spam/unrelated
    (
        tweet_text ILIKE '%telegram group%'
        OR tweet_text ILIKE '%joined the waitlist%'
        OR tweet_text ILIKE '%ecosystem%'
        OR tweet_text ILIKE '%hype on%'
        OR tweet_text ILIKE '%flywheel%'
        OR tweet_text ILIKE '%big move%'
        OR tweet_text ILIKE '%more gains%'
        OR tweet_text ILIKE '%leveling up%'
        OR tweet_text ILIKE '%products =%'
        OR tweet_text ILIKE '%connection with%'
        OR tweet_text ILIKE 'The @DubbingAgent is launched%'
    )
ORDER BY created_at DESC;

-- UNCOMMENT THE FOLLOWING LINE TO ACTUALLY DELETE:
-- DELETE FROM mentions WHERE tweet_id IN (
--     SELECT tweet_id FROM mentions
--     WHERE
--         (
--             tweet_text NOT ILIKE '%dub%'
--             AND tweet_text NOT ILIKE '%translate%'
--             AND tweet_text NOT ILIKE '% in %'
--             AND tweet_text NOT ILIKE '% to %'
--             AND tweet_text NOT ILIKE '% from %'
--         )
--         OR
--         (
--             tweet_text ILIKE '%telegram group%'
--             OR tweet_text ILIKE '%joined the waitlist%'
--             OR tweet_text ILIKE '%ecosystem%'
--             OR tweet_text ILIKE '%hype on%'
--             OR tweet_text ILIKE '%flywheel%'
--             OR tweet_text ILIKE '%big move%'
--             OR tweet_text ILIKE '%more gains%'
--             OR tweet_text ILIKE '%leveling up%'
--             OR tweet_text ILIKE '%products =%'
--             OR tweet_text ILIKE '%connection with%'
--             OR tweet_text ILIKE 'The @DubbingAgent is launched%'
--         )
-- );
