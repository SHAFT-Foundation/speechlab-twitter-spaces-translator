# Task PRD: Mention Monitoring Daemon Implementation

This document outlines the tasks required to implement the Twitter Mention Monitoring Daemon feature as specified in `PRD/SPECIFICATION.md`.

## Task List

1.  **Create Daemon Entry Point:**
    *   [ ] Create `src/mentionDaemon.ts`.
    *   [ ] Set up basic daemon structure (main loop, init).
    *   [ ] Add `start:daemon` script to `package.json`.

2.  **Implement Mention Scraping (`twitterInteractionService.ts`):**
    *   [ ] Add `scrapeMentions` function.
    *   [ ] Implement Playwright login logic for the agent account.
    *   [ ] Implement navigation to the mentions page.
    *   [ ] Implement selectors and logic to extract mention data (tweet ID, username, text).
    *   [ ] Return structured mention data.

3.  **Implement Mention Processing Logic (`mentionDaemon.ts`):**
    *   [ ] Implement reading/writing to `processed_mentions.json` (create if not exists).
    *   [ ] Set up `setInterval` polling loop calling `scrapeMentions`.
    *   [ ] Implement logic to filter out already processed mentions.
    *   [ ] Create `extractSpaceUrlFromMention(text)` utility function (regex-based).
    *   [ ] Call URL extraction for new mentions.

4.  **Integrate Dubbing Workflow:**
    *   [ ] Create `processMentionRequest(mentionTweetId, mentionUsername, spaceUrl)` function (in `mentionDaemon.ts` or new service).
    *   [ ] Adapt/Call `twitterInteractionService.getM3u8ForSpacePage(spaceUrl)`.
    *   [ ] Call `audioService.downloadAndUploadAudio`.
    *   [ ] Call `speechlabApiService.createDubbingProject`.
    *   [ ] Call `speechlabApiService.waitForProjectCompletion`.
    *   [ ] Call `speechlabApiService.generateSharingLink`.
    *   [ ] Implement robust error handling for the entire workflow.

5.  **Implement Reply Posting (`twitterInteractionService.ts`):**
    *   [ ] Adapt `postReplyToTweet` to accept `mentionTweetId` as the target.
    *   [ ] Implement dynamic reply text formatting (e.g., `"Hey @<user>, ... <link>"`).
    *   [ ] Call `postReplyToTweet` from `processMentionRequest` upon success.

6.  **Add Logging:**
    *   [ ] Add `[🔔 Mention]` / `[😈 Daemon]` prefixed logs in `mentionDaemon.ts`.
    *   [ ] Ensure logging in modified/new service functions follows existing patterns.

7.  **Environment Variables & Configuration:**
    *   [ ] Verify `TWITTER_USERNAME`, `TWITTER_PASSWORD` are loaded via `config.ts`.
    *   [ ] Document necessary environment variables.
    *   [ ] Add configurable polling interval (optional).

8.  **Testing:**
    *   [ ] Manual test: Mention agent with a valid Space link.
    *   [ ] Verify end-to-end flow (scrape -> dub -> reply).
    *   [ ] Test error handling (invalid mention, API failure).
    *   [ ] Verify `processed_mentions.json` updates.

9.  **Documentation Update (README):**
    *   [ ] Update `README.md` with instructions for daemon mode and configuration. 