-- Create a flattened view for easier category querying
-- This view expands the JSONB array so each domain/entity gets its own row

CREATE OR REPLACE VIEW mentions_with_categories AS
SELECT
    m.tweet_id,
    m.username,
    m.parent_username,
    m.tweet_url,
    m.parent_tweet_url,
    m.parent_tweet_text,
    m.parent_tweet_category,
    m.parent_tweet_category_id,
    m.source_language,
    m.target_language,
    m.status,
    m.twitter_profile_image_url,
    m.created_at,
    m.updated_at,
    -- Extract individual domain and entity from JSONB array
    elem->>'domain_id' as domain_id,
    elem->>'domain_name' as domain_name,
    elem->>'entity_id' as entity_id,
    elem->>'entity_name' as entity_name
FROM mentions m
CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(m.parent_tweet_domains, '[]'::jsonb)
) AS elem
WHERE m.parent_tweet_domains IS NOT NULL;

-- Add comment explaining the view
COMMENT ON VIEW mentions_with_categories IS
'Flattened view of mentions with expanded category domains. Each mention may appear multiple times if it has multiple categories.';
