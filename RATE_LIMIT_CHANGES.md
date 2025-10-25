# Rate Limit Optimization Changes

## Changes Made

### 1. Mention Polling Interval
**File**: `.env`
- **Before**: Poll every 2 minutes (720 polls/day = 21,600/month) ❌
- **After**: Poll every 15 minutes (96 polls/day = 2,880/month) ✅
- **Impact**: Stays well under 10,000 reads/month limit

### 2. Tweet Posting Rate Limit
**File**: `src/services/twitterMentionService.ts`
- **Before**: 10 seconds between tweets (8,640 tweets/day possible)
- **After**: 15 minutes between tweets (96 tweets/day max)
- **Impact**: Stays under 100 posts/day target (3,000/month ÷ 30 days)

### 3. Removed Acknowledgment Tweet
**File**: `src/mentionDaemon.ts`
- **Removed**: "Got it! Dubbing your video from X to Y. I'll reply when ready! 🎬"
- **Impact**: Saves 1 tweet per mention = cuts tweet volume in half
- **User Experience**: Users now only get the final reply with the dubbed video

### 4. Enhanced Rate Limit Logging
**File**: `src/services/twitterMentionService.ts`
- Added clear logging when rate limit protection kicks in
- Shows wait time in minutes and seconds
- Explains it's to stay under Basic tier limits

### 5. User-Level 24-Hour Limit Detection
**File**: `src/services/twitterMentionService.ts`
- Detects `x-user-limit-24hour-remaining: 0`
- Logs detailed explanation of the difference between user limits and app limits
- Stops retrying and throws error when hit

## New Rate Limit Budget

### Monthly Reads (GET requests) - Limit: 10,000
- Mention polls: 96/day × 30 = 2,880 reads ✅
- Parent tweet fetches: ~50/day × 30 = 1,500 reads
- **Total: ~4,380 reads/month** (well under 10,000 limit) ✅

### Monthly Writes (POST requests) - Limit: 3,000 per user
- Removed acknowledgment tweets (saves 50% of tweets)
- Final replies only: ~50/day × 30 = 1,500 posts ✅
- Spread out: 1 post every 15 minutes maximum
- **Total: ~1,500 posts/month** (well under 3,000 limit) ✅

### Daily User Action Limit - Limit: 250 per day
- With 15-min spacing: max 96 posts/day ✅
- **Total: 96 actions/day** (well under 250 limit) ✅

## Benefits

1. **Stays under all limits**: Read, write, and daily action limits
2. **No more acknowledgment spam**: Users get one reply instead of two
3. **Predictable pacing**: 15-minute intervals for both polls and posts
4. **Better error handling**: Detects and explains 24-hour user limits
5. **Budget headroom**: Leaves room for retries and error handling

## Expected Behavior

- Bot polls mentions every 15 minutes
- When processing a mention:
  - Skips acknowledgment tweet (saves API quota)
  - Processes video in backend
  - Waits 15 minutes after last tweet before posting final reply
  - Only posts when video is ready with result

## Next Steps

1. Wait for 24-hour limit to reset (~8 hours from last run)
2. Monitor logs to verify 15-minute spacing is working
3. Track monthly usage to ensure staying under limits
4. Adjust intervals if needed based on actual usage patterns
