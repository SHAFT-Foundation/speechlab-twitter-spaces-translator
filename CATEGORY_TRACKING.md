# Parent Tweet Category Tracking

## Overview
The system now automatically extracts and saves tweet categories using Twitter's native **Context Annotations** API.

## What Are Context Annotations?
Twitter automatically categorizes tweets into domains (broad categories) and entities (specific topics). Examples:
- **Cryptocurrencies** (domain 12)
- **NFTs** (domain 8)
- **Gaming** (domain 40)
- **Sports** (domain 11)
- **Business & finance** (domain 15)
- **Entertainment** (domain 6)
- **Music** (domain 5)

## Database Schema

### SQL to Run in Supabase:
```sql
-- Add category columns
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_category TEXT;
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_category_id TEXT;
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_domains JSONB;

-- Create index for category searches
CREATE INDEX IF NOT EXISTS idx_mentions_category ON mentions(parent_tweet_category);
```

### Columns Added:
1. **parent_tweet_category** (TEXT): Primary category name (e.g., "Cryptocurrencies")
2. **parent_tweet_category_id** (TEXT): Twitter's category ID (e.g., "12")
3. **parent_tweet_domains** (JSONB): Full context annotations with all domains/entities

## How It Works

### 1. Data Collection
When a mention is fetched, the code:
1. Requests `context_annotations` from Twitter API
2. Extracts the parent tweet's context annotations
3. Sets primary category as the first domain
4. Stores all domains in JSONB for detailed analysis

### 2. Example Data Structure
```json
{
  "parent_tweet_category": "Cryptocurrencies",
  "parent_tweet_category_id": "12",
  "parent_tweet_domains": [
    {
      "domain_id": "12",
      "domain_name": "Cryptocurrencies",
      "entity_id": "1007360414114435072",
      "entity_name": "Bitcoin"
    },
    {
      "domain_id": "15",
      "domain_name": "Business & finance",
      "entity_id": null,
      "entity_name": null
    }
  ]
}
```

## Benefits of This Approach

### ✅ Advantages:
1. **Native Twitter Data** - Uses official categorization from Twitter
2. **Automatic** - No manual tagging or AI needed
3. **Accurate** - Twitter's own classification
4. **Free** - Included in standard API response
5. **Consistent** - Standardized category names across all tweets
6. **Multi-category** - Can have multiple domains per tweet

### Common Categories You'll See:
- **NFTs** (8)
- **Cryptocurrencies** (12)
- **Business & finance** (15)
- **Music** (5)
- **Gaming** (40)
- **Sports** (11)
- **Entertainment** (6)
- **Home & family** (24)
- **Entrepreneurship** (4)
- **Investing** (4)
- **World news** (5)
- **Digital creators** (3)
- **Education** (2)
- **Reality TV** (2)
- **US national news** (2)
- **Arts & culture** (2)

## Usage Examples

### Query by Category:
```sql
-- Find all crypto-related dubs
SELECT * FROM mentions
WHERE parent_tweet_category = 'Cryptocurrencies';

-- Find all gaming content
SELECT * FROM mentions
WHERE parent_tweet_category = 'Gaming';

-- Find tweets with multiple categories
SELECT * FROM mentions
WHERE parent_tweet_domains::text LIKE '%Gaming%'
  AND parent_tweet_domains::text LIKE '%Entertainment%';
```

### Analytics:
```sql
-- Count mentions by category
SELECT
    parent_tweet_category,
    COUNT(*) as count
FROM mentions
GROUP BY parent_tweet_category
ORDER BY count DESC;

-- Most popular target languages by category
SELECT
    parent_tweet_category,
    target_language,
    COUNT(*) as count
FROM mentions
WHERE parent_tweet_category IS NOT NULL
GROUP BY parent_tweet_category, target_language
ORDER BY parent_tweet_category, count DESC;
```

## Current Status
- ✅ Code updated to fetch context annotations
- ✅ Category extraction implemented
- ✅ Database schema defined
- ⚠️ **Need to run SQL** to add columns
- ⚠️ **Future mentions** will have categories automatically
- ℹ️ Historical data can be backfilled if needed

## Next Steps
1. Run the SQL migration above
2. Categories will automatically populate for new mentions
3. Optional: Create backfill script for historical data
