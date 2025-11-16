# Category Query Examples

After running the view migration (`004_create_category_view.sql`), you can use these simple queries:

## Setup (Run Once)

```sql
-- Create the flattened view
-- Copy and paste from: migrations/004_create_category_view.sql
```

## Simple Queries

### 1. Find all Cryptocurrency mentions:
```sql
SELECT * FROM mentions_with_categories
WHERE domain_name = 'Cryptocurrencies';
```

### 2. Find all Gaming content:
```sql
SELECT * FROM mentions_with_categories
WHERE domain_name = 'Gaming';
```

### 3. Find specific entities (e.g., "Bitcoin"):
```sql
SELECT * FROM mentions_with_categories
WHERE entity_name = 'Bitcoin';
```

### 4. Find mentions by username in specific category:
```sql
SELECT * FROM mentions_with_categories
WHERE domain_name = 'NFTs'
  AND username = 'someuser';
```

## Analytics Queries

### 5. Count mentions by category:
```sql
SELECT
    domain_name,
    COUNT(DISTINCT tweet_id) as mention_count
FROM mentions_with_categories
GROUP BY domain_name
ORDER BY mention_count DESC;
```

### 6. Most popular languages by category:
```sql
SELECT
    domain_name,
    target_language,
    COUNT(DISTINCT tweet_id) as count
FROM mentions_with_categories
GROUP BY domain_name, target_language
ORDER BY domain_name, count DESC;
```

### 7. Top entities being dubbed:
```sql
SELECT
    entity_name,
    COUNT(DISTINCT tweet_id) as count
FROM mentions_with_categories
WHERE entity_name IS NOT NULL
GROUP BY entity_name
ORDER BY count DESC
LIMIT 20;
```

### 8. Category breakdown by status:
```sql
SELECT
    domain_name,
    status,
    COUNT(DISTINCT tweet_id) as count
FROM mentions_with_categories
GROUP BY domain_name, status
ORDER BY domain_name, count DESC;
```

### 9. Recent mentions by category:
```sql
SELECT
    tweet_id,
    username,
    domain_name,
    entity_name,
    target_language,
    created_at
FROM mentions_with_categories
WHERE domain_name = 'Business Taxonomy'
ORDER BY created_at DESC
LIMIT 10;
```

### 10. Multi-category analysis (tweets with multiple topics):
```sql
-- Find tweets that appear in multiple categories
SELECT
    tweet_id,
    username,
    parent_tweet_category,
    STRING_AGG(DISTINCT domain_name, ', ') as all_domains,
    COUNT(DISTINCT domain_name) as category_count
FROM mentions_with_categories
GROUP BY tweet_id, username, parent_tweet_category
HAVING COUNT(DISTINCT domain_name) > 1
ORDER BY category_count DESC;
```

## Performance Tips

### Use original table when you don't need category details:
```sql
-- Faster: Query mentions table directly
SELECT * FROM mentions
WHERE parent_tweet_category = 'Cryptocurrencies';

-- Slower: Use view when you need entity details
SELECT * FROM mentions_with_categories
WHERE entity_name = 'Bitcoin';
```

### Create indexes for common queries:
```sql
-- Already created via migration
CREATE INDEX IF NOT EXISTS idx_mentions_category ON mentions(parent_tweet_category);
```

## Export Results

### Export to CSV:
```sql
COPY (
    SELECT
        domain_name,
        COUNT(DISTINCT tweet_id) as count
    FROM mentions_with_categories
    GROUP BY domain_name
    ORDER BY count DESC
) TO '/tmp/category_stats.csv' WITH CSV HEADER;
```

## Important Notes

1. **The view shows multiple rows per mention** if a tweet has multiple categories
2. **Use DISTINCT tweet_id** when counting to avoid duplicates
3. **Query the mentions table directly** for faster queries when you don't need category details
4. **The view automatically updates** when mentions data changes
