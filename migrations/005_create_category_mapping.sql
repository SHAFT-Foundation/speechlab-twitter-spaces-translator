-- Add custom_category column to mentions table
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS custom_category TEXT;

-- Create index for custom category queries
CREATE INDEX IF NOT EXISTS idx_mentions_custom_category ON mentions(custom_category);

-- Create category mapping table to translate Twitter categories to custom categories
-- This maps Twitter's context_annotations to the 16 custom categories

CREATE TABLE IF NOT EXISTS category_mappings (
    id SERIAL PRIMARY KEY,
    twitter_category TEXT NOT NULL,
    custom_category TEXT NOT NULL,
    priority INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(twitter_category, custom_category)
);

-- Insert mappings for Twitter categories to custom categories
INSERT INTO category_mappings (twitter_category, custom_category, priority) VALUES
-- NFTs
('NFTs', 'NFTs', 1),

-- Cryptocurrencies
('Cryptocurrencies', 'Cryptocurrencies', 1),
('Cryptocurrency', 'Cryptocurrencies', 1),
('Bitcoin', 'Cryptocurrencies', 2),
('Ethereum', 'Cryptocurrencies', 2),

-- Business & finance
('Business & finance', 'Business & finance', 1),
('Business Taxonomy', 'Business & finance', 2),
('Financial Services Business', 'Business & finance', 2),
('Finance genre', 'Business & finance', 2),
('Investing', 'Business & finance', 3),

-- Music
('Music', 'Music', 1),
('Musicians', 'Music', 2),

-- Home & family
('Home & family', 'Home & family', 1),
('Family', 'Home & family', 2),

-- Entrepreneurship
('Entrepreneurship', 'Entrepreneurship', 1),
('Entrepreneurs', 'Entrepreneurship', 2),
('Startups', 'Entrepreneurship', 2),

-- Entertainment
('Entertainment', 'Entertainment', 1),
('Movies', 'Entertainment', 2),
('TV shows', 'Entertainment', 2),
('Celebrity', 'Entertainment', 2),
('Events [Entity Service]', 'Entertainment', 3),

-- Investing
('Investing', 'Investing', 1),
('Stock market', 'Investing', 2),

-- Sports
('Sports', 'Sports', 1),
('Football', 'Sports', 2),
('Basketball', 'Sports', 2),
('Soccer', 'Sports', 2),

-- World news
('World news', 'World news', 1),
('News', 'World news', 2),
('Politics', 'World news', 2),

-- Gaming
('Gaming', 'Gaming', 1),
('Video games', 'Gaming', 2),
('Esports', 'Gaming', 2),

-- Digital creators
('Digital creators', 'Digital creators', 1),
('Content creators', 'Digital creators', 2),
('Person', 'Digital creators', 3),
('Influencers', 'Digital creators', 2),

-- Education
('Education', 'Education', 1),
('Learning', 'Education', 2),

-- Reality TV
('Reality TV', 'Reality TV', 1),

-- US national news
('US national news', 'US national news', 1),
('US politics', 'US national news', 2),

-- Arts & culture
('Arts & culture', 'Arts & culture', 1),
('Art', 'Arts & culture', 2),
('Culture', 'Arts & culture', 2)

ON CONFLICT (twitter_category, custom_category) DO NOTHING;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_category_mappings_twitter_category
ON category_mappings(twitter_category);

-- Create view that applies custom category mappings
CREATE OR REPLACE VIEW mentions_with_custom_categories AS
SELECT DISTINCT ON (m.tweet_id, cm.custom_category)
    m.tweet_id,
    m.username,
    m.parent_username,
    m.tweet_url,
    m.parent_tweet_url,
    m.parent_tweet_text,
    m.parent_tweet_category as original_twitter_category,
    cm.custom_category,
    m.source_language,
    m.target_language,
    m.status,
    m.twitter_profile_image_url,
    m.created_at,
    m.updated_at,
    -- Keep original category data for reference
    elem->>'domain_id' as twitter_domain_id,
    elem->>'domain_name' as twitter_domain_name,
    elem->>'entity_id' as twitter_entity_id,
    elem->>'entity_name' as twitter_entity_name
FROM mentions m
CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(m.parent_tweet_domains, '[]'::jsonb)
) AS elem
LEFT JOIN category_mappings cm ON (elem->>'domain_name') = cm.twitter_category
WHERE m.parent_tweet_domains IS NOT NULL
ORDER BY m.tweet_id, cm.custom_category, cm.priority ASC;

COMMENT ON VIEW mentions_with_custom_categories IS
'Flattened view of mentions with custom category mappings. Maps Twitter context annotations to 16 custom categories.';

COMMENT ON TABLE category_mappings IS
'Maps Twitter context annotation categories to custom business categories. Priority determines which mapping to use when multiple exist.';
