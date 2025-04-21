## Core Flow

1.  **Mention Detection:** The daemon monitors Twitter notifications for mentions (`@AIDubbingAgent`).
2.  **Request Parsing:** It extracts the target language (e.g., "dub in spanish") and finds the parent tweet containing the Twitter Space link.
3.  **Space URL Extraction:** It navigates to the mention tweet (using Playwright) and extracts the `/i/spaces/...` URL.
4.  **M3U8 URL Extraction:** It navigates to the Space page, clicks the "Play recording" button, and intercepts the M3U8 playlist URL from network requests.
5.  **Initial Reply:** It posts an initial reply acknowledging the request and providing an estimated processing time (e.g., 15-60 mins).
6.  **Backend Processing (Async):**
    *   Downloads the original Space audio (M3U8) using `ffmpeg` and uploads it to a private S3 bucket.
    *   Calls the SpeechLab API (`createProjectAndDub`) with the S3 audio URL, project name, source/target languages, and a unique `thirdPartyId` (derived from space name + language code).
    *   Polls the SpeechLab API (`getProjectByThirdPartyID` using the correct, full `thirdPartyId`) until the project status is `COMPLETE` or `FAILED`.
    *   If COMPLETE:
        *   Finds the **dubbed MP3** output URL from the project details.
        *   Downloads the dubbed MP3 to a temporary local directory.
        *   **Uploads the downloaded MP3** to the configured **public S3 bucket** (defined by `AWS_S3_BUCKET` in `.env`).
        *   Generates a SpeechLab sharing link.
        *   **(Conditional - If `POST_REPLY_WITH_VIDEO=true`):** If the flag is enabled, it *also* attempts to generate an MP4 video by combining the downloaded MP3 with a static `placeholder.jpg` image using `ffmpeg` (with AAC audio encoding and video compression). *Note: This step is currently disabled by default due to Twitter limitations.* 
    *   If FAILED or TIMEOUT: Logs the error.
7.  **Final Reply:**
    *   Constructs a reply message:
        *   On Success: Mentions the user, states the language, provides the SpeechLab sharing link (if available) and the **direct public S3 link to the dubbed MP3** (if available). Includes engaging text/emojis.
        *   On Failure: Mentions the user and provides an empathetic error message including the reason.
    *   **Posting Mechanism (Conditional - based on `USE_TWITTER_API_FOR_REPLY`):**
        *   **If `false` (Default):** Uses Playwright (`postReplyToTweet`) to navigate to the original mention tweet and post the reply text. Video attachment logic exists but is currently skipped due to `POST_REPLY_WITH_VIDEO` default.
        *   **If `true`:** Uses the Twitter API v2 (`postTweetReplyWithMediaApi`) to post the reply text. If video generation was enabled and successful, it uploads the MP4 via the API and includes the media ID in the post.
    *   **Cleanup:** Deletes the temporary downloaded MP3 file after a successful post. (Generated MP4 cleanup also occurs if video generation was enabled and posting succeeded).

## Configuration (.env)

*   `SPEECHLAB_EMAIL`, `SPEECHLAB_PASSWORD`: Credentials for SpeechLab API.
*   `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`: AWS credentials for S3 interaction.
*   `AWS_S3_BUCKET`: **Public** S3 bucket name for storing and sharing the final dubbed **MP3** files.
*   `TARGET_LANGUAGE`: *Default* target language if not specified in mention (fallback, may not be used if detection is robust).
*   `SOURCE_LANGUAGE`: Source language assumed for SpeechLab projects (e.g., `en`).
*   `DUB_ACCENT`: *Default* accent code to use for dubbing (fallback).
*   `DELAY_BETWEEN_PROFILES_MS`: Delay for profile-specific tasks (not currently used by mention daemon).
*   `LOG_LEVEL`: Logging verbosity (`debug`, `info`, `warn`, `error`).
*   `TEST_PROFILE_URL`: Target profile for testing scripts.
*   `TWITTER_USERNAME`, `TWITTER_PASSWORD`, `TWITTER_EMAIL`: Credentials for Playwright login.
*   `BROWSER_HEADLESS`: Set to `true` to run Playwright without a visible browser window, `false` otherwise.
*   `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET`: Credentials for Twitter API v2 access (required for API posting method).
*   `TWITTER_BEARER_TOKEN` (Optional): Needed for certain read-only v2 endpoints.
*   **`POST_REPLY_WITH_VIDEO` (boolean, default: `false`):** If set to `true`, the daemon will attempt to download the MP3, generate an MP4 using `ffmpeg` and `placeholder.jpg`, and attach this video to the reply. If `false`, only links are posted.
*   **`USE_TWITTER_API_FOR_REPLY` (boolean, default: `false`):** If set to `true`, the daemon will use the Twitter API v2 for posting the final reply (including media upload if `POST_REPLY_WITH_VIDEO` is also true). If `false`, it uses Playwright UI automation.

## Dependencies

*   Node.js / npm
*   TypeScript (`tsx` for execution)
*   Playwright (for browser automation - login, mention scraping, optionally posting)
*   AWS SDK v3 (`@aws-sdk/client-s3` for S3 interaction)
*   Axios (for SpeechLab API calls)
*   Winston (for logging)
*   dotenv (for environment variables)
*   `ffmpeg` (Must be installed **locally** on the machine running the daemon for audio download and optional video conversion)
*   `twitter-api-v2` (Node library for Twitter API interactions - used if `USE_TWITTER_API_FOR_REPLY=true`) 