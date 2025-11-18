# 🎙️ SpeechLab Twitter Space Translator Agent 🌎

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/) [![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

**Unlock Global Audiences for Your Twitter Spaces!** ✨

Ever wished your insightful Twitter Space conversations could reach listeners worldwide? This intelligent agent automatically monitors Twitter mentions, downloads audio/video content, uses the cutting-edge [SpeechLab AI](https://translate.speechlab.ai/) platform to dub them into another language, and posts a link to the dubbed version right back to the original tweet! 🚀

Imagine your content seamlessly translated and shared, expanding your reach and impact across language barriers – all automated!

---

## 📑 Table of Contents

- [Key Features](#-key-features)
- [Architecture Overview](#-architecture-overview)
- [System Complexities & Solutions](#-system-complexities--solutions)
- [Prerequisites](#-prerequisites)
- [Setup & Configuration](#-setup--configuration)
- [Running the Daemon](#-running-the-daemon)
- [API-Based Architecture](#-api-based-architecture)
- [Crash Recovery & Resilience](#-crash-recovery--resilience)
- [Configuration Details](#-configuration-details)
- [Monitoring & Observability](#-monitoring--observability)
- [Troubleshooting](#-troubleshooting)
- [Operations & Documentation](#-operations--documentation)

---

## ✨ Key Features

### Core Capabilities
- **🔍 Twitter Mention Monitoring:** Continuously polls Twitter API v2 for mentions of your bot account
- **🎧 Multi-Format Support:** Handles both Twitter Spaces audio and embedded video content
- **🤖 AI Dubbing:** Leverages SpeechLab API for high-quality voice-cloned translations
- **💬 Automated Replies:** Posts dubbed content links back to original tweets
- **📊 Supabase Integration:** Tracks all mention statuses and processing history
- **♻️ Crash Recovery:** Automatically retries failed/interrupted mentions on restart
- **🛡️ Bulletproof Error Handling:** Comprehensive retry logic and graceful degradation

### Advanced Features
- **📝 Language Detection:** Automatically detects source and target languages from mention text
- **🔄 Duplicate Prevention:** Tracks processed mentions to avoid redundant processing
- **⏱️ Rate Limit Management:** Intelligent handling of Twitter API rate limits with false 429 detection
- **📦 Queue-Based Processing:** Separate queues for initiation and final reply stages
- **🎯 Smart Validation:** Filters out invalid dubbing requests before processing
- **📈 Configurable Polling:** Adjustable mention fetch limits (default: 100 mentions per poll)

---

## 🏗️ Architecture Overview

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Twitter Mention Monitoring                    │
│                                                                   │
│  1. Poll Twitter API v2 (every 120s) ──────────────────────┐   │
│     └─> Fetch up to 100 mentions                           │   │
│                                                             │   │
│  2. Validate Dubbing Requests ─────────────────────────────┤   │
│     └─> Check for language patterns                        │   │
│     └─> Skip invalid mentions (add to skip list)           │   │
│                                                             │   │
│  3. Check Processing Status ───────────────────────────────┤   │
│     └─> Query Supabase for status (complete/failed)        │   │
│     └─> Skip already processed mentions                    │   │
│                                                             │   │
│  4. Add to Initiation Queue ───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Initiation Queue Worker                       │
│                   (Runs every 5 seconds)                         │
│                                                                   │
│  1. Fetch Video/Space URL ─────────────────────────────────┐   │
│     └─> Extract video URL from parent tweet                │   │
│     └─> Extract M3U8 URL for Twitter Spaces                │   │
│                                                             │   │
│  2. Post Acknowledgement Reply ────────────────────────────┤   │
│     └─> "Got it! Processing your request..."               │   │
│     └─> Update Supabase status → 'initiating'              │   │
│                                                             │   │
│  3. Backend Processing ────────────────────────────────────┤   │
│     └─> Download audio/video (FFmpeg)                      │   │
│     └─> Upload to S3                                        │   │
│     └─> Create SpeechLab project (with thirdPartyID)       │   │
│     └─> Wait for dubbing completion (poll every 30s)       │   │
│     └─> Download dubbed audio                               │   │
│     └─> Upload dubbed audio to public S3                    │   │
│     └─> Generate SpeechLab sharing link                     │   │
│     └─> Update Supabase status → 'processing'              │   │
│                                                             │   │
│  4. Add to Final Reply Queue ──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Final Reply Queue Worker                       │
│                   (Runs every 5 seconds)                         │
│                                                                   │
│  1. Download Dubbed Video (if applicable) ─────────────────┐   │
│     └─> Download from SpeechLab presigned URL               │   │
│     └─> Upload to public S3                                 │   │
│                                                             │   │
│  2. Post Final Reply with Results ─────────────────────────┤   │
│     └─> Include sharing link                                │   │
│     └─> Include video/audio URLs                            │   │
│     └─> Mention @shaftfinance $shaft                        │   │
│                                                             │   │
│  3. Mark as Complete ──────────────────────────────────────┤   │
│     └─> Update Supabase status → 'complete'                │   │
│     └─> Add to processedMentions set                        │   │
│     └─> Write to processed_mentions.json                    │   │
│                                                             │   │
│  4. Cleanup Temporary Files ───────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          mentionDaemon.ts                        │
│                      (Main Orchestration)                        │
└────────────┬────────────────────────────────────────────────────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
┌────────────┐  ┌────────────────┐
│  Queues    │  │  Worker Loops  │
│            │  │                │
│ • mention  │  │ • pollMentions │
│ • initiate │  │ • runInitQueue │
│ • reply    │  │ • runReplyQueue│
└────────────┘  └────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                           Services Layer                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  twitterMentionService.ts  │  speechlabApiService.ts             │
│  • fetchMentions()         │  • createDubbingProject()           │
│  • postReplyWithMedia()    │  • waitForProjectCompletion()       │
│  • uploadMedia()           │  • generateSharingLink()            │
│  • fetchVideoForMention()  │  • getProjectByThirdPartyID()       │
│                            │                                      │
│  audioService.ts           │  supabaseService.ts                 │
│  • downloadAndUploadAudio()│  • upsertMention()                  │
│  • downloadAndUploadVideo()│  • updateMentionStatus()            │
│  • uploadLocalFileToS3()   │  • getMention()                     │
│                            │  • getAllProcessedMentions()         │
│                                                                   │
│  fileUtils.ts              │  languageUtils.ts                   │
│  • downloadFile()          │  • detectLanguages()                │
│                            │  • isValidDubbingRequest()           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 System Complexities & Solutions

### 1. Twitter API Rate Limiting

**Challenges:**
- Twitter API v2 has strict rate limits (450 requests/15min for mentions endpoint)
- Rate limits are per-user, per-endpoint
- False 429 errors: Sometimes Twitter returns HTTP 429 but with `remaining > 0`
- Must track rate limit headers: `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`

**Solutions Implemented:**

#### False 429 Detection
```typescript
// Check if Twitter returned false 429 (remaining > 0)
const isFalse429 = error.code === 429 && error.rateLimit?.remaining > 0;

if (isFalse429) {
  logger.warn('FALSE RATE LIMIT DETECTED - ignoring');
  // Continue processing - don't store reset time
} else {
  // Real rate limit - store reset time and wait
  rateLimitResetTime = resetTime.getTime();
}
```

#### Exponential Backoff Retry
```typescript
// 10 retries with exponential backoff
const MAX_RETRIES = 10;
const backoffDelay = Math.min(
  2000 * Math.pow(2, attempt) + Math.random() * 1000,
  300000 // Max 5 minutes
);
```

#### Global Rate Limit Tracking
```typescript
// Store reset time globally so all requests can check
let rateLimitResetTime: number | null = null;

// Before making request
if (rateLimitResetTime && Date.now() < rateLimitResetTime) {
  const waitTime = rateLimitResetTime - Date.now();
  await sleep(waitTime + 5000); // Add 5s buffer
}
```

#### Configurable Polling Intervals
```typescript
// .env configuration
POLLING_INTERVAL_MS=120000  // Default: 2 minutes between polls
MAX_MENTIONS_PER_POLL=100   // Fetch 100 mentions per poll to maximize valid requests
```

---

### 2. Twitter Media Upload Constraints

**Challenges:**
- Media must be uploaded to v1.1 API before tweeting (v2 doesn't support media upload)
- Max file sizes: Images (5MB), Videos (512MB)
- Only MP4/MOV/GIF supported for video
- Upload is separate from tweet posting (requires media_id)
- Network errors during upload are common

**Solutions Implemented:**

#### Retry Logic with Network Error Detection
```typescript
async function uploadMedia(mediaPath: string): Promise<string | null> {
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const mediaId = await twitterClient.v1.uploadMedia(mediaPath, { mimeType });
        return mediaId;
      } catch (error) {
        const isNetworkError = !error.code || error.type === 'request';

        if (isNetworkError && !isLastAttempt) {
          await sleep(5000); // 5 second retry for network errors
          continue;
        }

        // Handle rate limits with exponential backoff
        if (error.code === 429 && !isLastAttempt) {
          await sleep(getExponentialBackoffDelay(attempt));
          continue;
        }

        return null; // Give up on last attempt
      }
    }
  } catch (outerError) {
    // Catch any errors that escape inner try-catch
    logger.error('Unexpected error during upload:', outerError);
    return null;
  }

  return null;
}
```

#### Graceful Failure Handling
```typescript
// In postReplyWithMedia - wrap upload call
try {
  mediaId = await uploadMedia(mediaPath);
  if (!mediaId) {
    logger.error('Failed to upload media');
    return false; // Don't crash daemon
  }
} catch (uploadError) {
  logger.error('Exception during media upload:', uploadError);
  return false; // Don't crash daemon
}
```

---

### 3. SpeechLab Job Management

**Challenges:**
- Projects take 10-30 minutes to complete
- Must poll for completion status
- Jobs can fail mid-processing
- Need to track projects across multiple mentions (same Space URL)
- Rate limits on SpeechLab API (10 projects/day on free tier)
- Must handle presigned URL expiration for downloads

**Solutions Implemented:**

#### Third-Party ID Deduplication
```typescript
// Generate unique ID for each source+target combination
const thirdPartyID = `${sanitizedProjectName}-${sourceLanguageCode}-to-${targetLanguageCode}-${tweetId}`;

// Check if project already exists
const existingProject = await getProjectByThirdPartyID(thirdPartyID);

if (existingProject && existingProject.job?.status === 'COMPLETE') {
  // Reuse existing completed project
  return { success: true, sharingLink: await generateSharingLink(projectId) };
}
```

#### Project Status Polling with Timeout
```typescript
async function waitForProjectCompletion(
  thirdPartyID: string,
  maxWaitTimeMs = 60 * 60 * 1000, // 1 hour max
  checkIntervalMs = 30000 // Check every 30 seconds
): Promise<Project | null> {
  try {
    const startTime = Date.now();
    let pollCount = 0;

    while (Date.now() - startTime < maxWaitTimeMs) {
      pollCount++;
      const project = await getProjectByThirdPartyID(thirdPartyID);

      if (!project) {
        logger.warn(`Poll #${pollCount} - Could not retrieve project, retrying...`);
      } else if (project.job?.status === "COMPLETE") {
        logger.info(`✅ Project completed after ${pollCount} polls!`);
        return project;
      } else if (project.job?.status === "FAILED") {
        logger.error(`❌ Project failed with status: ${project.job?.status}`);
        return null;
      }

      await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }

    logger.warn(`⏰ Maximum wait time exceeded after ${pollCount} polls`);
    return null;
  } catch (error) {
    logger.error('Error while waiting for project completion:', error);
    return null;
  }
}
```

#### Local Project Status Tracking
```typescript
// Track project status locally in processed_mentions.json
interface ProcessedMentionData {
  mentions: string[];
  projects: {
    [thirdPartyID: string]: {
      status: 'initiated' | 'processing' | 'complete' | 'failed';
      projectId?: string;
      mentionIds: string[];
      lastUpdated: string;
    };
  };
}

// Update status at each stage
await updateProjectStatus(thirdPartyID, 'initiated', mentionId);
await updateProjectStatus(thirdPartyID, 'processing', mentionId, projectId);
await updateProjectStatus(thirdPartyID, 'complete', mentionId, projectId);
```

#### SpeechLab API Retry Logic
```typescript
// All SpeechLab API calls have 2 retries
async function createDubbingProject(...): Promise<string | null> {
  let attempt = 1;
  const maxAttempts = 2;

  while (attempt <= maxAttempts) {
    try {
      const response = await apiClient.post('/v1/dubs', payload, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      return response.data.project?.id || null;
    } catch (error) {
      if (attempt < maxAttempts) {
        logger.warn(`Attempt ${attempt} failed, retrying...`);
        attempt++;
        await sleep(2000); // Wait 2s before retry
        continue;
      }

      logger.error(`All ${maxAttempts} attempts failed`);
      return null;
    }
  }

  return null;
}
```

---

### 4. File Size & Storage Management

**Challenges:**
- Twitter Spaces can be 2+ hours (500MB+ audio files)
- Video files can be 1GB+
- Must download → upload to S3 → SpeechLab processes → download result → upload to public S3
- Disk space management for temp files
- S3 upload/download retries
- FFmpeg processing can fail with large files

**Solutions Implemented:**

#### Streaming Downloads with FFmpeg
```typescript
// Download directly to file (no in-memory buffering)
function runFfmpegDownload(m3u8Url: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
      '-i', m3u8Url,
      '-c', 'copy', // Copy codec (no re-encoding)
      '-y', outputPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}
```

#### S3 Upload with Retry and Buffer Reading
```typescript
async function uploadLocalFileToS3(localFilePath: string, s3Key: string): Promise<string | null> {
  const MAX_RETRIES = 3;

  // Verify file exists and has content
  const stats = fs.statSync(localFilePath);
  if (stats.size <= 0) {
    logger.error('File has zero bytes');
    return null;
  }

  // Read into buffer once (avoids stream consumption issues)
  const fileBuffer = await fsPromises.readFile(localFilePath);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const command = new PutObjectCommand({
        Bucket: config.AWS_S3_BUCKET,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: determineContentType(localFilePath)
      });

      await s3Client.send(command);

      const publicUrl = `https://${config.AWS_S3_BUCKET}.s3.${region}.amazonaws.com/${s3Key}`;
      logger.info(`✅ S3 upload successful: ${publicUrl}`);
      return publicUrl;
    } catch (error) {
      logger.error(`Upload attempt ${attempt + 1}/${MAX_RETRIES} failed:`, error);

      if (attempt < MAX_RETRIES - 1) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
        await sleep(delayMs);
      }
    }
  }

  logger.error(`All ${MAX_RETRIES} upload attempts failed`);
  return null;
}
```

#### Automatic Temp File Cleanup
```typescript
// Cleanup after successful processing
try {
  await fs.unlink(localFilePath);
  logger.info('✓ Successfully deleted temporary file');
} catch (err) {
  logger.warn('Failed to delete temporary file:', err);
}

// Cleanup on error (best effort)
if (fs.existsSync(localFilePath)) {
  fs.unlink(localFilePath, (err) => {
    if (err) logger.warn('Failed cleanup after error:', err);
  });
}
```

#### File Size Limits Configuration
```typescript
// Recommended limits in .env
MAX_VIDEO_SIZE_MB=200      // Process videos up to 200MB
MAX_AUDIO_SIZE_MB=100      // Process audio up to 100MB
MAX_SPACE_DURATION_MIN=120 // Skip Spaces longer than 2 hours
```

---

### 5. Crash Recovery & State Management

**Challenges:**
- Daemon can crash at any stage of processing
- Must not lose track of mentions mid-processing
- Must not duplicate work on restart
- Must retry failed mentions without re-posting replies
- Must handle partial processing (e.g., SpeechLab job started but reply not posted)

**Solutions Implemented:**

#### Separate Skip List for Invalid Mentions
```typescript
// Two separate tracking sets
let processedMentions: Set<string> = new Set();      // status='complete' or 'failed'
let skippedInvalidMentions: Set<string> = new Set(); // Invalid dubbing requests

// Invalid mentions (not valid dubbing requests)
if (!isValidDubbingRequest(mention.text)) {
  skippedInvalidMentions.add(mention.tweetId);
  continue; // Don't add to Supabase
}

// Skip already processed or invalid
if (processedMentions.has(mention.tweetId) ||
    skippedInvalidMentions.has(mention.tweetId)) {
  continue;
}
```

#### Only Mark as Processed on Success
```typescript
// ❌ OLD APPROACH (marked as processed even on failure)
try {
  const result = await processmentionMention(mention);
  await markMentionAsProcessed(mention.tweetId); // Wrong! Marked even if failed
} catch (error) {
  await markMentionAsProcessed(mention.tweetId); // Wrong! Lost mention forever
}

// ✅ NEW APPROACH (only mark on successful reply)
try {
  const result = await processMention(mention);

  if (result.success) {
    // Post final reply
    const postSuccess = await postReplyWithMedia(finalMessage, mention.tweetId);

    if (postSuccess) {
      // ONLY mark as processed after successful reply
      await updateMentionStatus(mention.tweetId, 'complete');
      await markMentionAsProcessed(mention.tweetId);
    } else {
      // Failed to reply - DON'T mark as processed
      await updateMentionStatus(mention.tweetId, 'failed', {
        error_message: 'Failed to post reply'
      });
      // Will retry on restart
    }
  } else {
    // Backend failed - DON'T mark as processed
    await updateMentionStatus(mention.tweetId, 'failed', {
      error_message: result.error
    });
    // Will retry on restart
  }
} catch (error) {
  // Exception - DON'T mark as processed
  await updateMentionStatus(mention.tweetId, 'failed', {
    error_message: error.message
  });
  // Will retry on restart
}
```

#### Startup Recovery Logic
```typescript
async function main() {
  // Load ONLY completed/failed mentions
  // Mentions in 'processing' or 'initiating' will be retried
  const supabaseProcessedMentions = await getAllProcessedMentions(); // Returns status='complete' OR 'failed'

  for (const tweetId of supabaseProcessedMentions) {
    processedMentions.add(tweetId);
  }

  logger.info(`Loaded ${supabaseProcessedMentions.size} completed/failed mentions`);
  logger.info('♻️ Mentions in processing/initiating state will be retried (crash recovery)');

  // Start polling - will automatically pick up any mentions that were interrupted
  await pollMentions();
}
```

#### Supabase Status Tracking
```typescript
// Status lifecycle
'pending'     → Mention detected, not yet started
'initiating'  → Fetching video/space URL, posting ack reply
'processing'  → Backend processing (SpeechLab job)
'complete'    → Final reply posted successfully ✅
'failed'      → Processing failed (will retry on restart) ⚠️

// Query for recovery
async function getAllProcessedMentions(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('mentions')
    .select('tweet_id')
    .in('status', ['complete', 'failed']); // Only these are truly "processed"

  return new Set(data.map(row => row.tweet_id));
}
```

---

### 6. Daemon Reliability & Error Handling

**Challenges:**
- Any uncaught error will crash the entire daemon
- External API calls can fail unexpectedly
- Network timeouts and disconnections
- File system operations can fail
- Must handle errors without losing mention tracking

**Solutions Implemented:**

#### Global Error Handler for main()
```typescript
// Catch any unhandled errors in main execution
main().catch((error) => {
  logger.error('[😈 Daemon] ❌ FATAL: Unhandled error in main():', error);
  logger.error('[😈 Daemon] The daemon has crashed. Please check the logs and restart.');
  process.exit(1);
});
```

#### Try-Catch Wrappers on All Async Functions
```typescript
// Every external call wrapped in try-catch
async function someExternalCall(): Promise<ReturnType | null> {
  try {
    // Actual work
    return result;
  } catch (error) {
    logger.error('Error in someExternalCall:', error);
    return null; // Never throw - return safe value
  }
}
```

#### Worker Loop Protection
```typescript
// Queue workers protected from crashes
setInterval(async () => {
  try {
    await runInitiationQueue();
    await runFinalReplyQueue();
  } catch (error) {
    logger.error('[🚀 Workers] Error in queue worker:', error);
    // Log error but continue - don't crash daemon
  }
}, WORKER_INTERVAL_MS);
```

#### Finally Blocks for Cleanup
```typescript
async function runInitiationQueue(): Promise<void> {
  if (isInitiatingProcessing || mentionQueue.length === 0) return;

  isInitiatingProcessing = true;
  const mentionToProcess = mentionQueue.shift();

  try {
    // ... processing logic ...
  } catch (error) {
    logger.error('Error processing mention:', error);
    // ... error handling ...
  } finally {
    // ALWAYS runs - even if error thrown
    inProgressMentions.delete(mentionToProcess.tweetId);
    isInitiatingProcessing = false;
    logger.info('Finished initiation work');
  }
}
```

#### Safe Promise Resolution (No Rejects)
```typescript
// ❌ BAD - reject can crash daemon if not caught
return new Promise((resolve, reject) => {
  writer.on('error', (error) => {
    reject(false); // Can crash!
  });
});

// ✅ GOOD - always resolve
return new Promise((resolve) => {
  writer.on('error', (error) => {
    logger.error('Write error:', error);
    resolve(false); // Safe
  });

  writer.on('finish', () => {
    resolve(true); // Safe
  });
});
```

#### Graceful Shutdown Handler
```typescript
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  // Clear intervals
  if (mainLoopIntervalId) clearInterval(mainLoopIntervalId);
  if (projectLogIntervalId) clearInterval(projectLogIntervalId);

  // Save state
  logger.info('Saving processed mentions...');
  // ... save to disk ...

  logger.info('Shutdown complete');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

---

## 📋 Prerequisites

Before you begin, ensure you have the following installed and configured:

1.  **Node.js:** Version 20.x or later ([Download](https://nodejs.org/))
2.  **npm:** Usually comes with Node.js
3.  **FFmpeg:** Required for audio/video processing ([Download & Installation](https://ffmpeg.org/download.html))
    ```bash
    # Verify installation
    ffmpeg -version
    ```
4.  **SpeechLab Account:** Get API credentials at [translate.speechlab.ai](https://translate.speechlab.ai/)
5.  **Twitter Developer Account:** For Twitter API v2 access
    - Apply at [developer.twitter.com](https://developer.twitter.com/)
    - Create an app and generate OAuth 1.0a credentials
    - Requires Elevated access for write permissions
6.  **AWS Account:** For S3 storage
    - Create an S3 bucket for public file hosting
    - Configure bucket policy for public read access
    - Generate IAM access keys with S3 permissions
7.  **Supabase Account:** For mention tracking database
    - Create a project at [supabase.com](https://supabase.com/)
    - Create `mentions` table with schema (see Setup section)

---

## 🛠️ Setup & Configuration

### 1. Clone the Repository
```bash
git clone https://github.com/SHAFT-Foundation/speechlab-twitter-spaces-translator.git
cd speechlab-twitter-spaces-translator
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# ============================================
# TWITTER API CREDENTIALS (OAuth 1.0a)
# ============================================
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret
TWITTER_USERNAME=YourBotHandle
TWITTER_BEARER_TOKEN=your_bearer_token

# ============================================
# SPEECHLAB API CREDENTIALS
# ============================================
SPEECHLAB_EMAIL=your@email.com
SPEECHLAB_PASSWORD=your_password

# ============================================
# AWS S3 CONFIGURATION
# ============================================
AWS_S3_BUCKET=speechlab-test-files-public
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key

# ============================================
# SUPABASE CONFIGURATION
# ============================================
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key

# ============================================
# DUBBING CONFIGURATION
# ============================================
SOURCE_LANGUAGE=en          # Default source language
TARGET_LANGUAGE=es_la       # Target language (es_la = Latin American Spanish)
DUB_ACCENT=es_la           # Dubbing accent

# ============================================
# DAEMON CONFIGURATION
# ============================================
POLLING_INTERVAL_MS=120000     # Poll Twitter every 2 minutes
MAX_MENTIONS_PER_POLL=100      # Fetch up to 100 mentions per poll
WORKER_INTERVAL_MS=5000        # Run queue workers every 5 seconds
SKIP_INITIAL_MENTIONS=false    # Skip old mentions on startup

# ============================================
# FEATURE FLAGS
# ============================================
PROCESS_VIDEO_IN_MENTIONS=true    # Enable video processing
ATTACH_VIDEO_TO_REPLY=false       # Attach video inline (experimental)
DOWNLOAD_DUBBED_AUDIO=true        # Download dubbed audio from SpeechLab

# ============================================
# LOGGING
# ============================================
LOG_LEVEL=info    # Options: debug, info, warn, error
```

### 4. Setup Supabase Database

Create the `mentions` table in your Supabase project:

```sql
CREATE TABLE mentions (
  tweet_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  tweet_url TEXT NOT NULL,
  tweet_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'initiating', 'processing', 'complete', 'failed')),
  third_party_id TEXT,
  project_id TEXT,
  m3u8_url TEXT,
  source_language TEXT,
  target_language TEXT,
  sharing_link TEXT,
  public_video_url TEXT,
  public_mp3_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_mentions_status ON mentions(status);
CREATE INDEX idx_mentions_created_at ON mentions(created_at);
CREATE INDEX idx_mentions_third_party_id ON mentions(third_party_id);

-- Enable Row Level Security (optional)
ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;

-- Create policy for service role (full access)
CREATE POLICY "Service role has full access"
  ON mentions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

### 5. Setup AWS S3 Bucket

Configure your S3 bucket for public access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::speechlab-test-files-public/*"
    }
  ]
}
```

### 6. Build the Project
```bash
npm run build
```

---

## ▶️ Running the Daemon

### Development Mode (with hot reload)
```bash
npm run dev
```

### Production Mode
```bash
# Build first
npm run build

# Run daemon
npm run start:daemon
```

### Skip Initial Mentions (on first run)
```bash
SKIP_INITIAL_MENTIONS=true npm run start:daemon
```

### View Logs in Real-Time
```bash
# Using pm2 (recommended for production)
npm install -g pm2
pm2 start npm --name "twitter-daemon" -- run start:daemon
pm2 logs twitter-daemon

# View all running processes
pm2 list

# Restart daemon
pm2 restart twitter-daemon

# Stop daemon
pm2 stop twitter-daemon
```

---

## 🔌 API-Based Architecture

### Twitter API v2 Integration

The daemon uses Twitter API v2 for all operations:

#### Mentions Endpoint
```typescript
GET /2/tweets/search/recent
Query: mention:[botUsername] -from:[botUsername]
Expansions: referenced_tweets.id,author_id
Fields: created_at,text,author_id,referenced_tweets

Rate Limit: 450 requests / 15 min
Returns: Up to 100 tweets per request
```

#### Media Upload (v1.1)
```typescript
POST /1.1/media/upload.json
Body: multipart/form-data with media file

Rate Limit: Shared with v2 tweet creation
Max Size: Images (5MB), Videos (512MB)
```

#### Tweet Creation (v2)
```typescript
POST /2/tweets
Body: {
  text: "Reply text",
  reply: { in_reply_to_tweet_id: "..." },
  media: { media_ids: ["..."] }
}

Rate Limit: 300 tweets / 3 hours
```

### SpeechLab API Integration

#### Authentication
```typescript
POST https://api.speechlab.ai/v1/auth/login
Body: { email, password }
Returns: { token, expiresAt }

Token expires after 24 hours
```

#### Create Dubbing Project
```typescript
POST https://api.speechlab.ai/v1/dubs
Headers: { Authorization: Bearer <token> }
Body: {
  publicAudioUrl: "https://s3.../audio.aac",
  projectName: "Twitter Space - Username",
  targetLanguage: "es_la",
  dubAccent: "es_la",
  thirdPartyID: "unique-identifier",
  sourceLanguage: "en"
}

Returns: { project: { id, status } }
```

#### Check Project Status
```typescript
GET https://api.speechlab.ai/v1/projects?thirdPartyIDs=<id>
Headers: { Authorization: Bearer <token> }

Returns: {
  data: [{
    id: "project-id",
    job: {
      status: "COMPLETE" | "PROCESSING" | "QUEUED" | "FAILED",
      outputs: {
        dubbedAudio: { presignedURL },
        dubbedVideo: { presignedURL }
      }
    }
  }]
}
```

#### Generate Sharing Link
```typescript
POST https://api.speechlab.ai/v1/collaborations/generateSharingLink
Headers: { Authorization: Bearer <token> }
Body: { projectId: "..." }

Returns: { link: "https://translate.speechlab.ai/share/..." }
```

---

## ♻️ Crash Recovery & Resilience

### Automatic Recovery on Restart

When the daemon restarts after a crash:

1. **Load Processed Mentions**
   - Queries Supabase for mentions with `status='complete'` or `status='failed'`
   - These are added to `processedMentions` set
   - All other mentions will be retried

2. **Identify Interrupted Work**
   - Mentions with `status='initiating'` → Will be reprocessed from start
   - Mentions with `status='processing'` → Will check SpeechLab project status
     - If project completed → Post final reply
     - If project still processing → Continue waiting
     - If project failed → Mark as failed

3. **Resume from Last State**
   ```
   Daemon Crashes During Processing
   ↓
   Restart Daemon
   ↓
   Load Supabase: status='complete' (skip) + status='failed' (skip)
   ↓
   Find status='processing' mentions
   ↓
   Check SpeechLab project status
   ↓
   If COMPLETE → Post final reply → Mark complete
   If PROCESSING → Continue waiting
   If FAILED → Mark failed (will retry on next restart)
   ```

### State Tracking Files

#### processed_mentions.json
```json
{
  "mentions": ["1234567890", "0987654321"],
  "projects": {
    "space-title-en-to-es_la-1234567890": {
      "status": "complete",
      "projectId": "speechlab-project-id",
      "mentionIds": ["1234567890"],
      "lastUpdated": "2025-10-23T19:00:00.000Z"
    }
  }
}
```

#### error_log.json
```json
{
  "errors": [
    {
      "mentionId": "1234567890",
      "error": "Failed to download video",
      "stage": "backend",
      "timestamp": "2025-10-23T19:00:00.000Z"
    }
  ]
}
```

### Graceful Shutdown

```bash
# Stop daemon gracefully (Ctrl+C or SIGTERM)
# Daemon will:
# 1. Stop polling for new mentions
# 2. Finish current queue workers
# 3. Save processed_mentions.json
# 4. Log shutdown message
# 5. Exit cleanly
```

---

## ⚙️ Configuration Details

### Polling Configuration

```bash
# How often to check Twitter for new mentions
POLLING_INTERVAL_MS=120000  # 2 minutes (recommended)

# How many mentions to fetch per poll
MAX_MENTIONS_PER_POLL=100   # Max allowed by Twitter API

# How often to run queue workers
WORKER_INTERVAL_MS=5000     # 5 seconds
```

**Recommended Settings:**
- For high-traffic bots: `POLLING_INTERVAL_MS=60000` (1 minute)
- For low-traffic bots: `POLLING_INTERVAL_MS=300000` (5 minutes)
- Always use `MAX_MENTIONS_PER_POLL=100` to maximize valid request detection

### Language Configuration

```bash
# Source language (auto-detected from mention text)
SOURCE_LANGUAGE=en

# Target language
TARGET_LANGUAGE=es_la    # Latin American Spanish
# Other options: es_es (Spain), pt_br (Brazilian Portuguese),
#                fr (French), de (German), zh (Chinese), etc.

# Dubbing accent (matches target language)
DUB_ACCENT=es_la
```

**Supported Language Codes:**
- `en` - English
- `es_la` - Latin American Spanish
- `es_es` - European Spanish
- `pt_br` - Brazilian Portuguese
- `pt` - European Portuguese
- `fr` - French
- `de` - German
- `it` - Italian
- `zh` - Chinese (Mandarin)
- `ja` - Japanese
- `ko` - Korean
- `ar` - Arabic
- `hi` - Hindi
- `ru` - Russian

### Feature Flags

```bash
# Enable/disable video processing
PROCESS_VIDEO_IN_MENTIONS=true

# Attach video inline in reply (experimental, may hit size limits)
ATTACH_VIDEO_TO_REPLY=false

# Download dubbed audio from SpeechLab (needed for public S3 hosting)
DOWNLOAD_DUBBED_AUDIO=true

# Skip mentions older than this on startup (milliseconds)
INITIAL_MENTION_SKIP_AGE_MS=1800000  # 30 minutes
```

---

## 📊 Monitoring & Observability

### Logging

The daemon provides comprehensive logging at multiple levels:

```typescript
[😈 Daemon] Daemon initialization complete
[🐦 Mentions] Polling for new mentions...
[🐦 Mentions] Found 3 new mentions
[🚀 Initiate] Processing mention 1234567890
[🐦 Video Fetch] Fetching video from parent tweet
[⚙️ Backend] Creating SpeechLab project
[🤖 SpeechLab] Poll #1 - Checking project status...
[↩️ Reply Queue] Posting final reply
[📊 Queue Status] Init Queue (0): [], Reply Queue (0): []
```

**Log Levels:**
- `debug` - Detailed execution flow, API payloads, file operations
- `info` - High-level progress, status updates
- `warn` - Non-critical issues, retries, rate limits
- `error` - Failures, exceptions, critical errors

### Queue Status Logging

Every 60 seconds, the daemon logs queue status:

```
📊 Queue Status Report
├─ Init Queue (2): 1234567890, 0987654321
├─ Reply Queue (1): 5555555555
└─ In Progress: 1 mentions currently being processed
```

### Active Projects Logging

Every 5 minutes, logs all active SpeechLab projects:

```
📊 Active Projects:
├─ space-title-en-to-es_la-1234567890
│  └─ Status: processing
│  └─ Project ID: speechlab-abc123
│  └─ Mentions: 1234567890
│  └─ Last Updated: 2 minutes ago
```

### Supabase Dashboard

Monitor all mentions in real-time:

1. Go to Supabase dashboard → Table Editor → mentions
2. Filter by status: `status = 'processing'` to see active jobs
3. Sort by `created_at DESC` to see recent mentions
4. Check `error_message` field for failure details

---

## 🔍 Troubleshooting

### Common Issues

#### 1. Twitter API Rate Limit Errors

**Symptoms:**
```
🚨 RATE LIMIT (429) - Attempt 1/11
📅 Rate limit resets at: 2025-10-23T20:00:00Z (in 14 minutes)
```

**Solutions:**
- ✅ Increase `POLLING_INTERVAL_MS` to reduce request frequency
- ✅ Daemon automatically waits for rate limit reset
- ✅ False 429 errors (with remaining > 0) are automatically ignored
- ✅ Check Twitter API dashboard for usage: [developer.twitter.com](https://developer.twitter.com/)

#### 2. SpeechLab Project Timeout

**Symptoms:**
```
⏰ Poll #120 - Maximum wait time of 60 minutes exceeded
❌ Backend processing failed: Project timed out
```

**Solutions:**
- ✅ Long videos (30+ minutes) may take longer than 1 hour
- ✅ Check SpeechLab dashboard manually: [translate.speechlab.ai](https://translate.speechlab.ai/)
- ✅ Project will complete eventually - mention will retry on next daemon restart
- ✅ Increase timeout in code: `maxWaitTimeMs = 120 * 60 * 1000` (2 hours)

#### 3. Video Download Fails

**Symptoms:**
```
❌ Failed to download video for mention 1234567890
Error: ECONNRESET - Connection reset by peer
```

**Solutions:**
- ✅ Check internet connection and firewall settings
- ✅ Video may be DRM-protected or geo-restricted
- ✅ Daemon automatically retries with exponential backoff (10 retries)
- ✅ Check FFmpeg logs in debug mode: `LOG_LEVEL=debug`

#### 4. S3 Upload Fails

**Symptoms:**
```
❌ S3 upload attempt 3/3 failed
Error: AccessDenied - Access Denied
```

**Solutions:**
- ✅ Verify AWS credentials in `.env`
- ✅ Check IAM user has `s3:PutObject` permission
- ✅ Verify bucket name is correct: `AWS_S3_BUCKET=...`
- ✅ Check bucket policy allows public read access
- ✅ Ensure sufficient disk space for temp files

#### 5. Daemon Crashes on Startup

**Symptoms:**
```
❌ FATAL: Unhandled error in main()
Error: ECONNREFUSED - Connection refused
```

**Solutions:**
- ✅ Check all API credentials are valid
- ✅ Verify Supabase URL and service key
- ✅ Test Twitter API connection: `npm run test:twitter`
- ✅ Check network connectivity to all APIs
- ✅ Review full error stack trace in logs

#### 6. Mentions Not Being Processed

**Symptoms:**
- Daemon running but not detecting new mentions
- Mentions stuck in 'initiating' or 'processing' status

**Solutions:**
- ✅ Check `TWITTER_USERNAME` matches bot account handle (case-sensitive)
- ✅ Verify bot account has Elevated API access (required for write operations)
- ✅ Check Supabase `mentions` table for mention status
- ✅ Review daemon logs for rate limit or API errors
- ✅ Test mention detection: Tweet `@YourBotHandle translate this video to Spanish`

### Debug Mode

Enable detailed logging:

```bash
LOG_LEVEL=debug npm run start:daemon
```

This will show:
- All API request/response payloads
- File operations (read/write/delete)
- Retry attempts and backoff delays
- Queue state changes
- SpeechLab project polling details

### Health Check Endpoint (Coming Soon)

```bash
# Check daemon health
curl http://localhost:3000/health

# Response:
{
  "status": "healthy",
  "uptime": 3600,
  "queues": {
    "initiation": 2,
    "reply": 1
  },
  "processed": 45,
  "errors": 3,
  "lastPoll": "2025-10-23T19:30:00Z"
}
```

---

## 📚 Operations & Documentation

### Comprehensive Documentation

This project includes detailed documentation for all aspects of system operation, monitoring, and troubleshooting:

#### Core Documentation

| Document | Description | Use Case |
|----------|-------------|----------|
| **[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)** | Complete operations manual with monitoring procedures and troubleshooting guides | Daily operations, incident response, system maintenance |
| **[ANALYTICS_SYSTEM.md](ANALYTICS_SYSTEM.md)** | Analytics and engagement tracking documentation | Understanding metrics, generating reports, analyzing performance |
| **[SCHEMA_DOCUMENTATION.md](SCHEMA_DOCUMENTATION.md)** | Database schema reference and migration guide | Database queries, schema updates, data management |

#### Operational Scripts

| Script | Purpose | Command |
|--------|---------|---------|
| `health-check.ts` | System health monitoring | `npx tsx scripts/health-check.ts` |
| `check-recent-mentions.ts` | Recent activity analysis | `npx tsx scripts/check-recent-mentions.ts` |
| `collect-mention-metrics.ts` | Engagement metrics collection | `npx tsx scripts/collect-mention-metrics.ts` |
| `translate-parent-tweets.ts` | Backfill translations | `npx tsx scripts/translate-parent-tweets.ts` |
| `generate-mention-engagement-report.ts` | HTML analytics reports | `npx tsx scripts/generate-mention-engagement-report.ts` |
| `generate-user-report.ts` | User-specific analytics | `npx tsx scripts/generate-user-report.ts MarioNawfal` |

#### Quick Health Check

```bash
# Check system status
npx tsx scripts/health-check.ts

# View recent activity (last 7 days)
npx tsx scripts/check-recent-mentions.ts

# Generate analytics report
npx tsx scripts/generate-mention-engagement-report.ts
```

#### Daily Operations Checklist

1. **Morning Review** (5 minutes)
   ```bash
   npx tsx scripts/health-check.ts
   tail -100 logs/daemon.log
   ```

2. **Weekly Analytics** (30 minutes)
   ```bash
   npx tsx scripts/collect-mention-metrics.ts
   npx tsx scripts/generate-mention-engagement-report.ts
   open reports/mention-engagement-report.html
   ```

3. **Monthly Maintenance** (1-2 hours)
   - Review [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) maintenance tasks
   - Database cleanup and optimization
   - API cost review
   - Archive old reports

### Key Operational Features

- **Automatic Translation:** All new mentions have parent tweets translated to target language
- **Engagement Tracking:** Views, likes, retweets, replies tracked for mentions and parent tweets
- **Analytics Reports:** HTML reports comparing dub performance to other comments
- **Health Monitoring:** Automated health checks with recommendations
- **Crash Recovery:** Automatic retry of interrupted mentions on daemon restart
- **Rate Limit Handling:** Intelligent backoff and retry for API limits

### Getting Help

For operational issues:
1. Check [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) for common issues
2. Run `npx tsx scripts/health-check.ts` for system diagnostics
3. Review logs in `logs/daemon.log`
4. Check database status in Supabase dashboard
5. Open an issue on GitHub with logs and health check output

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes with tests
4. Commit with clear messages: `git commit -m 'Add amazing feature'`
5. Push to your fork: `git push origin feature/amazing-feature`
6. Open a Pull Request

---

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [SpeechLab AI](https://translate.speechlab.ai/) for providing the dubbing API
- [Twitter API v2](https://developer.twitter.com/en/docs/twitter-api) for mention monitoring
- [Supabase](https://supabase.com/) for database infrastructure
- [FFmpeg](https://ffmpeg.org/) for audio/video processing

---

**Made with ❤️ by the SHAFT Foundation**

For questions or support, please open an issue on GitHub or contact us at support@shaftfinance.com
