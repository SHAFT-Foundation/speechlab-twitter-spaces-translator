# 🎙️ SpeechLab Twitter Space Translator Agent 🌎

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/) [![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

**Unlock Global Audiences for Your Twitter Spaces!** ✨

Ever wished your insightful Twitter Space conversations could reach listeners worldwide? This intelligent agent automatically finds popular recorded Twitter Spaces, downloads the audio, uses the cutting-edge [SpeechLab AI](https://translate.speechlab.ai/) platform to dub them into another language (currently Latin American Spanish!), and even posts a link to the dubbed version right back to the original tweet! 🚀

Imagine your content seamlessly translated and shared, expanding your reach and impact across language barriers – all automated!

## ✨ Key Features

*   **🔍 Finds Top Spaces:** (Future) Scans leaderboards like SpacesDashboard to identify influential Twitter profiles.
*   **🎧 Identifies Recordings:** Automatically detects recent *recorded* Twitter Spaces on target profiles.
*   **🔗 Extracts Audio:** Intelligently captures the direct audio stream link (`.m3u8`) from the recorded Space.
*   **☁️ Cloud Powered:** Downloads the audio and securely uploads it to AWS S3 for processing.
*   **🤖 AI Dubbing:** Leverages the powerful SpeechLab API to create high-quality voice-cloned dubs in the target language (`es_la`).
*   **🌐 Generates Sharing Link:** Retrieves a unique link to the dubbed version hosted on SpeechLab.
*   **💬 Posts Back (Automated):** Replies to the original tweet with the sharing link, notifying the host and audience! (Requires careful setup/login).
*   **⚙️ Configurable:** Set target languages, API keys, and processing parameters easily.
*   **🪵 Detailed Logging:** Provides clear, step-by-step logs (with icons!) to monitor the agent's progress.

## 📋 Prerequisites

Before you begin, ensure you have the following installed and configured:

1.  **Node.js:** Version 18.x or preferably 20.x or later. ([Download](https://nodejs.org/))
2.  **npm:** Usually comes with Node.js.
3.  **FFmpeg:** A command-line tool for handling audio/video. You need to install it separately and make sure it's available in your system's PATH. ([Download & Installation Guide](https://ffmpeg.org/download.html))
4.  **SpeechLab Account:** You need an account at [translate.speechlab.ai](https://translate.speechlab.ai/) to get API credentials.
5.  **AWS Account & Credentials:** An AWS account is needed for storing the audio files on S3. The agent uses the `speechlab-test-files-public` bucket by default (ensure this bucket exists or change it in `.env`). Your AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) should be configured in your environment *or* placed in the `.env` file.

## 🛠️ Setup & Configuration

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/SHAFT-Foundation/speechlab-twitter-spaces-translator.git
    cd speechlab-twitter-spaces-translator
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    *   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    *   **Edit the `.env` file** with your actual credentials and settings:
        *   `SPEECHLAB_EMAIL`: Your SpeechLab login email.
        *   `SPEECHLAB_PASSWORD`: Your SpeechLab login password.
        *   `AWS_S3_BUCKET`: The S3 bucket name (defaults to `speechlab-test-files-public`).
        *   `AWS_REGION`: Your S3 bucket's region (if not configured globally, e.g., `us-east-1`).
        *   *(Optional)* `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: Only needed if not configured in your system environment.
        *   *(Optional)* `TWITTER_USERNAME` / `TWITTER_PASSWORD`: **IMPORTANT:** If Twitter requires login for the agent's actions (like posting replies), you might need to provide these *or* implement a more robust cookie-based login strategy.
        *   `TEST_PROFILE_URL`: The Twitter profile URL to use for initial testing (defaults to Mario Nawfal).
        *   Review other variables like `TARGET_LANGUAGE`, `LOG_LEVEL`, etc.

## ▶️ Running the Agent

You have a few options to run the agent:

1.  **Development Mode (Recommended for testing):**
    *   Uses `ts-node` to run TypeScript directly.
    *   ```bash
        npm run dev
        ```

2.  **Production Mode:**
    *   First, compile the TypeScript code:
        ```bash
        npm run build
        ```
    *   Then, run the compiled JavaScript:
        ```bash
        npm start
        ```

The agent will start, log its initialization, and begin processing the profile specified by `TEST_PROFILE_URL` in your `.env` file. Watch the console for detailed logs!

## 🐍 Leaderboard Scraping Utility (Python)

This project includes a separate Python utility to scrape the SpacesDashboard leaderboard for potentially interesting Twitter Spaces hosts. This uses the `nova-act` library.

**Location:** `scraper_utility/scrape_leaderboard.py`

**Requirements:**

*   Python 3.x installed.
*   Python dependencies installed: Run `pip install -r scraper_utility/requirements.txt` from the project root or within the `scraper_utility` directory.
*   `NOVA_ACT_API_KEY` environment variable: You need an API key for the `nova-act` service. Set this variable in your environment before running the script.

**How to Run:**

1.  Navigate to the utility directory:
    ```bash
    cd scraper_utility
    ```
2.  Install dependencies (if you haven't already):
    ```bash
    pip install -r requirements.txt
    ```
3.  Set the API key environment variable (replace `'your_key_here'`):
    ```bash
    export NOVA_ACT_API_KEY='your_key_here'
    # Or on Windows (Command Prompt):
    # set NOVA_ACT_API_KEY=your_key_here
    # Or on Windows (PowerShell):
    # $env:NOVA_ACT_API_KEY='your_key_here'
    ```
4.  Run the script:
    ```bash
    python scrape_leaderboard.py
    ```
    *   You can pass options like `--headless=false` or `--limit=100`.

**Output:**

The script will save the scraped data to `leaderboard_data.json` in the **project root directory** (i.e., `../leaderboard_data.json` relative to the script).

## ⚙️ Configuration Details (.env)

*   `SPEECHLAB_EMAIL`/`PASSWORD`: Essential for accessing the SpeechLab API.
*   `AWS_S3_BUCKET`/`AWS_REGION`: Defines where intermediate audio files are stored. Ensure the bucket allows public-read access for the SpeechLab API.
*   `TARGET_LANGUAGE`/`DUB_ACCENT`: Set the desired output language/accent (e.g., `es_la`).
*   `LOG_LEVEL`: Control log verbosity (`debug`, `info`, `warn`, `error`).
*   `TEST_PROFILE_URL`: The specific Twitter profile to process during development/single runs.

## ⚠️ Important Notes & Troubleshooting

*   **Playwright Selectors:** Twitter's website structure changes frequently. The selectors used by Playwright (in `src/services/twitterInteractionService.ts`) to find tweets, buttons, and text areas **may break**. If the agent fails during Twitter interaction, you'll likely need to:
    *   Run Playwright in non-headless mode (`headless: false` in `initializeBrowser`) to observe.
    *   Inspect the Twitter elements in your browser's developer tools.
    *   Update the `*_SELECTOR` constants in the service file.
*   **Twitter Login:** Posting replies usually requires being logged in. This agent currently *doesn't* handle Twitter login explicitly. You might need to:
    *   Manually log in to Twitter in a browser and potentially adapt the code to load session cookies.
    *   Use Twitter API v2 (requires developer account setup and API keys) instead of browser automation for posting, which is more robust but has usage limits/costs.
*   **Rate Limiting:** Running the agent too frequently or against many profiles might trigger rate limits or CAPTCHAs from Twitter. The `DELAY_BETWEEN_PROFILES_MS` config is intended for future multi-profile processing.
*   **FFmpeg Path:** Ensure the `ffmpeg` command is globally accessible in your terminal's PATH.

---

Enjoy automating your Twitter Space translations! Feel free to contribute or report issues.
