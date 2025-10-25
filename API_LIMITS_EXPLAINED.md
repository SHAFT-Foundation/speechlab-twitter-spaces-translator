# Twitter API Limits - Basic Tier ($100/month)

## Your Current Tier: Basic

### App-Level Limits (Monthly)
- **Read Requests (GET)**: 10,000 reads/month
- **Write Requests (POST)**: 50,000 posts/month at app level
- **Per-User Posts**: 3,000 posts/month per user

### User-Level Limits (Daily - Separate from App Limits)
- **24-Hour Action Limit**: 250 actions per day per user account
  - This applies to the @DubbingAgent USER account
  - Separate from your Basic tier app limits
  - Resets every 24 hours

## Current Issue

You're hitting the **USER-LEVEL 24-hour limit of 250 actions/day**.

This is visible in API responses as:
```
x-user-limit-24hour-limit: 250
x-user-limit-24hour-remaining: 0
x-user-limit-24hour-reset: [unix timestamp]
```

## Optimizations Made

### 1. Polling Interval Adjusted
- **Before**: 2 minutes (720 polls/day = 21,600/month) ❌
- **After**: 5 minutes (288 polls/day = 8,640/month) ✅

This keeps you under the 10,000 reads/month limit.

### 2. User Limit Detection Added
The bot now detects when the 24-hour user limit is hit and will:
- Log detailed information about the limit
- Explain it's separate from app-level limits
- Stop retrying and throw an error

### 3. Better Error Logging
Now shows:
- Full authentication credentials (for debugging)
- Distinction between user limits and app limits
- Reset times for both types of limits

## How to Stay Within Limits

### For Reads (GET requests):
- Poll every 5 minutes: ~8,640 reads/month ✅
- Fetch parent tweets only when needed
- Cache results when possible

### For Writes (POST requests):
- Current user limit: 250 actions/day = ~7,500/month ✅
- Basic tier allows 3,000 posts/month per user ✅
- Be selective about which mentions to reply to

## Calculating Your Usage

**Monthly Reads:**
- Polls: 288/day × 30 = 8,640 reads
- Parent tweet fetches: ~50/day × 30 = 1,500 reads
- **Total: ~10,140 reads/month** (slightly over - may need adjustment)

**Monthly Writes:**
- Replies: Currently hitting 250/day = 7,500/month
- This exceeds the 3,000/month per-user limit!

## Recommendations

1. **Reduce reply volume to stay under 3,000/month:**
   - 3,000 ÷ 30 days = 100 replies/day maximum
   - Consider filtering which mentions to respond to

2. **Increase polling interval if needed:**
   - 6 minutes: 240 polls/day = 7,200/month
   - 7 minutes: 206 polls/day = 6,180/month

3. **Use webhooks instead of polling** (when available):
   - Dramatically reduces read requests
   - More efficient and real-time

## Next Steps

1. Wait for the 24-hour limit to reset (~8 hours)
2. Monitor daily usage with the improved logging
3. Adjust polling interval if approaching limits
4. Consider implementing reply filtering logic
