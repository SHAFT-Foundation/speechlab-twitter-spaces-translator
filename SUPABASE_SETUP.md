# Supabase Integration Setup

## Overview
The daemon now tracks all mention processing status in Supabase, providing real-time visibility into:
- Pending mentions
- Currently processing mentions
- Completed mentions with results
- Failed mentions with error messages

## Database Setup

### Step 1: Create the mentions table

1. Go to your Supabase dashboard: https://supabase.com/dashboard/project/cemuqqzmamjmtefodbqs
2. Click on "SQL Editor" in the left sidebar
3. Click "New Query"
4. Copy and paste the contents of `supabase_migration.sql`
5. Click "Run" to execute the migration

This will create:
- `mentions` table with all necessary columns
- Indexes for fast lookups
- Row Level Security (RLS) policies

### Step 2: Verify the table was created

1. Go to "Table Editor" in the left sidebar
2. You should see a `mentions` table with these columns:
   - `id` (bigint, primary key)
   - `tweet_id` (text, unique)
   - `username` (text)
   - `tweet_url` (text)
   - `tweet_text` (text)
   - `status` (text) - one of: pending, initiating, processing, complete, failed
   - `third_party_id` (text)
   - `project_id` (text)
   - `m3u8_url` (text)
   - `source_language` (text)
   - `target_language` (text)
   - `sharing_link` (text)
   - `public_video_url` (text)
   - `public_mp3_url` (text)
   - `error_message` (text)
   - `created_at` (timestamptz)
   - `updated_at` (timestamptz)

## Status Flow

Each mention goes through these statuses:

1. **pending** - Mention detected, added to init queue
2. **initiating** - Browser is extracting M3U8 URL and posting acknowledgement
3. **processing** - Backend is dubbing the audio/video with SpeechLab
4. **complete** - Successfully processed and final reply posted
5. **failed** - Error occurred at any stage (error_message contains details)

## Querying the Database

### View all pending mentions
```sql
SELECT tweet_id, username, created_at
FROM mentions
WHERE status = 'pending'
ORDER BY created_at DESC;
```

### View currently processing mentions
```sql
SELECT tweet_id, username, status, source_language, target_language, created_at
FROM mentions
WHERE status IN ('initiating', 'processing')
ORDER BY created_at DESC;
```

### View completed mentions with results
```sql
SELECT tweet_id, username, sharing_link, public_video_url, public_mp3_url, created_at
FROM mentions
WHERE status = 'complete'
ORDER BY created_at DESC
LIMIT 10;
```

### View failed mentions
```sql
SELECT tweet_id, username, error_message, created_at
FROM mentions
WHERE status = 'failed'
ORDER BY created_at DESC;
```

### Get processing statistics
```sql
SELECT
    status,
    COUNT(*) as count,
    MAX(updated_at) as last_updated
FROM mentions
GROUP BY status;
```

## Daemon Behavior

On startup, the daemon:
1. Connects to Supabase
2. Loads all `complete` and `failed` mentions into the local processed cache
3. Skips re-processing any mentions already in the database

During operation:
- New mentions are immediately added with status `pending`
- Status updates happen at each processing stage
- All results (links, IDs) are stored when complete
- Errors are captured in `error_message` field

## Monitoring

You can monitor the daemon's progress in real-time by:

1. **Supabase Dashboard**: Table Editor → mentions table
2. **SQL Queries**: Use the queries above in SQL Editor
3. **Build a simple dashboard**: Connect Supabase to tools like Retool, Grafana, or build a custom React dashboard

## Troubleshooting

### Daemon not loading processed mentions
- Check Supabase connection in logs: `[😈 Daemon] Initializing Supabase connection...`
- Verify the service role key is correct in `src/services/supabaseService.ts`

### Status not updating
- Check for Supabase errors in logs: `[📊 Supabase] Error ...`
- Verify RLS policies allow service role to UPDATE

### Duplicate processing
- The daemon checks both local `processedMentions` set AND Supabase
- If a mention is being re-processed, check that `getAllProcessedMentions()` is loading correctly on startup
