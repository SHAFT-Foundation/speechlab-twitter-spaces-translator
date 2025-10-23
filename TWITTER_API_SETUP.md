# Twitter API Setup Guide

This guide explains how to set up and use the Twitter API integration for the Twitter Spaces Dubbing Agent.

## Overview

The application now supports **two modes** for Twitter integration:

1. **Playwright Mode (Legacy)** - Uses browser automation to scrape Twitter
2. **Twitter API Mode (Recommended)** - Uses official Twitter API v2

The Twitter API mode provides:
- ✅ More reliable mention polling
- ✅ Better rate limit handling
- ✅ No browser automation required
- ✅ Cleaner, more maintainable code
- ✅ Official API support from Twitter

## Getting Twitter API Credentials

### Step 1: Create a Twitter Developer Account

1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Sign in with your Twitter account
3. Apply for a developer account if you haven't already
4. Wait for approval (usually instant for basic access)

### Step 2: Create a Project and App

1. In the Developer Portal, click **"Create Project"**
2. Give your project a name (e.g., "Twitter Spaces Dubbing Bot")
3. Select your use case (e.g., "Making a bot")
4. Provide a description of your app
5. Click **"Create App"** within your project

### Step 3: Get Your API Keys

After creating your app, you'll need to collect these credentials:

#### 3a. API Key and Secret (App-level)

1. In your app dashboard, go to **"Keys and tokens"** tab
2. Under **"Consumer Keys"**, you'll see:
   - **API Key** (also called Consumer Key)
   - **API Key Secret** (also called Consumer Secret)
3. Copy both values - you'll need them for `.env`

#### 3b. Access Token and Secret (User-level)

1. In the same **"Keys and tokens"** tab
2. Under **"Authentication Tokens"**, click **"Generate"** for:
   - **Access Token**
   - **Access Token Secret**
3. Copy both values - you'll need them for `.env`

⚠️ **Important**: Make sure your app has **Read and Write** permissions:
- Go to app **Settings** → **User authentication settings**
- Enable OAuth 1.0a
- Set **App permissions** to "Read and Write"
- Save changes
- You may need to regenerate your Access Token/Secret after changing permissions

### Step 4: Configure Environment Variables

Edit your `.env` file and add the Twitter API credentials:

```bash
# Twitter API v2 Keys (REQUIRED for API mode)
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET=your_api_secret_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_SECRET=your_access_token_secret_here

# Optional: Bearer token (not usually needed for user context)
TWITTER_BEARER_TOKEN=your_bearer_token_here
```

## Using the Twitter API Integration

### Running the API-Based Mention Daemon

Start the Twitter API mention polling daemon:

```bash
npm run start:daemon:api
```

This will:
1. Poll for mentions every 5 minutes (configurable via `MENTION_POLL_INTERVAL_MS`)
2. Process any Space URLs found in mentions
3. Reply with dubbed content using the Twitter API
4. Save state to avoid reprocessing mentions

### Testing the Integration

Test that your Twitter API credentials are working:

```bash
tsx src/test-mention-api.ts
```

This test script will:
- Fetch your recent mentions
- Display mention details
- Test the `sinceId` parameter for incremental polling
- (Optional) Test posting replies (disabled by default)

### Configuration Options

Add these to your `.env` file:

```bash
# Mention polling interval (milliseconds)
MENTION_POLL_INTERVAL_MS=300000  # 5 minutes

# Use Twitter API for replies (vs Playwright)
USE_TWITTER_API_FOR_REPLY=true

# Attach video inline vs link only
ATTACH_VIDEO_TO_REPLY=true
```

## Architecture

### New Services

#### `twitterMentionService.ts`
- `fetchMentions(sinceId?)` - Get mentions from Twitter API
- `postReplyWithMedia(text, tweetId, mediaPath?)` - Post reply with optional video
- `uploadMedia(mediaPath)` - Upload media to Twitter
- `getLatestTweetId(userId)` - Get latest tweet ID for tracking

#### `mentionDaemonApi.ts`
- Main daemon loop for API-based mention polling
- State management (tracks processed mentions)
- Integrates with existing dubbing pipeline
- Handles errors and rate limits gracefully

### Rate Limiting

The implementation includes automatic rate limit handling:

- **Mention polling**: 1 minute minimum between polls
- **Tweet posting**: 5 minutes minimum between tweets
- **Exponential backoff**: Automatically waits when hitting rate limits
- **Reset time tracking**: Respects Twitter's rate limit reset times

### State Management

The daemon maintains state in `mention_daemon_state.json`:

```json
{
  "lastProcessedMentionId": "1234567890",
  "processedMentionIds": ["1234567890", "1234567891"],
  "lastSaved": "2025-01-01T00:00:00.000Z"
}
```

This ensures mentions are never processed twice, even if the daemon restarts.

## Migration from Playwright Mode

### What's Different?

| Feature | Playwright Mode | API Mode |
|---------|----------------|----------|
| Mention polling | Browser scraping | Twitter API v2 |
| Reply posting | DOM manipulation | Twitter API v2 |
| Rate limits | Manual delays | Automatic handling |
| Authentication | Cookies/login | API keys |
| Reliability | Browser-dependent | API-guaranteed |
| Maintenance | High (UI changes) | Low (API stable) |

### Current Limitations

⚠️ **Space Audio Extraction**: The Twitter API does **not** provide direct access to Space audio M3U8 URLs. The current implementation has this limitation marked as a TODO.

**Workaround options:**
1. Keep using Playwright for Space audio extraction only
2. Use hybrid approach: API for mentions/replies, Playwright for audio
3. Wait for Twitter to add Space audio APIs

### Hybrid Implementation

For now, you can use a hybrid approach:

```typescript
// Use API for mention polling
const mentions = await fetchMentions();

// Use Playwright for Space audio extraction
const m3u8Url = await getM3u8ForSpacePage(spaceUrl); // Playwright

// Use API for posting replies
await postReplyWithMedia(replyText, tweetId, videoPath);
```

## Troubleshooting

### "Missing required environment variable: TWITTER_API_KEY"

Make sure you've copied all four required values to your `.env` file.

### "Twitter Error Code: 403"

Your app might not have Read and Write permissions. Check:
1. App Settings → User authentication settings
2. App permissions = "Read and Write"
3. Regenerate Access Token/Secret after changing permissions

### "Twitter Error Code: 429" (Rate Limited)

The code handles this automatically with exponential backoff. If you see this:
- Wait for the automatic retry
- Consider increasing `MENTION_POLL_INTERVAL_MS`
- Check Twitter's rate limit documentation

### "No mentions found"

This is normal if:
- Your account has no recent mentions
- You're using a new API token (only fetches recent mentions)
- Your bot account needs to be mentioned first

## Testing Your Setup

### Quick Test Checklist

1. ✅ Environment variables configured in `.env`
2. ✅ Run test script: `tsx src/test-mention-api.ts`
3. ✅ Verify mention fetching works
4. ✅ Send a test mention to your bot account
5. ✅ Run daemon: `npm run start:daemon:api`
6. ✅ Verify daemon processes the mention

## Additional Resources

- [Twitter API v2 Documentation](https://developer.twitter.com/en/docs/twitter-api)
- [twitter-api-v2 Library Docs](https://github.com/PLhery/node-twitter-api-v2)
- [Rate Limits Reference](https://developer.twitter.com/en/docs/twitter-api/rate-limits)

## Support

If you encounter issues:
1. Check the logs in the console
2. Verify your API credentials
3. Test with the test script first
4. Check Twitter API status page
5. Review rate limit status in Developer Portal
