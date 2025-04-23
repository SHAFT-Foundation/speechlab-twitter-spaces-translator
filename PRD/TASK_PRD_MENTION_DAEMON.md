# Task PRD: Mention Monitoring Daemon Implementation

This document outlines the tasks required to implement the Twitter Mention Monitoring Daemon feature as specified in `PRD/SPECIFICATION.md`.

## Task List

1.  **Create Daemon Entry Point:**
    *   [x] Create `src/mentionDaemon.ts`.
    *   [x] Set up basic daemon structure (main loop, init, browser task loop, queues).
    *   [x] Add `start:daemon` script to `package.json`.

2.  **Implement Mention Scraping (`twitterInteractionService.ts`):**
    *   [x] Add `scrapeMentions` function.
    *   [x] Implement Playwright login logic for the agent account (using saved state/cookies or manual).
    *   [x] Implement navigation: Visit **Notifications page** first, then Mentions page.
    *   [x] Implement selectors and logic to extract mention data (tweet ID, username [with @], text).
    *   [x] Return structured mention data.

3.  **Implement Mention Processing Logic (`mentionDaemon.ts`):**
    *   [x] Implement reading/writing to `processed_mentions.json` (create if not exists).
    *   [x] Set up `setInterval` polling loop calling `scrapeMentions`.
    *   [x] Implement logic to filter out already processed mentions (using `Set` in memory).
    *   [x] Add detailed logging for the processed mention check.
    *   [x] Implement `detectLanguage` utility (`languageUtils.ts`) with alias/pattern matching.
    *   [x] Add mapping for `es` -> `es_LA` in `detectLanguage`.
    *   [x] Implement `extractSpaceUrl` utility (`twitterInteractionService.ts`).
    *   [x] Call URL extraction for new mentions.

4.  **Integrate Dubbing Workflow:**
    *   [x] Create `initiateProcessing` function (in `mentionDaemon.ts`) for browser-dependent steps.
    *   [x] Implement robust Play button finding logic (`findArticleWithPlayButton`) using `getByRole` and fallbacks.
    *   [x] Adapt/Call `twitterInteractionService.clickPlayButtonAndCaptureM3u8`.
    *   [x] Implement title extraction attempts (aria-label, tweet text, modal).
    *   [x] Create `performBackendProcessing` function (in `mentionDaemon.ts`) for non-browser steps.
    *   [x] Call `audioService.downloadAndUploadAudio`.
    *   [x] Call `speechlabApiService.createDubbingProject` (using potentially extracted/fallback title and mapped language code).
    *   [x] Call `speechlabApiService.waitForProjectCompletion`.
    *   [x] Call `speechlabApiService.generateSharingLink`.
    *   [x] Implement robust error handling for the entire workflow, including specific error replies.

5.  **Implement Reply Posting (`twitterInteractionService.ts`, `twitterApiService.ts`, `mentionDaemon.ts`):**
    *   [x] Adapt `postReplyToTweet` (Playwright) and `postTweetReplyWithMediaApi` (API) as needed.
    *   [x] Implement logic in `runFinalReplyQueue` to construct a **single combined reply**.
    *   [x] Format reply: `Username Language dub is ready! 🎉 MP3: <link> | Link: <link>` (MP3 first, if available).
    *   [x] Ensure no duplicate `@` in username tag.
    *   [x] Call appropriate posting function from `runFinalReplyQueue` upon success/failure.
    *   [x] **Update:** Mark mention as processed in `processed_mentions.json` only *after* successful final reply posting.

6.  **Add Logging:**
    *   [x] Add `[🔔 Mention]` / `[😈 Daemon]` / `[🚀 Initiate]` / `[⚙️ Backend]` / `[↩️ Reply Queue]` prefixes.
    *   [x] Ensure logging in modified/new service functions follows existing patterns.
    *   [x] Add logging for full reply text content (both attempts and failures).
    *   [x] Add detailed logging for mention checking and Play button/title finding.

7.  **Environment Variables & Configuration:**
    *   [x] Verify `TWITTER_USERNAME`, `TWITTER_PASSWORD`, API keys, S3 creds are loaded via `config.ts`.
    *   [x] Add `USE_TWITTER_API_FOR_REPLY` boolean config option.
    *   [x] Ensure `BROWSER_HEADLESS` config option is respected.
    *   [x] Document necessary environment variables.
    *   [x] Add configurable polling interval (default 10 mins).

8.  **Testing:**
    *   [x] Manual test: Mention agent with a valid Space link.
    *   [x] Verify end-to-end flow (scrape -> dub -> reply format).
    *   [x] Test error handling (invalid mention, API failure, Space not found, M3U8 fail, link gen fail).
    *   [x] Verify `processed_mentions.json` updates correctly (only after success).
    *   [ ] Test with `es` language request to verify `es_LA` mapping.
    *   [ ] Test with `USE_TWITTER_API_FOR_REPLY=true`.
    *   [ ] Test with `BROWSER_HEADLESS=false`.

9.  **Documentation Update (README & SPEC):**
    *   [x] Update `README.md` with instructions for daemon mode and configuration.
    *   [x] Update `SPECIFICATION.md` to reflect daemon workflow, reply format, processing logic, config changes. 