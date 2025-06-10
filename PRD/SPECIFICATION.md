# AI Agent: Twitter Space Scraper, Dubber, Transcriber, and Poster

## 1. Overview

This document specifies the requirements for a Node.js TypeScript AI agent with two primary modes of operation:

1.  **Batch Processing Mode:** Scrapes top Twitter profiles from SpacesDashboard, identifies recent recorded Twitter Spaces, extracts audio, dubs it using SpeechLab, and posts the dubbed version back to the original Space tweet.
2.  **Mention Monitoring Daemon Mode:** Continuously monitors the agent's Twitter account mentions. If a mention contains a valid Twitter Space link, it intelligently detects whether the user wants dubbing or transcription, triggers the appropriate workflow, and replies to the mentioning user with either the dubbed link or summary.

## Workflow Overview

### Batch Processing (Default)

1.  **Python Scraper Utility (`scraper_utility/`):** Uses Playwright to scrape the SpacesDashboard leaderboard. Extracts structured data (Space Title, Host Profile URL, Direct Space URL) for each entry and saves it to `leaderboard_data_playwright.json`.
2.  **Node.js Dubbing Agent (`src/`):** Reads the `leaderboard_data_playwright.json` file. For each entry, it performs the dubbing workflow (Phases 2-7): finds the specific tweet, downloads/uploads audio, submits to SpeechLab, monitors processing, gets the sharing link, and posts the link back to the original Space tweet.

### Mention Monitoring Daemon

1.  **Node.js Daemon (`src/mentionDaemon.ts`):** Runs as a background process.
2.  **Mention Detection (Phase 8):** Periodically uses Playwright to check the agent's Twitter notifications/mentions page.
3.  **Intelligent Request Parsing:** For new mentions, extracts the tweet text and automatically detects whether the user wants:
    - **Dubbing**: Based on language keywords ("translate to Spanish", "dub in French")
    - **Transcription**: Based on transcription keywords ("summarize", "transcribe", "what was said")
4.  **Dual Workflow Routing:** Routes requests to either:
    - **Dubbing Workflow**: Phases 2-7 (existing functionality)
    - **Transcription Workflow**: Phases 2A-7A (new functionality)
5.  **Reply to Mention:** Posts either the generated SpeechLab sharing link (dubbing) or AI-generated summary (transcription) as a reply to the *mentioning* tweet.

## 2. Functional Requirements

### Phase 1: Scrape Leaderboard Data (Python Utility - `scraper_utility/scrape_leaderboard_playwright.py`)

*   **Goal:** Extract structured data for leaderboard entries and save to a file.
*   **Tool:** Python script using Playwright or `nova-act` library.
*   **Input:** SpacesDashboard Leaderboard URL (`https://spacesdashboard.com/leaderboard?lang=en&mode=7d`).
*   **Method:**
    *   Launch browser targeting the leaderboard URL.
    *   Identify distinct leaderboard entries.
    *   Extract `space_title`, `host_handle`, `host_name`, `listener_count`, and `direct_play_url` from PLAY button link.
    *   Handle potential scrolling to load more entries.
    *   Deduplicate entries based on `direct_play_url`.
*   **Output:** Creates/overwrites `leaderboard_data_playwright.json` in the project root, containing an array of objects:
    ```json
    [
      {
        "space_title": "Example Space Title",
        "host_handle": "@exampleHost",
        "host_name": "Example Host Name",
        "listener_count": 12345,
        "direct_play_url": "https://x.com/i/spaces/12345example"
      },
      // ... more entries
    ]
    ```
*   **Execution:** Run manually via `python scraper_utility/scrape_leaderboard_playwright.py --headless=False` after setting up the Python environment.

### Phase 2: Find Recorded Space & Extract Audio URL (Node.js Agent - Dubbing Workflow)

*   **Goal:** Extract the `.m3u8` audio stream URL for a given recorded Twitter Space.
*   **Input:** A `LeaderboardEntry` object (read from `leaderboard_data_playwright.json`), specifically the `directSpaceUrl`.
*   **Service:** `twitterInteractionService.ts`
*   **Method:**
    *   Use Playwright to navigate directly to the `directSpaceUrl`.
    *   Identify the element indicating a recorded space (e.g., "Play recording" button).
    *   Simulate clicking the "Play recording" button.
    *   Intercept network requests to capture the `*.pscp.tv/.../playlist_*.m3u8` URL.
    *   Also attempt to extract the original tweet URL from the page for later reply posting.
*   **Key Function:** `getM3u8ForSpacePage(directSpaceUrl)`
*   **Output:** `{ m3u8Url: string, originalTweetUrl: string|null }` or null if failed.
*   **Logging:** `[🐦 Twitter]` prefixed log messages.

### Phase 2A: Find Recorded Space & Extract Audio URL (Node.js Agent - Transcription Workflow)

*   **Goal:** Extract the `.m3u8` audio stream URL for transcription and summarization.
*   **Input:** Twitter Space URL from mention text.
*   **Service:** `twitterInteractionService.ts` (reused functions)
*   **Method:** Same as Phase 2, but optimized for transcription workflow.
*   **Key Function:** `initiateTranscriptionProcessing(mentionInfo, page)`
*   **Output:** Audio file information for transcription processing.
*   **Logging:** `[📝 Transcription Initiate]` prefixed log messages.

### Phase 3: Download, Convert, and Host Audio

*   **Goal:** Download audio from the `.m3u8` URL and upload it to a public AWS S3 bucket.
*   **Input:** The `.m3u8` URL and space name (for filename).
*   **Service:** `audioService.ts`
*   **Method:**
    *   Use `ffmpeg` to download and save the stream as a single file (e.g., `.aac` or `.mp3`).
    *   Use the AWS SDK for JavaScript v3 to upload the audio to S3.
    *   Configure the upload with `public-read` ACL.
    *   Use a temporary directory to store audio files, with cleanup.
*   **Key Function:** `downloadAndUploadAudio(m3u8Url, spaceName)`
*   **Output:** The public URL of the hosted audio file on S3.
*   **Logging:** `[🎧 Audio]` prefixed log messages for download progress, conversion status, and upload completion.
*   **Note:** This phase is shared between dubbing and transcription workflows.

### Phase 4: Dub Audio using SpeechLab API (Dubbing Workflow)

*   **Goal:** Submit the hosted audio file to the SpeechLab API for dubbing.
*   **Input:** Public S3 URL, Space Name
*   **Service:** `speechlabApiService.ts`
*   **Method:**
    *   Get authentication token via `getAuthToken()` using credentials from `.env`.
    *   Construct project name and thirdPartyID from the space name.
    *   Submit a POST request to create a dubbing project:
        *   Endpoint: `POST /v1/projects/createProjectAndDub`
        *   Parameters: name, sourceLanguage, targetLanguage, dubAccent, unitType, mediaFileURI, voiceMatchingMode, thirdPartyID.
*   **Key Function:** `createDubbingProject(publicAudioUrl, spaceName)`
*   **Output:** SpeechLab `projectId`
*   **Logging:** `[🤖 SpeechLab]` prefixed logs for API requests, responses, and errors.

### Phase 4A: Transcribe Audio using SpeechLab API (Transcription Workflow)

*   **Goal:** Submit the hosted audio file to the SpeechLab API for transcription.
*   **Input:** File UUID, File Key, Space Name, Content Duration
*   **Service:** `speechlabApiService.ts` (enhanced with transcription functions)
*   **Method:**
    *   Get authentication token via `getAuthToken()` using credentials from `.env`.
    *   Submit a POST request to create a transcription project:
        *   Endpoint: `POST /v1/projects/createProjectAndDub`
        *   Parameters: fileUuid, fileKey, name, filenameToReturn, language, contentDuration, thumbnail.
*   **Key Function:** `createDubbingProject(request)`
*   **Output:** SpeechLab transcription `projectId`
*   **Logging:** `[🤖 SpeechLab]` prefixed logs for transcription API requests.

### Phase 5: Monitor Project Processing Status (Both Workflows)

*   **Goal:** Wait for the SpeechLab project to complete processing.
*   **Input:** The thirdPartyID used when creating the project.
*   **Service:** `speechlabApiService.ts`
*   **Method:**
    *   Poll the API at regular intervals (default 30 seconds) to check project status.
    *   Look up project by thirdPartyID using the `getProjectByThirdPartyID` function.
    *   Extract status (PROCESSING, COMPLETE, FAILED) and progress percentage.
    *   Continue polling until status is COMPLETE, FAILED, or maximum wait time is reached.
    *   For debugging, log project details and write detailed diagnostic files.
*   **Key Functions:** 
    *   `waitForProjectCompletion(thirdPartyID, maxWaitTimeMs)` (dubbing and transcript summary)
    *   `getProjectByThirdPartyID(thirdPartyID)`
*   **Output:** Boolean indicating whether project completed successfully.
*   **Logging:** Detailed progress logs with current status, estimated time remaining, and poll count.

### Phase 5A: Extract Transcription and Generate Summary (Transcription Workflow)

*   **Goal:** Extract transcription text and generate AI summary using OpenAI GPT.
*   **Input:** Completed transcription project details.
*   **Service:** `openaiService.ts`, `transcriptionSummarizationService.ts`
*   **Method:**
    *   Extract `transcriptionText` from the completed SpeechLab project.
    *   Send transcription text to OpenAI GPT with summarization prompt:
        ```
        Given this text <transcriptionText> I'd like to give a detailed summary of this twitter space... 
        we can leave out the speakers though and just summarize the entire space...
        ```
    *   Process and format the generated summary.
*   **Key Functions:**
    *   `summarizeTwitterSpace(transcriptionText)`
    *   `transcribeAndSummarize(transcriptionRequest)`
*   **Output:** Formatted summary text ready for Twitter reply.
*   **Logging:** `[🤖 OpenAI]` prefixed logs for summarization requests.

### Phase 6: Get SpeechLab Sharing Link (Dubbing Workflow)

*   **Goal:** Obtain the public sharing link for the completed dubbing project.
*   **Input:** SpeechLab `projectId`
*   **Service:** `speechlabApiService.ts`
*   **Method:**
    *   Get authentication token.
    *   POST request to generate a sharing link:
        *   Endpoint: `/v1/collaborations/generateSharingLink`
        *   Request Body: `{"projectId": "PROJECT_ID_FROM_PHASE_4"}`
    *   Extract the `link` field from the response.
*   **Key Function:** `generateSharingLink(projectId)`
*   **Output:** Sharing link URL string
*   **Logging:** `[🤖 SpeechLab]` prefixed logs for link generation progress.

### Phase 7: Post Comment to Twitter (Dubbing Workflow)

*   **Goal:** Post the SpeechLab sharing link as a reply to the original Twitter Space tweet.
*   **Input:** Original Tweet URL, SpeechLab Sharing Link, (MP3 Link Optional)
*   **Service:** `twitterInteractionService.ts`
*   **Method:**
    *   Use several approaches to find a suitable tweet to reply to:
        *   Use the original tweet URL if found in Phase 2
        *   Look for tweets on the host's profile that reference this Space
        *   Find any Space-related tweet on the host's profile
        *   Find any tweet embedding the Space
    *   Generate comment text including the sharing link (and MP3 link if available, MP3 first) and attribution.
    *   Use Playwright (default) or Twitter API v2 (if configured via `USE_TWITTER_API_FOR_REPLY=true`) to post the reply.
*   **Key Functions:** 
    *   `postReplyToTweet(tweetUrl, commentText)`
    *   `findSpaceTweetFromProfile(hostUsername, spaceId)`
    *   `findTweetEmbeddingSpace(spaceUrl)`
*   **Output:** Boolean indicating success/failure of posting
*   **Logging:** `[🐦 Twitter]` prefixed logs for tweet finding and reply posting.

### Phase 7A: Post Summary to Twitter (Transcription Workflow)

*   **Goal:** Post the AI-generated summary as a reply to the mentioning tweet.
*   **Input:** Mention Tweet URL, Generated Summary Text
*   **Service:** `twitterInteractionService.ts` (reused functions)
*   **Method:**
    *   Format summary text for Twitter (truncate if necessary to fit character limits).
    *   Construct reply message: `@username Here's your Twitter Space summary! 📝\n\n[summary]`
    *   Use Playwright or Twitter API v2 to post the reply to the original mention.
*   **Key Function:** `postReplyToTweet(tweetUrl, summaryText)`
*   **Output:** Boolean indicating success/failure of posting
*   **Logging:** `[📝 Transcription]` prefixed logs for summary posting.

### Phase 8: Mention Monitoring & Processing (Daemon Mode)

*   **Goal:** Monitor the agent's Twitter mentions for Space processing requests and intelligently route them.
*   **Trigger:** A new, unhandled mention of the agent's Twitter account (`@SpeechlabAgent`).
*   **Service:** `twitterInteractionService.ts`, `mentionDaemon.ts`.
*   **Method:**
    *   **Daemon Startup:** A new entry point/command (e.g., `npm run start:daemon`) launches the daemon.
    *   **Login:** Daemon logs into the agent's Twitter account (`TWITTER_USERNAME` from `.env`).
    *   **Polling:** Periodically (e.g., every 10 minutes):
        *   Navigate to the Twitter Notifications page (`https://x.com/notifications`) briefly, then to the Mentions page (`https://twitter.com/notifications/mentions`).
        *   Scrape recent mentions (tweet ID, username [including @], text).
        *   Identify new mentions not previously processed (using `processed_mentions.json`).
    *   **Intelligent Request Detection:** For each new mention:
        *   **Analyze mention text** using `isTranscriptionRequest()` function to detect keywords:
            *   **Transcription keywords**: "summarize", "summary", "transcribe", "transcript", "what was said", "recap", "overview"
            *   **Dubbing keywords**: Language names, "translate", "dub", "convert"
        *   **Route to appropriate workflow**:
            *   **Transcription**: `initiateTranscriptionProcessing()` → `performTranscriptionBackendProcessing()`
            *   **Dubbing**: `initiateProcessing()` → `performBackendProcessing()` (original)
    *   **Workflow Execution:**
        *   Extract Space URL from mention text.
        *   Execute the appropriate workflow (Phases 2-7 for dubbing, Phases 2A-7A for transcription).
        *   **Post Reply:** Reply to the original mention with either dubbed links or summary.
        *   **Mark as Processed:** Add the `mentionTweetId` to `processed_mentions.json` after successful reply.
    *   **Error Handling:** Post specific error replies to users if processing fails.
*   **Key Functions (New/Enhanced):**
    *   `monitorMentions()` (in `mentionDaemon.ts`)
    *   `scrapeMentions()` (in `twitterInteractionService.ts`)
    *   `isTranscriptionRequest(text)` (new detection function)
    *   `initiateTranscriptionProcessing()` (new transcription workflow)
    *   `performTranscriptionBackendProcessing()` (new backend processing)
*   **Output:** Either dubbed Space link or AI summary posted as a reply to the user who mentioned the agent.
*   **Logging:** `[🔔 Mention]`, `[😈 Daemon]`, `[📝 Transcription]` prefixed log messages.

## 3. Agent Orchestration

### Default Mode (`src/main.ts` - `npm start` or `npm run dev`)

1.  **Initialization:** Agent starts.
2.  **Load Leaderboard Data:** Reads `leaderboard_data_playwright.json`.
3.  **Iterate Entries:** Loops through entries, calling `agent.processLeaderboardEntry(entry)` (Phases 2-7).
4.  **Completion:** Logs agent run completion.

### Mention Daemon Mode (`src/mentionDaemon.ts` - `npm run start:daemon`)

1.  **Initialization:** Daemon starts.
2.  **Load Processed Mentions:** Reads `processed_mentions.json` into memory.
3.  **Start Monitoring Loop:** Begins polling Twitter mentions (Phase 8).
    *   Detects new mentions.
    *   Analyzes mention text for request type (transcription vs. dubbing).
    *   Routes to appropriate workflow:
        *   **Transcription**: Phases 2A, 3, 4A, 5, 5A, 7A
        *   **Dubbing**: Phases 2, 3, 4, 5, 6, 7
    *   Posts reply to the mentioning user.
    *   Updates `processed_mentions.json`.
4.  **Continuous Operation:** Runs indefinitely until stopped.

## 4. Project Structure (Updated)

```
.
├── PRD/
│   └── SPECIFICATION.md
├── scraper_utility/          <-- Python Scraper
│   ├── requirements.txt
│   └── scrape_leaderboard_playwright.py
├── src/
│   ├── agents/
│   │   └── TwitterSpaceDubbingAgent.ts
│   ├── services/
│   │   ├── twitterInteractionService.ts
│   │   ├── audioService.ts
│   │   ├── speechlabApiService.ts      <-- Enhanced with transcription functions
│   │   ├── openaiService.ts            <-- NEW: OpenAI integration
│   │   ├── transcriptionSummarizationService.ts  <-- NEW: Transcription orchestration
│   │   └── scraperService.ts
│   ├── utils/
│   │   ├── config.ts                   <-- Enhanced with OPENAI_API_KEY
│   │   └── logger.ts
│   ├── types/
│   ├── main.ts                         <-- Entry point for Batch Mode
│   ├── mentionDaemon.ts                <-- Enhanced with dual workflow routing
│   ├── test-transcription-summarization.ts     <-- NEW: Transcription test
│   └── test-transcription-integration.ts       <-- NEW: Integration test
├── tests/
├── leaderboard_data_playwright.json
├── processed_mentions.json             <-- Tracks processed mentions
├── TRANSCRIPTION_INTEGRATION.md        <-- NEW: Integration documentation
├── TRANSCRIPTION_SUMMARIZATION.md      <-- NEW: Transcription documentation
├── .env                                <-- Enhanced with OPENAI_API_KEY
├── .gitignore
├── package.json                        <-- Enhanced with new test scripts
└── tsconfig.json
```

## 5. Configuration Requirements

### Required Environment Variables

*   **SpeechLab**: `SPEECHLAB_EMAIL`, `SPEECHLAB_PASSWORD`
*   **OpenAI**: `OPENAI_API_KEY` (new requirement for transcription/summarization)
*   **AWS**: `AWS_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
*   **Twitter**: `TWITTER_USERNAME`, `TWITTER_PASSWORD` (for daemon mode)

### Optional Configuration

*   Source Language: `en` (by default, can be inferred from Space if needed)
*   Target Language: Determined from mention text (e.g., `dub in spanish`). `es` is mapped to `es_LA` for SpeechLab.
*   Audio Hosting: AWS S3, bucket `speechlab-test-files-public`, using env credentials.
*   Sharing Link API: `POST /v1/collaborations/generateSharingLink`, link is in `link` field.
*   Twitter Interaction: Browser automation via Playwright (`USE_TWITTER_API_FOR_REPLY=false`) or Twitter API v2 (`USE_TWITTER_API_FOR_REPLY=true`).
*   Logging: Detailed, structured, with icons and prefixes. Full reply text logged.
*   Voice Matching: `source`.
*   Configuration: `BROWSER_HEADLESS` environment variable respected by daemon.

## 6. Testing & Validation

### Available Test Scripts

1. **Transcription End-to-End Test**: `npm run test:transcription`
   - Tests SpeechLab transcription API and OpenAI summarization workflow
   - Validates the complete transcription pipeline

2. **Integration Test**: `npm run test:transcription-integration`
   - Verifies keyword detection logic (`isTranscriptionRequest()`)
   - Tests service imports and workflow routing
   - Validates dual workflow integration

3. **Existing Tests**: M3U8 extraction, profile search, reply posting (unchanged)

### Usage Examples

#### Transcription Requests
```
@DubbingAgent please summarize this space
@DubbingAgent can you transcribe this?
@DubbingAgent what was said in this Twitter Space?
@DubbingAgent give me a summary of this
@DubbingAgent recap this space
```

#### Dubbing Requests
```
@DubbingAgent translate this to Spanish
@DubbingAgent dub this space in French
@DubbingAgent convert to German
```

## 7. Error Handling and Diagnostics

The system incorporates comprehensive error handling and diagnostic features for both workflows:

1. **Detailed Logging:** Each phase has unique log prefixes and icons for clear identification:
   - `[🎭 Dubbing]` for dubbing workflow
   - `[📝 Transcription]` for transcription workflow
   - `[🤖 OpenAI]` for OpenAI API interactions

2. **Debug Files:** Writes API responses, errors, and diagnostic information to files:
   - `temp_api_response.json`: Full API response from SpeechLab
   - `project_not_found.json`: Details when no projects are found for a thirdPartyID
   - `api_error.json`: Error details for troubleshooting
   - `third_party_id.txt`: The thirdPartyID used for the current project

3. **Graceful Degradation:** If any phase fails, the agent logs the error and posts appropriate error messages to users.

4. **Intelligent Error Messages:** Different error messages for transcription vs. dubbing failures:
   - Transcription: "Couldn't complete the transcription and summary for this Space"
   - Dubbing: "Couldn't complete the [source] to [target] dub for this Space"

5. **Retries and Polling:** For time-sensitive operations, both workflows implement polling with configurable parameters.

6. **Shared Infrastructure:** Both workflows leverage the same reliable audio processing, error handling, and queue management systems.

**Note:** As of June 2025, all transcription and summarization requests use the SpeechLab `createProjectAndDub` API. The `createProjectAndTranscribe` API and all related functions are deprecated and must not be used. The dubbing API is used for both dubbing and transcript summary requests. 