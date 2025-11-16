# Scripts

## Backfill Mention Data

**One-time script** to populate missing data in the mentions table for the last 2 weeks.

### What it does:
- Fetches all mentions from the last 2 weeks
- For each mention missing parent tweet data:
  - Fetches parent tweet from Twitter API
  - Extracts parent tweet URL and text
- For each mention missing languages:
  - Detects source and target languages from tweet text
- Updates the database with the missing data

### How to run:

```bash
# Make sure you've added the parent tweet columns first
# Run the SQL migration from migrations/003_add_parent_tweet_columns.sql

# Run the backfill script
npm run build
tsx scripts/backfill-mention-data.ts
```

### Important Notes:
- **Rate Limits**: The script includes rate limit handling and will wait if Twitter rate limits are hit
- **Speed**: Processes ~1 mention per 2 seconds to avoid rate limits (2 weeks ≈ a few hours max)
- **Idempotent**: Safe to run multiple times - skips mentions that already have data
- **One-time only**: This is NOT part of the main codebase, just a utility script

### Example Output:
```
[Backfill] Starting backfill process...
[Backfill] Found 250 mentions to process
[Backfill] Processing mention 1234567890...
[Backfill] ✅ Found parent tweet data
[Backfill] ✅ Detected languages: en → es
[Backfill] ✅ Successfully updated mention 1234567890
...
[Backfill] Backfill Complete!
[Backfill] Total mentions processed: 250
[Backfill] Updated: 200
[Backfill] Skipped (already complete): 45
[Backfill] Errors: 5
```
