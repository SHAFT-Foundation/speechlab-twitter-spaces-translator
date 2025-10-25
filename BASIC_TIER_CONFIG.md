# Basic Tier Configuration - 100 Posts/Day Sustained

## Final Configuration ✅

### Polling
- **Interval**: 5 minutes (300,000ms)
- **Daily**: 288 polls
- **Monthly**: 8,640 reads (under 10K limit)

### Posting
- **Interval**: 1 minute (60,000ms) minimum between tweets
- **Daily sustained**: ~100 posts/day average
- **Daily burst**: up to 250 posts/day (24-hour user limit)
- **Monthly**: 3,000 posts total

### Optimizations
- ✅ No acknowledgment tweets (saves 50% of quota)
- ✅ Only final replies sent
- ✅ 1 minute spacing allows fast bursts when needed
- ✅ Automatic detection of 24-hour limit

## Expected Behavior

### Normal Operation (100 posts/day)
- Poll for mentions every 5 minutes
- Process videos as they come in
- Post final reply with 1 minute spacing
- ~100 mentions processed per day
- Consistent service all month

### Burst Mode (250 posts/day)
- Can handle up to 250 posts in a single day
- Useful for high-traffic days
- After 12 burst days, monthly quota exhausted
- Bot will hit rate limits and stop posting

### Rate Limit Hit
When 24-hour limit (250) or monthly limit (3,000) is reached:
- Bot detects and logs clear error message
- Explains which limit was hit
- Shows reset time
- Automatically resumes after reset

## Monthly Budget Tracking

**Reads (10,000/month limit):**
- Polling: 8,640 reads ✅
- Parent fetches: ~1,360 reads ✅
- Total: ~10,000 reads ✅

**Writes (3,000/month limit):**
- Target: 100 posts/day × 30 = 3,000 posts ✅
- Burst capacity: Can do 250/day for 12 days = 3,000 posts ✅
- Strategy: Spread evenly for consistent service

**Daily (250 actions/24h limit):**
- Sustained: 100 posts/day ✅
- Burst: 250 posts/day ✅

## Strategies to Maximize Value

### 1. Prioritize High-Value Mentions
- Process verified accounts first
- Prioritize users with larger followings
- Skip low-quality or spam mentions

### 2. Queue Management
- Process oldest mentions first (FIFO)
- Retry failed mentions (up to 3 times)
- Track retry_count in database

### 3. Monitor Usage
- Track daily post count
- Alert when approaching limits
- Adjust strategy based on demand

### 4. Future Scaling Options
When you outgrow Basic tier:
- **Upgrade to Pro**: $5K/month for 1M posts/month
- **Add accounts**: 3 accounts × 100/day = 300 total
- **Selective processing**: Filter which mentions to respond to

## Current Status
- ✅ Optimized for 100 posts/day sustained
- ✅ Can burst to 250 posts/day when needed
- ✅ All acknowledgment tweets removed
- ✅ 1 minute spacing between posts
- ✅ 5 minute polling interval
- ✅ Automatic rate limit detection
- ✅ Clear error messages and logging

## Next Steps
1. Wait for 24-hour limit to reset (~6 hours remaining)
2. Start bot and monitor logs
3. Track daily usage to ensure staying under 100/day average
4. Adjust based on actual mention volume
