# Database Migrations

## Running Migrations

To apply the parent tweet columns migration, run this SQL in your Supabase SQL Editor:

```sql
-- Add parent tweet columns to mentions table
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_url TEXT;
ALTER TABLE mentions ADD COLUMN IF NOT EXISTS parent_tweet_text TEXT;

-- Create index on parent_tweet_url for faster lookups
CREATE INDEX IF NOT EXISTS idx_mentions_parent_tweet_url ON mentions(parent_tweet_url);
```

Or use the migration file directly:
```bash
# Navigate to migrations directory
cd migrations

# Apply migration (copy and paste content into Supabase SQL Editor)
cat 003_add_parent_tweet_columns.sql
```

## Migration History

1. `001_add_retry_count.sql` - Added retry_count column
2. `002_update_status_constraint.sql` - Updated status constraint
3. `003_add_parent_tweet_columns.sql` - Added parent_tweet_url and parent_tweet_text columns
