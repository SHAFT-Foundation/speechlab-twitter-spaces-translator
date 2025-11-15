# Language Tracking Update

## Summary
Source and target languages are now being saved to the mentions table in Supabase.

## Database Schema
The `source_language` and `target_language` columns already exist in the mentions table (created in original migration).

## Code Changes

### src/mentionDaemon.ts (Line 1312-1318)
Added code to save detected languages immediately after language detection:

```typescript
// Save detected languages to database
logger.info(`[💾 DATABASE] Saving detected languages to database...`);
await updateMentionStatus(mentionToProcess.tweetId, 'initiating', {
    source_language: sourceLanguageCode,
    target_language: targetLanguageCode
});
logger.info(`[💾 DATABASE] ✅ Saved languages: ${sourceLanguageCode} → ${targetLanguageCode}`);
```

## How It Works
1. When a mention is processed, languages are detected from the tweet text using `detectLanguages()`
2. Immediately after detection, `updateMentionStatus()` is called with the language codes
3. The languages are saved to the database along with the 'initiating' status
4. These fields remain in the database throughout the mention's lifecycle

## No Migration Needed
The columns already exist in the schema - this is just a code update to populate them.
