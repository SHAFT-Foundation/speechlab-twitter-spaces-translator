# Category Automation - How It Works

## Overview

The category mapping system is **fully automated**. You don't need to run any backfill scripts for new mentions going forward.

---

## Automatic Category Assignment

### How It Works

When a new mention is detected by `mentionDaemon.ts`:

1. **Twitter API fetch** → Gets parent tweet with `context_annotations`
2. **Extract domains** → Stores in `parent_tweet_domains` (JSONB)
3. **Map to categories** → Automatically looks up mappings in `category_mappings` table
4. **Save to database** → Stores multiple custom categories in `custom_category` array
5. **Ready to query** → Instantly available for analytics

### Code Flow

```typescript
// In mentionDaemon.ts (lines 2200-2206)
const { mapDomainsToCategories } = await import('./services/supabaseService');
const customCategories = await mapDomainsToCategories(mention.parentTweetDomains || []);

if (customCategories.length > 0) {
    logger.info(`[📊 Categories] Mapped ${mention.tweetId} to: ${customCategories.join(', ')}`);
}

// Saved automatically with the mention
await upsertMention({
    // ... other fields
    custom_category: customCategories,
    // ...
});
```

---

## When You Need to Run Backfill

### ✅ Backfill Needed:

**Historical data** - Mentions created before the automation was added
```bash
npx tsx scripts/backfill-custom-categories.ts
```

**New category mappings** - When you add new Twitter→Custom category mappings
```sql
-- Add new mapping
INSERT INTO category_mappings (twitter_category, custom_category, priority)
VALUES ('New Twitter Category', 'Cryptocurrencies', 2);

-- Then backfill to apply to existing mentions
npx tsx scripts/backfill-custom-categories.ts
```

### ❌ Backfill NOT Needed:

**New mentions** - Automatically categorized when they arrive
**Existing mentions with categories** - Already have categories assigned
**Regular operation** - Daemon handles everything

---

## Monitoring Category Assignment

Check the daemon logs to see categories being assigned:

```bash
# Watch daemon logs
tail -f logs/daemon.log | grep "📊 Categories"
```

You'll see output like:
```
[📊 Categories] Mapped 1989787665672388880 to: Cryptocurrencies, Business & finance, Entertainment
[📊 Categories] Mapped 1989829579234804024 to: Gaming, Digital creators, Business & finance, Entertainment
```

---

## Troubleshooting

### Issue: New mentions not getting categories

**Check 1:** Does the parent tweet have `context_annotations`?
```javascript
// Query to check
const { data } = await supabase
  .from('mentions')
  .select('tweet_id, parent_tweet_domains, custom_category')
  .is('custom_category', null)
  .not('parent_tweet_domains', 'is', null);
```

If `parent_tweet_domains` is not null but `custom_category` is null, the Twitter categories might not have mappings yet.

**Check 2:** Are the Twitter categories mapped?
```sql
SELECT DISTINCT elem->>'domain_name' as twitter_category
FROM mentions,
     jsonb_array_elements(parent_tweet_domains) as elem
WHERE custom_category IS NULL
  AND parent_tweet_domains IS NOT NULL;
```

**Fix:** Add missing mappings
```sql
INSERT INTO category_mappings (twitter_category, custom_category, priority)
VALUES
  ('Unmapped Twitter Category', 'Best Fitting Custom Category', 2)
ON CONFLICT (twitter_category, custom_category) DO NOTHING;
```

### Issue: Categories seem wrong

**Check the mappings:**
```sql
SELECT * FROM category_mappings
WHERE twitter_category = 'The Twitter Category You Want to Check';
```

**Update priority** (lower = higher priority):
```sql
-- Make this mapping preferred
UPDATE category_mappings
SET priority = 1
WHERE twitter_category = 'Twitter Category'
  AND custom_category = 'Preferred Custom Category';
```

---

## Adding New Category Mappings

### Step 1: Identify unmapped Twitter categories

```sql
-- Find Twitter categories without mappings
SELECT DISTINCT elem->>'domain_name' as twitter_category
FROM mentions,
     jsonb_array_elements(parent_tweet_domains) as elem
WHERE NOT EXISTS (
    SELECT 1 FROM category_mappings cm
    WHERE cm.twitter_category = elem->>'domain_name'
);
```

### Step 2: Add mappings

```sql
INSERT INTO category_mappings (twitter_category, custom_category, priority) VALUES
('Twitter Category 1', 'Your Custom Category', 2),
('Twitter Category 2', 'Your Custom Category', 2)
ON CONFLICT (twitter_category, custom_category) DO NOTHING;
```

### Step 3: Backfill existing mentions

```bash
npx tsx scripts/backfill-custom-categories.ts
```

**Note:** New mentions will automatically use the new mappings. No code changes needed!

---

## Category Mapping Priority System

Priority determines which category to prefer when multiple mappings exist:

- **Priority 1** - Exact, preferred match (e.g., `NFTs` → `NFTs`)
- **Priority 2** - Related category (e.g., `Bitcoin` → `Cryptocurrencies`)
- **Priority 3** - Broad category (e.g., `Business Taxonomy` → `Business & finance`)
- **Priority 4+** - Fallback categories

**Example:**
```sql
-- Tweet has both "Cryptocurrencies" and "Business Taxonomy" domains
-- Both map to different categories:
('Cryptocurrencies', 'Cryptocurrencies', 1)     -- Priority 1
('Business Taxonomy', 'Business & finance', 2)   -- Priority 2

-- Result: mention gets BOTH categories
custom_category = ['Cryptocurrencies', 'Business & finance']
```

---

## Performance Impact

**Minimal:** The category mapping function:
- Runs once per new mention (not per request)
- Uses an indexed table lookup (< 5ms)
- Happens during mention save (already async)
- No impact on API response times

**Database queries:**
```sql
-- Fast lookup with index
SELECT custom_category
FROM category_mappings
WHERE twitter_category IN (...)
-- Uses: idx_category_mappings_twitter_category
```

---

## Summary

### ✅ Fully Automated
- New mentions get categories automatically
- No manual intervention needed
- Categories saved in real-time

### ✅ Easy to Extend
- Add new mappings with simple SQL
- Run backfill for historical data
- No code changes required

### ✅ Multiple Categories
- Each mention can have 2-5 categories
- Better coverage for analytics
- Crypto tweets properly tagged as BOTH "Cryptocurrencies" AND "Business & finance"

### ✅ No Maintenance
- Mapping table handles everything
- Add mappings once, applies to all future mentions
- Backfill scripts available for historical data

---

## Quick Reference

```bash
# Check if daemon is assigning categories
tail -f logs/daemon.log | grep "Categories"

# Run backfill for historical data
npx tsx scripts/backfill-custom-categories.ts

# Check category distribution
node -e "
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('URL', 'KEY');
(async () => {
  const { data } = await supabase.from('mentions').select('custom_category');
  const counts = {};
  data.forEach(m => m.custom_category?.forEach(c => counts[c] = (counts[c]||0)+1));
  console.log(counts);
})();
"
```

For more details, see:
- `DATABASE_INTEGRATION_GUIDE.md` - Query patterns and API usage
- `DATABASE_SCHEMA.md` - Full schema reference
- `CUSTOM_CATEGORIES.md` - Category system overview
