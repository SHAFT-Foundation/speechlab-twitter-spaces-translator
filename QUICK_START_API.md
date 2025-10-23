# Quick Start: Twitter API Mode

Get the Twitter Spaces Dubbing Agent running with Twitter API in 5 minutes.

## Prerequisites

- Node.js 18+ installed
- Twitter Developer account
- Twitter API credentials

## Step 1: Get Twitter API Credentials (5 minutes)

1. Go to https://developer.twitter.com/en/portal/dashboard
2. Create a new Project and App
3. Generate these credentials:
   - API Key (Consumer Key)
   - API Secret (Consumer Secret)
   - Access Token
   - Access Token Secret
4. Make sure your app has **"Read and Write"** permissions

## Step 2: Configure Environment Variables (2 minutes)

Copy your credentials to `.env`:

```bash
# Twitter API v2 Credentials (REQUIRED)
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET=your_api_secret_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_SECRET=your_access_token_secret_here

# Optional: Adjust polling interval (default: 5 minutes)
MENTION_POLL_INTERVAL_MS=300000
```

## Step 3: Test Your Setup (1 minute)

```bash
npx tsx src/test-mention-api.ts
```

**Expected Output:**
```
✅ Successfully connected to Twitter API
✅ Fetched X mentions
✅ All tests passed!
```

## Step 4: Start the Daemon (30 seconds)

```bash
npm run start:daemon:api
```

**What It Does:**
- Polls Twitter mentions every 5 minutes
- Looks for Space URLs in mentions
- Processes dubbing requests
- Replies with dubbed videos
- Saves state to avoid reprocessing

## Step 5: Send a Test Mention

From another Twitter account, mention your bot:

```
@YourBotAccount dub in spanish https://twitter.com/i/spaces/ABC123
```

The daemon will:
1. Detect the mention
2. Extract the Space URL
3. Process the dubbing request
4. Reply with the result

## Monitoring

The daemon logs everything to the console:

```
[🔁 Poll] Starting mention poll cycle...
[🔁 Poll] Found 1 new mention(s)
[🔄 Process] Processing mention from @username
[🔄 Process] ✅ Found Space ID: ABC123
[🐦 Reply] ✅ Reply posted successfully!
```

## Stopping the Daemon

Press `Ctrl+C` to gracefully stop the daemon. It will:
- Save the current state
- Mark all processed mentions
- Exit cleanly

## Troubleshooting

### "Missing required environment variable: TWITTER_API_KEY"
→ Check your `.env` file has all 4 Twitter credentials

### "Twitter Error Code: 403"
→ Your app needs "Read and Write" permissions
→ Go to app settings and enable, then regenerate tokens

### "Twitter Error Code: 429"
→ You hit the rate limit, the daemon will automatically retry
→ Consider increasing `MENTION_POLL_INTERVAL_MS`

### "No mentions found"
→ This is normal if you have no recent mentions
→ Send a test mention from another account

## Architecture Overview

```
Twitter → API Polling → Mention Detection → Dubbing → API Reply
         (every 5 min)  (filter new)        (process)  (with video)
```

## What's Next?

- See `TWITTER_API_SETUP.md` for detailed documentation
- See `IMPLEMENTATION_SUMMARY.md` for technical details
- Configure additional options in `.env`

## Important Notes

⚠️ **Space Audio Extraction**: The Twitter API doesn't provide Space audio URLs yet. Current implementation will reply indicating this limitation. See `TWITTER_API_SETUP.md` for hybrid approach options.

✅ **Mention Polling**: Fully working
✅ **Reply Posting**: Fully working with video
✅ **Rate Limiting**: Automatic handling
✅ **State Management**: Persistent across restarts

## Commands Reference

```bash
# Test the integration
npx tsx src/test-mention-api.ts

# Start the daemon
npm run start:daemon:api

# Check logs (if running in background)
tail -f mention_daemon.log

# View processed mentions state
cat mention_daemon_state.json
```

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review logs for error messages
3. Verify your API credentials in Developer Portal
4. Test with `test-mention-api.ts` first

---

**Ready to go!** 🚀

Your bot will now respond to mentions automatically using the official Twitter API.
