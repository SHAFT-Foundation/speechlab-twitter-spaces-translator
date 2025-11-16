# Custom Category System Guide

## Overview

This system maps Twitter's context annotations to 16 custom business categories. This provides consistent, predictable categorization for analytics and reporting.

## Setup

### 1. Run the Migration

```bash
# Run migration to create category_mappings table and custom_category column
psql -h cemuqqzmamjmtefodbqs.supabase.co -U postgres -d postgres -f migrations/005_create_category_mapping.sql
```

This migration:
- Adds `custom_category` column to `mentions` table
- Creates `category_mappings` table with mappings
- Creates `mentions_with_custom_categories` view
- Adds index for fast queries

### 2. Backfill Existing Data

```bash
# Populate custom_category for all existing mentions
npm run tsx scripts/backfill-custom-categories.ts
```

This script:
- Reads all mentions with `parent_tweet_domains`
- Looks up mappings in `category_mappings` table
- Populates `custom_category` column
- Shows category distribution

---

## The 16 Custom Categories

| # | Category | Description | Twitter Mappings |
|---|----------|-------------|------------------|
| 1 | NFTs | NFT projects and collections | NFTs |
| 2 | Cryptocurrencies | Bitcoin, Ethereum, crypto | Cryptocurrencies, Cryptocurrency, Bitcoin, Ethereum |
| 3 | Business & finance | Business news, finance | Business & finance, Business Taxonomy, Financial Services Business |
| 4 | Music | Musicians, songs, albums | Music, Musicians |
| 5 | Home & family | Family content, parenting | Home & family, Family |
| 6 | Entrepreneurship | Startups, entrepreneurs | Entrepreneurship, Entrepreneurs, Startups |
| 7 | Entertainment | Movies, TV, celebrities | Entertainment, Movies, TV shows, Celebrity, Events [Entity Service] |
| 8 | Investing | Stock market, investments | Investing, Stock market |
| 9 | Sports | All sports topics | Sports, Football, Basketball, Soccer |
| 10 | World news | Global news, politics | World news, News, Politics |
| 11 | Gaming | Video games, esports | Gaming, Video games, Esports |
| 12 | Digital creators | Content creators, influencers | Digital creators, Content creators, Person, Influencers |
| 13 | Education | Learning, educational content | Education, Learning |
| 14 | Reality TV | Reality TV shows | Reality TV |
| 15 | US national news | US politics, national news | US national news, US politics |
| 16 | Arts & culture | Art, culture topics | Arts & culture, Art, Culture |

---

## Query Examples

### Simple Queries

```sql
-- Count mentions by custom category
SELECT custom_category, COUNT(*) as count
FROM mentions
WHERE custom_category IS NOT NULL
GROUP BY custom_category
ORDER BY count DESC;

-- Find all NFT mentions
SELECT * FROM mentions
WHERE custom_category = 'NFTs';

-- Find all crypto-related mentions (Cryptocurrencies + Investing)
SELECT * FROM mentions
WHERE custom_category IN ('Cryptocurrencies', 'Investing');

-- Recent mentions in specific category
SELECT tweet_id, username, parent_tweet_text, created_at
FROM mentions
WHERE custom_category = 'Gaming'
ORDER BY created_at DESC
LIMIT 20;
```

### Analytics Queries

```sql
-- Category distribution with percentages
SELECT
    custom_category,
    COUNT(*) as mentions,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
FROM mentions
WHERE custom_category IS NOT NULL
GROUP BY custom_category
ORDER BY mentions DESC;

-- Category breakdown by status
SELECT
    custom_category,
    status,
    COUNT(*) as count
FROM mentions
WHERE custom_category IS NOT NULL
GROUP BY custom_category, status
ORDER BY custom_category, count DESC;

-- Most popular languages by category
SELECT
    custom_category,
    target_language,
    COUNT(*) as count
FROM mentions
WHERE custom_category IS NOT NULL
GROUP BY custom_category, target_language
ORDER BY custom_category, count DESC;

-- Top categories this week
SELECT
    custom_category,
    COUNT(*) as count
FROM mentions
WHERE custom_category IS NOT NULL
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY custom_category
ORDER BY count DESC
LIMIT 10;
```

### Using the View for Advanced Queries

```sql
-- See all Twitter categories that map to a custom category
SELECT DISTINCT
    custom_category,
    twitter_domain_name
FROM mentions_with_custom_categories
WHERE custom_category = 'Business & finance'
ORDER BY twitter_domain_name;

-- Find mentions with multiple custom categories
SELECT
    tweet_id,
    username,
    STRING_AGG(DISTINCT custom_category, ', ') as categories,
    COUNT(DISTINCT custom_category) as category_count
FROM mentions_with_custom_categories
GROUP BY tweet_id, username
HAVING COUNT(DISTINCT custom_category) > 1
ORDER BY category_count DESC;

-- Compare Twitter categories to custom categories
SELECT
    original_twitter_category,
    custom_category,
    COUNT(DISTINCT tweet_id) as mentions
FROM mentions_with_custom_categories
GROUP BY original_twitter_category, custom_category
ORDER BY mentions DESC;
```

---

## Adding New Mappings

If you encounter Twitter categories that aren't mapped, add them to the `category_mappings` table:

```sql
-- Add new mapping
INSERT INTO category_mappings (twitter_category, custom_category, priority)
VALUES ('New Twitter Category', 'Your Custom Category', 2)
ON CONFLICT (twitter_category, custom_category) DO NOTHING;

-- Verify mapping
SELECT * FROM category_mappings
WHERE twitter_category = 'New Twitter Category';

-- Rerun backfill to update mentions
-- npm run tsx scripts/backfill-custom-categories.ts
```

Priority determines which mapping to use when multiple exist:
- Priority 1: Exact match (highest priority)
- Priority 2: Related category
- Priority 3: Broad category (fallback)

---

## Automatic Category Assignment

Going forward, new mentions will automatically get their `custom_category` assigned when categories are detected. No manual backfill needed for new data.

The system works like this:

1. **Mention arrives** → Twitter API fetches parent tweet with `context_annotations`
2. **Categories extracted** → Stored in `parent_tweet_domains` (JSONB)
3. **Mapping lookup** → System checks `category_mappings` table
4. **Custom category assigned** → Stored in `custom_category` column
5. **Available for queries** → Instant analytics on categorized data

---

## Performance Tips

### Fast Queries (Use mentions table directly)
```sql
-- ✅ FAST - Query table with index
SELECT * FROM mentions
WHERE custom_category = 'Gaming';

-- ✅ FAST - Count by category
SELECT custom_category, COUNT(*)
FROM mentions
GROUP BY custom_category;
```

### Detailed Queries (Use view when needed)
```sql
-- ⚠️ SLOWER - Use only when you need Twitter category details
SELECT * FROM mentions_with_custom_categories
WHERE twitter_entity_name = 'Bitcoin';

-- ⚠️ SLOWER - Multiple category analysis
SELECT tweet_id, STRING_AGG(DISTINCT custom_category, ', ')
FROM mentions_with_custom_categories
GROUP BY tweet_id;
```

---

## Troubleshooting

### No custom_category for some mentions

**Possible causes:**
1. Parent tweet has no context_annotations from Twitter
2. Twitter category doesn't have a mapping yet
3. Migration not run yet

**Solution:**
```sql
-- Find mentions without custom category but with Twitter categories
SELECT
    tweet_id,
    parent_tweet_category,
    parent_tweet_domains
FROM mentions
WHERE parent_tweet_domains IS NOT NULL
  AND custom_category IS NULL
LIMIT 10;

-- Add missing mappings to category_mappings table
-- Then rerun backfill script
```

### Wrong category assigned

**Solution:**
```sql
-- Check current mapping
SELECT * FROM category_mappings
WHERE twitter_category = 'Your Twitter Category';

-- Update priority or add better mapping
INSERT INTO category_mappings (twitter_category, custom_category, priority)
VALUES ('Your Twitter Category', 'Better Custom Category', 1)
ON CONFLICT (twitter_category, custom_category) DO NOTHING;

-- Rerun backfill
-- npm run tsx scripts/backfill-custom-categories.ts
```

### Multiple categories per mention

This is normal! A tweet can have multiple Twitter categories (like "Cryptocurrencies" + "Business Taxonomy"), which might map to multiple custom categories or the same one with different priorities.

The system uses priority to choose the best match. Lower priority number = higher priority.

---

## Migration Status Check

```sql
-- Check if custom_category column exists
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'mentions'
  AND column_name = 'custom_category';

-- Check if category_mappings table exists
SELECT COUNT(*) as mapping_count
FROM category_mappings;

-- Check if view exists
SELECT COUNT(*) as view_exists
FROM information_schema.views
WHERE table_name = 'mentions_with_custom_categories';

-- Check data distribution
SELECT
    COUNT(*) as total_mentions,
    COUNT(custom_category) as categorized,
    COUNT(*) - COUNT(custom_category) as uncategorized
FROM mentions;
```

---

## Next Steps

1. **Run migration 005** to set up the category system
2. **Run backfill script** to populate existing data
3. **Check distribution** to see category breakdown
4. **Add missing mappings** if needed for your specific Twitter categories
5. **Start using custom_category** in your analytics queries

For more details, see:
- `DATABASE_SCHEMA.md` - Complete schema documentation
- `CATEGORY_QUERIES.md` - More query examples
- `migrations/005_create_category_mapping.sql` - Full migration code
