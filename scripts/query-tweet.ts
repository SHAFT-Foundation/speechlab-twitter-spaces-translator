import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

async function queryTweet(tweetId: string) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  console.log(`\n=== Querying Tweet ID: ${tweetId} ===\n`);

  // Query mentions table
  const { data: mentions, error: mentionsError } = await supabase
    .from('mentions')
    .select('id, tweet_id, content_type, status, error_message, created_at')
    .eq('tweet_id', tweetId);

  if (mentionsError) {
    console.error('Mentions Error:', mentionsError);
  } else {
    console.log('Mentions Table:');
    console.log(JSON.stringify(mentions, null, 2));
  }

  // Query dub_replies table
  const { data: dubReplies, error: dubRepliesError } = await supabase
    .from('dub_replies')
    .select('id, tweet_id, space_id, video_url, content_type, status, error_message, created_at')
    .eq('tweet_id', tweetId);

  if (dubRepliesError) {
    console.error('Dub Replies Error:', dubRepliesError);
  } else {
    console.log('\nDub Replies Table:');
    console.log(JSON.stringify(dubReplies, null, 2));
  }
}

const tweetId = process.argv[2] || '1990830841581482128';
queryTweet(tweetId).catch(console.error);
