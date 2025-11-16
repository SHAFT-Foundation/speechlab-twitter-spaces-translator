# Database Integration Guide for Claude Code

## Overview

This guide explains how to query and use the mentions database from another Claude Code session for analytics, reporting, or application features.

---

## Database Connection

**Supabase PostgreSQL Database**

```javascript
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://cemuqqzmamjmtefodbqs.supabase.co',
  'YOUR_SUPABASE_KEY' // Use service_role key for full access
);
```

**Connection String (for raw SQL):**
```
postgresql://postgres.cemuqqzmamjmtefodbqs:[PASSWORD]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
```

---

## Key Schema Changes

### ⚠️ IMPORTANT: `custom_category` is now an ARRAY

**Before:** `custom_category TEXT` (single category)
**After:** `custom_category TEXT[]` (multiple categories)

This means:
- A mention can have 2-5 categories for better coverage
- Crypto tweets are tagged as BOTH "Cryptocurrencies" AND "Business & finance"
- Gaming influencer content gets "Gaming", "Digital creators", "Entertainment"

---

## Main Table: `mentions`

### Key Columns

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `tweet_id` | TEXT | Unique Twitter mention ID | "1989787665672388880" |
| `username` | TEXT | User who mentioned the bot | "johndoe" |
| `parent_username` | TEXT | Author of parent tweet | "elonmusk" |
| `parent_tweet_url` | TEXT | URL to parent tweet | "https://twitter.com/..." |
| `parent_tweet_text` | TEXT | Content of parent tweet | "Bitcoin to $200k..." |
| `custom_category` | **TEXT[]** | **Array of business categories** | ["Cryptocurrencies", "Business & finance"] |
| `twitter_profile_image_url` | TEXT | Profile image of mentioner | "https://pbs.twimg.com/..." |
| `source_language` | TEXT | Detected source language | "en" |
| `target_language` | TEXT | Target dubbing language | "es" |
| `status` | TEXT | Processing status | "complete", "pending", "failed" |
| `public_video_url` | TEXT | S3 URL to dubbed video | "https://s3.amazonaws.com/..." |
| `created_at` | TIMESTAMPTZ | When mention was created | 2025-11-16 10:00:00+00 |

### Status Values

- `pending` - Waiting to be processed
- `initiating` - Starting processing
- `processing` - Backend dubbing in progress
- `complete` - Successfully dubbed
- `failed` - Failed but will retry
- `final_failure` - Failed after 3 attempts
- `skipped_no_video` - Parent tweet had no video

---

## The 16 Custom Categories

1. **NFTs** - NFT projects and collections
2. **Cryptocurrencies** - Bitcoin, Ethereum, crypto topics
3. **Business & finance** - Business news, finance, investing
4. **Music** - Musicians, songs, albums
5. **Home & family** - Family content, parenting
6. **Entrepreneurship** - Startups, entrepreneurs
7. **Entertainment** - Movies, TV, celebrities, events
8. **Investing** - Stock market, investment strategies
9. **Sports** - All sports topics
10. **World news** - Global news, politics
11. **Gaming** - Video games, esports
12. **Digital creators** - Content creators, influencers
13. **Education** - Learning, educational content
14. **Reality TV** - Reality TV shows
15. **US national news** - US politics, national news
16. **Arts & culture** - Art, culture topics

---

## Common Query Patterns

### 1. Basic Queries with Supabase JS

```javascript
// Get recent completed mentions
const { data: mentions } = await supabase
  .from('mentions')
  .select('*')
  .eq('status', 'complete')
  .order('created_at', { ascending: false })
  .limit(100);

// Get mentions by specific category
const { data: cryptoMentions } = await supabase
  .from('mentions')
  .select('*')
  .contains('custom_category', ['Cryptocurrencies']);

// Get mentions with ANY of these categories
const { data: techMentions } = await supabase
  .from('mentions')
  .select('*')
  .or('custom_category.cs.{Cryptocurrencies},custom_category.cs.{Gaming}');

// Get mentions by username
const { data: userMentions } = await supabase
  .from('mentions')
  .select('*')
  .eq('username', 'someuser')
  .order('created_at', { ascending: false });

// Get mentions by target language
const { data: spanishDubs } = await supabase
  .from('mentions')
  .select('*')
  .eq('target_language', 'es')
  .eq('status', 'complete');
```

### 2. Raw SQL Queries

```javascript
// Find all crypto mentions (array contains query)
const { data } = await supabase.rpc('exec_sql', {
  sql: `
    SELECT * FROM mentions
    WHERE 'Cryptocurrencies' = ANY(custom_category)
    ORDER BY created_at DESC
    LIMIT 50
  `
});

// Count mentions by category
const { data: counts } = await supabase.rpc('exec_sql', {
  sql: `
    SELECT
      category,
      COUNT(*) as mention_count
    FROM mentions, UNNEST(custom_category) AS category
    GROUP BY category
    ORDER BY mention_count DESC
  `
});

// Find mentions with multiple specific categories
const { data: crossover } = await supabase.rpc('exec_sql', {
  sql: `
    SELECT * FROM mentions
    WHERE 'Cryptocurrencies' = ANY(custom_category)
      AND 'Gaming' = ANY(custom_category)
  `
});

// Category distribution by language
const { data: langDist } = await supabase.rpc('exec_sql', {
  sql: `
    SELECT
      target_language,
      category,
      COUNT(*) as count
    FROM mentions, UNNEST(custom_category) AS category
    WHERE target_language IS NOT NULL
    GROUP BY target_language, category
    ORDER BY count DESC
  `
});
```

### 3. Using the View: `mentions_with_custom_categories`

The view flattens the array so each category becomes a separate row:

```javascript
// Query by category using the view
const { data } = await supabase
  .from('mentions_with_custom_categories')
  .select('*')
  .eq('custom_category', 'Gaming')
  .order('created_at', { ascending: false });

// Count unique mentions per category
const { data: dist } = await supabase
  .from('mentions_with_custom_categories')
  .select('custom_category, tweet_id')
  .then(res => {
    const counts = {};
    res.data.forEach(row => {
      counts[row.custom_category] = (counts[row.custom_category] || 0) + 1;
    });
    return counts;
  });
```

---

## Analytics Query Examples

### Category Performance

```sql
-- Top categories by completed dubs
SELECT
  category,
  COUNT(*) as total_mentions,
  COUNT(CASE WHEN status = 'complete' THEN 1 END) as completed,
  ROUND(100.0 * COUNT(CASE WHEN status = 'complete' THEN 1 END) / COUNT(*), 2) as completion_rate
FROM mentions, UNNEST(custom_category) AS category
GROUP BY category
ORDER BY total_mentions DESC;
```

### Language Distribution by Category

```sql
-- Most popular target languages by category
SELECT
  category,
  target_language,
  COUNT(*) as dub_count
FROM mentions, UNNEST(custom_category) AS category
WHERE target_language IS NOT NULL
  AND status = 'complete'
GROUP BY category, target_language
ORDER BY category, dub_count DESC;
```

### Recent Activity

```sql
-- Recent mentions in last 24 hours by category
SELECT
  category,
  COUNT(*) as count
FROM mentions, UNNEST(custom_category) AS category
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY category
ORDER BY count DESC;
```

### User Engagement

```sql
-- Top users by category
SELECT
  category,
  username,
  COUNT(*) as mention_count
FROM mentions, UNNEST(custom_category) AS category
GROUP BY category, username
ORDER BY category, mention_count DESC;
```

### Cross-Category Analysis

```sql
-- Find mentions that span multiple categories
SELECT
  tweet_id,
  username,
  custom_category,
  ARRAY_LENGTH(custom_category, 1) as category_count,
  parent_tweet_text
FROM mentions
WHERE ARRAY_LENGTH(custom_category, 1) > 2
ORDER BY category_count DESC;
```

---

## JavaScript Helper Functions

```javascript
// Helper: Get mentions by category (handles array)
async function getMentionsByCategory(category) {
  const { data, error } = await supabase
    .from('mentions')
    .select('*')
    .contains('custom_category', [category])
    .order('created_at', { ascending: false });

  return data;
}

// Helper: Get category distribution
async function getCategoryDistribution() {
  const { data } = await supabase
    .from('mentions')
    .select('custom_category')
    .not('custom_category', 'is', null);

  const counts = {};
  data.forEach(mention => {
    if (Array.isArray(mention.custom_category)) {
      mention.custom_category.forEach(cat => {
        counts[cat] = (counts[cat] || 0) + 1;
      });
    }
  });

  return Object.entries(counts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

// Helper: Get mentions with multiple categories
async function getMultiCategoryMentions(categories) {
  const { data } = await supabase
    .from('mentions')
    .select('*')
    .not('custom_category', 'is', null);

  return data.filter(mention =>
    categories.every(cat => mention.custom_category?.includes(cat))
  );
}

// Helper: Get trending categories (last 7 days)
async function getTrendingCategories(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data } = await supabase
    .from('mentions')
    .select('custom_category')
    .gte('created_at', since.toISOString())
    .not('custom_category', 'is', null);

  const counts = {};
  data.forEach(mention => {
    mention.custom_category?.forEach(cat => {
      counts[cat] = (counts[cat] || 0) + 1;
    });
  });

  return Object.entries(counts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}
```

---

## Important Notes

### 1. Array Queries in Supabase JS

**✅ Correct way to query array columns:**
```javascript
// Contains ANY of these categories
.contains('custom_category', ['Cryptocurrencies'])

// Use OR for multiple options
.or('custom_category.cs.{Cryptocurrencies},custom_category.cs.{Gaming}')
```

**❌ Won't work:**
```javascript
.eq('custom_category', 'Cryptocurrencies') // Wrong! This is an array
```

### 2. Counting with Arrays

When counting mentions by category, remember that each mention can be counted multiple times (once per category):

```javascript
// This counts total category assignments (not unique mentions)
SELECT category, COUNT(*)
FROM mentions, UNNEST(custom_category) AS category
GROUP BY category;

// To count unique mentions per category, use DISTINCT:
SELECT category, COUNT(DISTINCT tweet_id)
FROM mentions, UNNEST(custom_category) AS category
GROUP BY category;
```

### 3. Performance Tips

- Use the `mentions` table directly when possible (faster than view)
- The `custom_category` column has a GIN index for fast array queries
- Use specific filters (status, date range) to narrow results
- Limit results with `.limit()` for large queries

---

## Example Use Cases

### Dashboard Analytics

```javascript
async function getDashboardStats() {
  // Total mentions
  const { count: totalMentions } = await supabase
    .from('mentions')
    .select('*', { count: 'exact', head: true });

  // Completed dubs
  const { count: completedDubs } = await supabase
    .from('mentions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'complete');

  // Category distribution
  const categoryDist = await getCategoryDistribution();

  // Recent activity (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { count: recentMentions } = await supabase
    .from('mentions')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo.toISOString());

  return {
    totalMentions,
    completedDubs,
    completionRate: (completedDubs / totalMentions * 100).toFixed(2),
    categoryDistribution: categoryDist,
    recentMentions
  };
}
```

### Content Feed

```javascript
async function getCategoryFeed(category, limit = 20) {
  const { data } = await supabase
    .from('mentions')
    .select(`
      tweet_id,
      username,
      twitter_profile_image_url,
      parent_tweet_text,
      target_language,
      public_video_url,
      created_at,
      custom_category
    `)
    .contains('custom_category', [category])
    .eq('status', 'complete')
    .not('public_video_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  return data;
}
```

### User Profile

```javascript
async function getUserActivity(username) {
  const { data: mentions } = await supabase
    .from('mentions')
    .select('*')
    .eq('username', username)
    .order('created_at', { ascending: false });

  // Get user's favorite categories
  const categoryCounts = {};
  mentions.forEach(m => {
    m.custom_category?.forEach(cat => {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });
  });

  const topCategories = Object.entries(categoryCounts)
    .map(([cat, count]) => ({ category: cat, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return {
    username,
    totalMentions: mentions.length,
    topCategories,
    recentMentions: mentions.slice(0, 10)
  };
}
```

---

## Schema Reference

For complete schema documentation, see:
- `DATABASE_SCHEMA.md` - Full table and view documentation
- `CUSTOM_CATEGORIES.md` - Category system guide with examples
- `CATEGORY_QUERIES.md` - More SQL query examples

---

## Testing Queries

```javascript
// Quick test to verify connection and data
async function testConnection() {
  const { data, error } = await supabase
    .from('mentions')
    .select('tweet_id, username, custom_category')
    .limit(5);

  if (error) {
    console.error('Connection error:', error);
    return;
  }

  console.log('Connection successful!');
  console.log('Sample data:', data);

  // Verify array structure
  console.log('First mention categories:', data[0]?.custom_category);
  console.log('Is array?', Array.isArray(data[0]?.custom_category));
}
```

---

## Migration Status

**Current Version:** Migration 005 (Multi-category support)

**Recent Changes:**
- ✅ Added `custom_category` column (TEXT[] array)
- ✅ Added `twitter_profile_image_url` column
- ✅ Created `category_mappings` table
- ✅ Updated `mentions_with_custom_categories` view for arrays
- ✅ Backfilled all historical data

**Data Coverage:**
- ~21 mentions with categories
- ~366 mentions with profile images
- 16 custom categories mapped
- Multiple categories per mention (2-5 average)
