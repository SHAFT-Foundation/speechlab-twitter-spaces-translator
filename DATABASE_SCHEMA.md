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
| `parent_tweet_category` | TEXT | Primary category of parent tweet | "Cryptocurrencies", "Gaming", "Sports" |
| `parent_tweet_category_id` | TEXT | Twitter's category ID | "12", "40", "11" |
| `parent_tweet_domains` | JSONB | Full context annotations (array of objects) | See example below |
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
- `idx_mentions_category` on `parent_tweet_category` (category filtering)

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

## Category Examples

### Common Categories You'll See:
- **Cryptocurrencies** (domain_id: 12) - Bitcoin, Ethereum, crypto topics
- **NFTs** (domain_id: 8) - NFT projects and collections
- **Gaming** (domain_id: 40) - Video games, esports
- **Sports** (domain_id: 11) - All sports topics
- **Business & finance** (domain_id: 15) - Business news, finance
- **Entertainment** (domain_id: 6) - Movies, TV, celebrities
- **Music** (domain_id: 5) - Musicians, songs, albums
- **Person** - Individual public figures
- **Business Taxonomy** - Company/organization topics
- **Events [Entity Service]** - Conferences, launches

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
