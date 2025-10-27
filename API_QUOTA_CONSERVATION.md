# API Quota Conservation Strategy

## Problem
Every API call counts toward your 250 actions/24h user limit, including:
- ✅ Successful calls
- ❌ Failed calls (429, 403, timeouts)
- 🔄 Retry attempts

**Video upload failures were consuming massive quota:**
- 1 failed upload with 5 retries = **6 API calls** toward your 250/day limit!

## Solution: Reduced Upload Retries

### Changed:
**Before:**
- Upload retries: 5 (6 total attempts)
- Failed upload cost: **6 API calls**

**After:**
- Upload retries: 2 (3 total attempts)
- Failed upload cost: **3 API calls** (50% reduction!)

### Code Change:
```typescript
// Only 2 retries for uploads (3 total attempts) to save quota
const UPLOAD_MAX_RETRIES = 2;
```

## Impact Analysis

### Before (with 5 retries):
- 10 video uploads with 50% failure rate
- Successful: 5 uploads × 1 call = 5 calls
- Failed: 5 uploads × 6 calls = 30 calls
- **Total: 35 API calls for 10 uploads**

### After (with 2 retries):
- 10 video uploads with 50% failure rate
- Successful: 5 uploads × 1 call = 5 calls
- Failed: 5 uploads × 3 calls = 15 calls
- **Total: 20 API calls for 10 uploads**

**Savings: 43% fewer API calls on failed uploads!**

## Other Quota Optimizations

### 1. Hybrid Authentication
- Reads: Try Bearer Token first (1,667/day app limit if supported)
- Fallback: OAuth 1.0a (100/day user limit)
- Writes: Always OAuth 1.0a (required by Twitter)

### 2. No Acknowledgment Tweets
- Saves 1 tweet per mention = 50% fewer writes
- Only final reply sent

### 3. Longer Polling Interval
- 5 minutes between polls (288/day)
- vs 2 minutes (720/day) = 60% reduction

### 4. Rate Limit Detection
- Detects `x-user-limit-24hour-remaining: 0`
- Stops immediately instead of retrying
- Logs reset time clearly

## Current Status

**You're at the 250/day limit until:** 2025-10-28 05:55:30 UTC (15 hours)

**What's consuming your quota:**
1. Video uploads (especially failures with retries) 🔴
2. Mention polling (288/day) 🟢
3. Parent tweet fetches (~50/day) 🟢
4. Final replies (~100/day) 🟡

**Estimated daily usage (after changes):**
- Polling: 288 calls
- Fetches: 50 calls
- Uploads (70% success): 50 uploads × 1.9 avg = 95 calls
- Replies: 50 calls
- **Total: ~483 calls/day** ❌ (still over 250)

## Recommendations

To stay under 250/day with uploads enabled:

### Option 1: Reduce Processing Volume
- Process 25 mentions/day instead of 50
- Skip mentions without videos (no processing needed)
- **Result: ~241 calls/day** ✅

### Option 2: Disable Video Attachments
- Set `ATTACH_VIDEO_TO_REPLY=false`
- Post S3 link only (no upload to Twitter)
- Saves all upload API calls
- **Result: ~388 calls/day** (still might be over with retries)

### Option 3: Multi-Account Setup
- Use 3 Twitter accounts
- Each gets 250 actions/day
- Rotate between accounts
- **Result: 750 actions/day total** ✅

### Option 4: Reduce Reply Volume
- Filter mentions by follower count
- Only reply to verified users
- Prioritize high-value mentions
- **Result: Variable, controllable**

## Next Steps

1. **Wait 15 hours** for limit to reset (2025-10-28 05:55:30 UTC)
2. **Monitor quota usage** with new reduced retries
3. **Track daily API call count** to ensure staying under 250
4. **Consider Option 1 or 2** if still exceeding limit
5. **Implement multi-account** if sustained high volume needed

## Monitoring

Watch for this error to know when limit is hit:
```
⚠️ ⚠️ ⚠️  USER-LEVEL 24-HOUR LIMIT EXCEEDED ⚠️ ⚠️ ⚠️
User Remaining: 0
Resets at: [timestamp]
```

Bot will automatically detect and stop until reset.
