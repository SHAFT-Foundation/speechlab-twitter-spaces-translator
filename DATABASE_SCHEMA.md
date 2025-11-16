# Mentions Database Schema Documentation

## Overview
The system tracks Twitter mentions and their dubbing jobs in a Supabase PostgreSQL database. The main table is `mentions` with a helper view `mentions_with_categories` for easier querying.

---

## Table: `mentions`

### Description
Stores all Twitter mentions requesting video/audio dubbing, including parent tweet information, processing status, and categorization.

### Columns

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `id` | BIGSERIAL | Primary key (auto-increment) | 1234 |
| `tweet_id` | TEXT | Unique Twitter mention tweet ID | "1989787665672388880" |
| `username` | TEXT | Username who mentioned the bot | "johndoe" |
| `parent_username` | TEXT | Username of the parent tweet author | "elonmusk" |
| `tweet_url` | TEXT | Full URL to the mention tweet | "https://twitter.com/johndoe/status/..." |
| `tweet_text` | TEXT | Full text of the mention tweet | "@dubbingagent dub in spanish" |
| `parent_tweet_url` | TEXT | Full URL to the parent tweet being dubbed | "https://twitter.com/elonmusk/status/..." |
| `parent_tweet_text` | TEXT | Text content of the parent tweet | "Elon exposes OpenAI..." |
| `parent_tweet_category` | TEXT | Primary category from Twitter | "Cryptocurrencies", "Gaming", "Sports" |
| `parent_tweet_category_id` | TEXT | Twitter's category ID | "12", "40", "11" |
| `parent_tweet_domains` | JSONB | Full context annotations (array of objects) | See example below |
| `custom_category` | TEXT | Mapped to 16 business categories | "NFTs", "Digital creators", "Business & finance" |
| `twitter_profile_image_url` | TEXT | Profile image URL of the mentioner | "https://pbs.twimg.com/profile_images/..." |
| `status` | TEXT | Processing status | "pending", "processing", "complete", "failed" |
| `retry_count` | INTEGER | Number of retry attempts | 0, 1, 2, 3 |
| `source_language` | TEXT | Detected source language code | "en", "es", "fr" |
| `target_language` | TEXT | Target dubbing language code | "ja", "zh", "ko" |
| `third_party_id` | TEXT | Unique project identifier | "project-en-to-ja-1234567890" |
| `project_id` | TEXT | SpeechLab API project ID | "proj_abc123" |
| `m3u8_url` | TEXT | Video stream URL | "https://video.twimg.com/..." |
| `sharing_link` | TEXT | SpeechLab sharing link | "https://speechlab.com/share/..." |
| `public_video_url` | TEXT | S3 URL to dubbed video | "https://s3.amazonaws.com/..." |
| `public_mp3_url` | TEXT | S3 URL to dubbed audio | "https://s3.amazonaws.com/..." |
| `error_message` | TEXT | Error details if failed | "Failed to download video" |
| `created_at` | TIMESTAMPTZ | When mention was first saved | 2025-11-15 14:30:00+00 |
| `updated_at` | TIMESTAMPTZ | Last update timestamp | 2025-11-15 14:35:00+00 |

### Example `parent_tweet_domains` JSONB:
```json
[
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
```

### Indexes
- `idx_mentions_tweet_id` on `tweet_id` (unique lookups)
- `idx_mentions_status` on `status` (filtering by status)
- `idx_mentions_created_at` on `created_at DESC` (time-based queries)
- `idx_mentions_parent_tweet_url` on `parent_tweet_url` (parent tweet lookups)
- `idx_mentions_category` on `parent_tweet_category` (Twitter category filtering)
- `idx_mentions_custom_category` on `custom_category` (custom category filtering)

---

## View: `mentions_with_categories`

### Description
A **flattened view** that expands the JSONB `parent_tweet_domains` array so each category/entity becomes its own row. This makes category-based queries much simpler.

### Key Difference from `mentions` Table
- **`mentions` table**: One row per mention
- **`mentions_with_categories` view**: Multiple rows per mention if the parent tweet has multiple categories

### Columns
All columns from `mentions` table, PLUS:

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `domain_id` | TEXT | Extracted domain ID from JSONB | "12", "40", "15" |
| `domain_name` | TEXT | Extracted domain name | "Cryptocurrencies", "Gaming" |
| `entity_id` | TEXT | Extracted entity ID | "1007360414114435072" |
| `entity_name` | TEXT | Extracted entity name | "Bitcoin", "Ethereum" |

### Example Data

**mentions table** (1 row):
```
tweet_id: 1989787665672388880
username: johndoe
parent_tweet_category: Cryptocurrencies
parent_tweet_domains: [
  {"domain_id": "12", "domain_name": "Cryptocurrencies", "entity_name": "Bitcoin"},
  {"domain_id": "15", "domain_name": "Business & finance", "entity_name": null}
]
```

**mentions_with_categories view** (2 rows from same mention):
```
Row 1:
  tweet_id: 1989787665672388880
  username: johndoe
  domain_id: 12
  domain_name: Cryptocurrencies
  entity_name: Bitcoin

Row 2:
  tweet_id: 1989787665672388880
  username: johndoe
  domain_id: 15
  domain_name: Business & finance
  entity_name: null
```

---

## Common Query Patterns

### Using `mentions` table (faster, when you don't need category details):
```sql
-- Count by primary category
SELECT parent_tweet_category, COUNT(*)
FROM mentions
GROUP BY parent_tweet_category;

-- Find by status
SELECT * FROM mentions WHERE status = 'complete';

-- Recent mentions
SELECT * FROM mentions ORDER BY created_at DESC LIMIT 10;
```

### Using `mentions_with_categories` view (when you need entity-level detail):
```sql
-- Find all Bitcoin-related dubs
SELECT * FROM mentions_with_categories
WHERE entity_name = 'Bitcoin';

-- Count unique mentions by domain (use DISTINCT!)
SELECT domain_name, COUNT(DISTINCT tweet_id) as count
FROM mentions_with_categories
GROUP BY domain_name;

-- Find mentions in multiple categories
SELECT tweet_id, STRING_AGG(DISTINCT domain_name, ', ') as categories
FROM mentions_with_categories
GROUP BY tweet_id
HAVING COUNT(DISTINCT domain_name) > 1;
```

---

## Table: `category_mappings`

### Description
Maps Twitter's context annotation categories to 16 custom business categories. This provides a consistent categorization system that matches business needs.

### Columns

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `id` | SERIAL | Primary key | 1 |
| `twitter_category` | TEXT | Category name from Twitter API | "Business Taxonomy", "Person" |
| `custom_category` | TEXT | Mapped business category | "Business & finance", "Digital creators" |
| `priority` | INTEGER | Priority for multiple mappings (lower = higher priority) | 1, 2, 3 |
| `created_at` | TIMESTAMPTZ | When mapping was created | 2025-11-16 12:00:00+00 |

### Index
- `idx_category_mappings_twitter_category` on `twitter_category` (fast mapping lookups)

### The 16 Custom Categories

These are the business categories that Twitter categories get mapped to:

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

### Example Mappings

| Twitter Category | Custom Category | Priority |
|-----------------|-----------------|----------|
| Business Taxonomy | Business & finance | 2 |
| Person | Digital creators | 3 |
| Cryptocurrencies | Cryptocurrencies | 1 |
| NFTs | NFTs | 1 |
| Gaming | Gaming | 1 |
| Events [Entity Service] | Entertainment | 3 |

---

## View: `mentions_with_custom_categories`

### Description
Flattened view that applies custom category mappings to mentions. Each mention may appear multiple times if it maps to multiple custom categories.

### Key Features
- Joins mentions with category_mappings
- Shows both Twitter categories and mapped custom categories
- Ordered by priority (highest priority mapping shown first)
- Use `DISTINCT ON (tweet_id, custom_category)` to get unique mention-category pairs

### Columns
All columns from `mentions` table, PLUS:

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| `original_twitter_category` | TEXT | Twitter's category | "Business Taxonomy" |
| `custom_category` | TEXT | Mapped business category | "Business & finance" |
| `twitter_domain_id` | TEXT | Twitter domain ID | "15" |
| `twitter_domain_name` | TEXT | Twitter domain name | "Business Taxonomy" |
| `twitter_entity_id` | TEXT | Twitter entity ID | "1007360414114435072" |
| `twitter_entity_name` | TEXT | Twitter entity name | "Bitcoin" |

### Usage Examples

```sql
-- Count mentions by custom category
SELECT custom_category, COUNT(DISTINCT tweet_id) as count
FROM mentions_with_custom_categories
GROUP BY custom_category
ORDER BY count DESC;

-- Find all NFT-related mentions
SELECT * FROM mentions_with_custom_categories
WHERE custom_category = 'NFTs';

-- Get category distribution
SELECT
    custom_category,
    COUNT(DISTINCT tweet_id) as mentions,
    ROUND(100.0 * COUNT(DISTINCT tweet_id) / SUM(COUNT(DISTINCT tweet_id)) OVER(), 2) as percentage
FROM mentions_with_custom_categories
GROUP BY custom_category
ORDER BY mentions DESC;
```

---

## Category System Overview

### Twitter Categories (parent_tweet_category)
- Raw categories from Twitter's Context Annotations API
- Examples: "Business Taxonomy", "Person", "Events [Entity Service]"
- Stored in `parent_tweet_category`, `parent_tweet_category_id`, `parent_tweet_domains` (JSONB)

### Custom Categories (custom_category)
- 16 business-specific categories
- Mapped from Twitter categories using `category_mappings` table
- Stored directly in `mentions.custom_category` column
- Examples: "NFTs", "Digital creators", "Business & finance"

### When to Use Which

**Use `custom_category` when:**
- You need business analytics (most common use case)
- You want consistent, predictable categories
- You're building reports or dashboards
- You need to filter by specific business verticals

**Use `parent_tweet_category` when:**
- You need raw Twitter data
- You want granular entity-level details
- You're debugging category mappings
- You need Twitter's original classification

---

## Important Notes for Querying

### 1. Always use `DISTINCT tweet_id` when counting in the view:
```sql
-- ❌ WRONG - Overcounts due to multiple rows per mention
SELECT COUNT(*) FROM mentions_with_categories WHERE domain_name = 'Gaming';

-- ✅ CORRECT - Counts unique mentions
SELECT COUNT(DISTINCT tweet_id) FROM mentions_with_categories WHERE domain_name = 'Gaming';
```

### 2. Use the table for better performance when possible:
```sql
-- ✅ Fast - Query table directly
SELECT * FROM mentions WHERE parent_tweet_category = 'Cryptocurrencies';

-- ⚠️ Slower - Use view only when you need entity details
SELECT * FROM mentions_with_categories WHERE entity_name = 'Bitcoin';
```

### 3. JSONB queries on the table:
```sql
-- Search within JSONB
SELECT * FROM mentions
WHERE parent_tweet_domains::text LIKE '%Bitcoin%';

-- Extract specific fields
SELECT
  tweet_id,
  parent_tweet_domains->0->>'domain_name' as first_category
FROM mentions;
```

---

## Status Values

| Status | Description |
|--------|-------------|
| `pending` | Mention saved, waiting to be processed |
| `initiating` | Starting to process the mention |
| `processing` | Backend dubbing in progress |
| `complete` | Successfully dubbed and replied |
| `failed` | Failed but will retry (retry_count < 3) |
| `final_failure` | Failed after 3 attempts, won't retry |
| `skipped_no_video` | Parent tweet had no video to dub |

---

## Language Codes

Common language codes used:
- `en` - English
- `es` - Spanish
- `fr` - French
- `ja` - Japanese
- `zh` - Chinese
- `ko` - Korean
- `pt` - Portuguese
- `hi` - Hindi
- `ar` - Arabic
- `id` - Indonesian

---

## Data Flow

1. **Mention detected** → Saved to `mentions` table with status `pending`
2. **Language detection** → `source_language` and `target_language` populated
3. **Category extraction** → Parent tweet categories saved from Twitter API
4. **Processing begins** → Status changed to `processing`, `third_party_id` and `project_id` set
5. **Dubbing complete** → `public_video_url` or `public_mp3_url` populated
6. **Reply posted** → Status changed to `complete`

---

## For Claude Code Integration

When querying this data from another Claude Code session, you can:

1. **Query recent mentions**:
```sql
SELECT * FROM mentions ORDER BY created_at DESC LIMIT 100;
```

2. **Analyze categories**:
```sql
SELECT domain_name, COUNT(DISTINCT tweet_id) as count
FROM mentions_with_categories
GROUP BY domain_name
ORDER BY count DESC;
```

3. **Track completion rate**:
```sql
SELECT
  status,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
FROM mentions
GROUP BY status;
```

4. **Find high-value content** (multiple categories):
```sql
SELECT
  m.tweet_id,
  m.username,
  m.parent_tweet_url,
  COUNT(DISTINCT v.domain_name) as category_count,
  STRING_AGG(DISTINCT v.domain_name, ', ') as categories
FROM mentions m
JOIN mentions_with_categories v ON m.tweet_id = v.tweet_id
GROUP BY m.tweet_id, m.username, m.parent_tweet_url
HAVING COUNT(DISTINCT v.domain_name) >= 2
ORDER BY category_count DESC;
```
