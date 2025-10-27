# Video Upload Debugging & API Quota Improvements

## Changes Made

### 1. Removed Error Tweets (Saves API Quota!)
**Problem:** Bot was posting error messages when video/MP3 URLs were missing
- "Processing finished but I couldn't prepare the dubbed video file"
- These wasted 1 API call per failed processing

**Solution:** Skip these mentions entirely, don't post anything
- Logs warning instead
- Saves API quota
- User doesn't get confusing partial error messages

**Code Changed:** `src/mentionDaemon.ts` lines 1627-1654
```typescript
// DON'T POST ERROR MESSAGE - SKIP THIS MENTION TO SAVE API QUOTA
logger.warn(`[↩️ Reply Queue] Backend succeeded but no video/MP3 URLs available. SKIPPING reply to save API quota.`);
return; // Exit early, don't post anything
```

### 2. Reduced Upload Retries (Saves 43% API Calls on Failures!)
**Problem:** Failed uploads with 5 retries = 6 API calls wasted
- With 50% failure rate: 10 uploads = 35 API calls

**Solution:** Only 2 retries (3 total attempts)
- With 50% failure rate: 10 uploads = 20 API calls
- **Saves 43% of API quota on failed uploads!**

**Code Changed:** `src/services/twitterMentionService.ts` line 870
```typescript
const UPLOAD_MAX_RETRIES = 2; // Only 2 retries (3 total attempts) to save quota
```

### 3. Enhanced Upload Debugging
Added comprehensive logging to diagnose why uploads are failing >50% of the time:

#### File Verification Logging:
- ✅ File existence check with full path
- ✅ Current working directory logged
- ✅ File size in MB, KB, and bytes
- ✅ File modification timestamp  
- ✅ File extension detection
- ✅ Twitter size limit check (512 MB max)
- ✅ File stability check (waits to ensure not still downloading)

#### Upload Performance Logging:
- ⏱️ Upload duration in ms and seconds
- 📊 Upload speed in MB/s
- 🎬 MIME type used
- 📤 Attempt number

#### Error Logging (Enhanced):
- Full error object (JSON)
- Error type, code, message
- Network error detection with syscall details
- InvalidMedia error detection
- Rate limit headers if available
- Error stack trace

**Example Debug Output:**
```
[🐦 Upload] 🚀 Starting media upload
[🐦 Upload] File path: /path/to/video.mp4
[🐦 Upload] ✅ File verification passed
[🐦 Upload] 📊 File size: 15.32 MB (15,682 KB, 16,056,320 bytes)
[🐦 Upload] 🕒 File modified: 2025-10-27T15:00:00.000Z
[🐦 Upload] 🎬 File type: .mp4
[🐦 Upload] ✅ File size within Twitter limits (max 512 MB)
[🐦 Upload] 📤 Starting upload to Twitter API...
[🐦 Upload] ⏱️ Upload duration: 8543ms (8.54s)
[🐦 Upload] 📊 Upload speed: 1.79 MB/s
```

## What to Look For in Logs

### Common Upload Failure Patterns:

#### 1. Network Timeouts
```
[🐦 Upload] 🌐 Network Error Details:
[🐦 Upload] - Error type: request
[🐦 Upload] - Syscall: connect/read/write
```
**Possible causes:**
- Slow network connection
- Twitter API slow to respond
- File too large for connection speed

#### 2. InvalidMedia Errors
```
[🐦 Upload] ⚠️ InvalidMedia error - likely network timeout during upload
```
**Possible causes:**
- Upload timing out (large file + slow connection)
- Corrupted video file
- Unsupported codec/format

#### 3. File Issues
```
[🐦 Upload] ❌ File too large! Size: 600 MB, Twitter limit: 512 MB
[🐦 Upload] ⚠️ File size changed during verification
```
**Possible causes:**
- Video exceeds 512 MB limit
- File still being written when upload attempted

#### 4. Rate Limits
```
[🐦 Upload] 🚨 RATE LIMIT (429)
[🐦 Upload] User Remaining: 0
```
**Cause:** Hit 250 actions/24h user limit

### Debugging Steps:

1. **Check upload speed logs** - if consistently <0.5 MB/s, network issue
2. **Check file sizes** - if >100 MB, may timeout on slow connections
3. **Check error types** - InvalidMedia vs network errors
4. **Check upload duration** - if >30s, likely to timeout

## Expected Results

### With These Changes:
- ❌ No more error tweets wasting API quota
- ✅ Failed uploads use 43% fewer API calls
- 📊 Comprehensive logs to diagnose upload failures
- 🔍 Can identify if issue is network, file size, format, or rate limits

### Next Steps to Debug Upload Failures:

1. **Run the bot and check logs** for upload attempts
2. **Look for patterns**:
   - Are all failures same error type?
   - Are failures on large files only?
   - Are failures time-of-day related (network congestion)?
   - Are failures after certain duration?

3. **Possible Solutions Based on Logs**:
   - If network timeouts: Increase timeout, compress videos more
   - If file size issues: Set max size limit <512 MB
   - If InvalidMedia: Check video codec/format compatibility
   - If rate limits: We already optimized this!

## Current Status

✅ Build successful
✅ Error tweets removed
✅ Upload retries reduced to 2
✅ Enhanced debugging added
⏳ Waiting for rate limit reset (2025-10-28 05:55:30 UTC)

When limit resets, logs will show detailed upload diagnostics!
