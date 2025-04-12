# AI Agent: Twitter Space Scraper, Dubber, and Poster

## 1. Overview

This document specifies the requirements for a Node.js TypeScript AI agent with two primary modes of operation:

1.  **Batch Processing Mode:** Scrapes top Twitter profiles from SpacesDashboard, identifies recent recorded Twitter Spaces, extracts audio, dubs it using SpeechLab, and posts the dubbed version back to the original Space tweet.
2.  **Mention Monitoring Daemon Mode:** Continuously monitors the agent's Twitter account mentions. If a mention contains a valid Twitter Space link, it triggers the dubbing workflow and replies to the mentioning user with the dubbed link.

## Workflow Overview

### Batch Processing (Default)

1.  **Python Scraper Utility (`scraper_utility/`):** Uses Playwright to scrape the SpacesDashboard leaderboard. Extracts structured data (Space Title, Host Profile URL, Direct Space URL) for each entry and saves it to `leaderboard_data_playwright.json`.
2.  **Node.js Dubbing Agent (`src/`):** Reads the `leaderboard_data_playwright.json` file. For each entry, it performs the dubbing workflow (Phases 2-7): finds the specific tweet, downloads/uploads audio, submits to SpeechLab, monitors processing, gets the sharing link, and posts the link back to the original Space tweet.

### Mention Monitoring Daemon

1.  **Node.js Daemon (`src/mentionDaemon.ts`):** Runs as a background process.
2.  **Mention Detection (Phase 8):** Periodically uses Playwright to check the agent's Twitter notifications/mentions page.
3.  **Request Parsing:** For new mentions, extracts the tweet text and looks for a Twitter Space URL (`https://twitter.com/i/spaces/...`).
4.  **MCP Integration:** Sends the extracted text/URL to a designated MCP server endpoint for validation and processing instructions (details TBD).
5.  **Trigger Dubbing:** If the MCP server confirms, initiates the dubbing workflow (Phases 2-7, potentially adapted) using the Space URL from the mention.
6.  **Reply to Mention:** Posts the generated SpeechLab sharing link as a reply to the *mentioning* tweet.

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

### Phase 2: Find Recorded Space & Extract Audio URL (Node.js Agent)

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

### Phase 4: Dub Audio using SpeechLab API

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

### Phase 5: Monitor Project Processing Status

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
    *   `waitForProjectCompletion(thirdPartyID, maxWaitTimeMs, checkIntervalMs)`
    *   `getProjectByThirdPartyID(thirdPartyID)`
*   **Output:** Boolean indicating whether project completed successfully.
*   **Logging:** Detailed progress logs with current status, estimated time remaining, and poll count.

### Phase 6: Get SpeechLab Sharing Link

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

### Phase 7: Post Comment to Twitter

*   **Goal:** Post the SpeechLab sharing link as a reply to the original Twitter Space tweet.
*   **Input:** Original Tweet URL, SpeechLab Sharing Link
*   **Service:** `twitterInteractionService.ts`
*   **Method:**
    *   Use several approaches to find a suitable tweet to reply to:
        *   Use the original tweet URL if found in Phase 2
        *   Look for tweets on the host's profile that reference this Space
        *   Find any Space-related tweet on the host's profile
        *   Find any tweet embedding the Space
    *   Generate comment text including the timestamp, sharing link, and attribution.
    *   Use Playwright to navigate to the tweet URL and post a reply.
*   **Key Functions:** 
    *   `postReplyToTweet(tweetUrl, commentText)`
    *   `findSpaceTweetFromProfile(hostUsername, spaceId)`
    *   `findTweetEmbeddingSpace(spaceUrl)`
*   **Output:** Boolean indicating success/failure of posting
*   **Logging:** `[🐦 Twitter]` prefixed logs for tweet finding and reply posting.

### Phase 8: Mention Monitoring & Processing (Daemon Mode)

*   **Goal:** Monitor the agent's Twitter mentions for Space dubbing requests and process them.
*   **Trigger:** A new, unhandled mention of the agent's Twitter account (`@SpeechlabAgent`).
*   **Service:** `twitterInteractionService.ts` (new functions needed), `mentionDaemon.ts` (new file/agent).
*   **Method:**
    *   **Daemon Startup:** A new entry point/command (e.g., `npm run start:daemon`) launches the daemon.
    *   **Login:** Daemon logs into the agent's Twitter account (`TWITTER_USERNAME` from `.env`).
    *   **Polling:** Periodically (e.g., every 60 seconds):
        *   Navigate to the Twitter Mentions page (`https://twitter.com/notifications/mentions`).
        *   Scrape recent mentions (tweet ID, username, text).
        *   Identify new mentions not previously processed (using a simple file like `processed_mentions.json` to track IDs).
    *   **Space URL Extraction:** For each new mention:
        *   Search the tweet text for a pattern matching `https://twitter.com/i/spaces/[a-zA-Z0-9]+`.
        *   If a valid Space URL is found:
            *   **MCP Call (Placeholder):** Send the mention text/URL to an MCP endpoint (to be defined) for logging/validation. This step is currently conceptual.
            *   **Trigger Dubbing Workflow:**
                *   Extract necessary info: `directSpaceUrl` from the mention, potentially extract the mentioning user's handle for the reply.
                *   *Reuse/Adapt:* Call existing service functions (Phases 2-7), potentially wrapping them in a new function `processMentionRequest(mentionTweetId, mentionUsername, spaceUrl)`.
                *   **Important:** The output `sharingLink` needs to be associated with the original `mentionTweetId`.
            *   **Post Reply (Phase 7 adaptation):**
                *   Use `postReplyToTweet` function.
                *   **Target:** Reply to the `mentionTweetId`.
                *   **Text:** Format a reply tagging the `mentionUsername`, indicating success, and providing the `sharingLink`. Example: `"Hey @mentionUsername, here's the dubbed version of the Space you shared! Contact for more languages! <LINK>"`
            *   **Mark as Processed:** Add the `mentionTweetId` to `processed_mentions.json`.
    *   **Error Handling:** Log errors during scraping, processing, or posting replies. Continue monitoring.
*   **Key Functions (New/Adapted):**
    *   `monitorMentions()` (in `mentionDaemon.ts`)
    *   `scrapeMentions()` (in `twitterInteractionService.ts`)
    *   `extractSpaceUrlFromMention(text)` (utility function)
    *   `processMentionRequest(mentionTweetId, mentionUsername, spaceUrl)` (in `mentionDaemon.ts` or a new service)
    *   `postReplyToTweet(tweetUrl, commentText)` (existing, used with different target/text)
*   **Output:** Dubbed Space link posted as a reply to the user who mentioned the agent.
*   **Logging:** `[🔔 Mention]` or `[😈 Daemon]` prefixed log messages.

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
    *   Extracts Space URLs.
    *   Calls MCP (placeholder).
    *   Triggers the dubbing workflow (adapted Phases 2-7).
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
│   │   ├── speechlabApiService.ts
│   │   └── scraperService.ts
│   ├── utils/
│   │   ├── config.ts
│   │   └── logger.ts
│   ├── types/
│   ├── main.ts                 <-- Entry point for Batch Mode
│   └── mentionDaemon.ts        <-- NEW: Entry point for Daemon Mode
├── tests/
├── leaderboard_data_playwright.json
├── processed_mentions.json   <-- NEW: Tracks processed mentions
├── .env
├── .gitignore
├── package.json
└── tsconfig.json
```

## 5. Open Questions Addressed

*   Source Language: `en`
*   Audio Hosting: AWS S3, bucket `speechlab-test-files-public`, using env credentials.
*   Sharing Link API: `POST /v1/collaborations/generateSharingLink`, link is in `link` field.
*   Twitter Interaction: Browser automation via Playwright.
*   Logging: Detailed, structured, with icons and prefixes.
*   Voice Matching: `source`.

## 6. Error Handling and Diagnostics

The system incorporates comprehensive error handling and diagnostic features:

1. **Detailed Logging:** Each phase has unique log prefixes and icons for clear identification.
2. **Debug Files:** Writes API responses, errors, and diagnostic information to files:
   - `temp_api_response.json`: Full API response from SpeechLab
   - `project_not_found.json`: Details when no projects are found for a thirdPartyID
   - `api_error.json`: Error details for troubleshooting
   - `third_party_id.txt`: The thirdPartyID used for the current project

3. **Graceful Degradation:** If any phase fails, the agent logs the error and moves to the next entry rather than crashing.
4. **Retries and Polling:** For time-sensitive operations, the agent implements polling with configurable parameters.
5. **Multiple Approaches:** For tweet finding, implements multiple fallback approaches if the primary method fails. 