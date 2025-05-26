import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
// Using path.resolve ensures it finds .env in the project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// --- TEMPORARY DEBUG LOG ---
console.log(`[DEBUG] Value of process.env.TWITTER_USERNAME after dotenv.config: '${process.env.TWITTER_USERNAME}'`);
// --- END DEBUG LOG ---

interface EnvConfig {
    SPEECHLAB_EMAIL: string;
    SPEECHLAB_PASSWORD: string;
    AWS_S3_BUCKET: string;
    TARGET_LANGUAGE: string;
    DUB_ACCENT: string;
    SOURCE_LANGUAGE: string;
    DELAY_BETWEEN_PROFILES_MS: number;
    LOG_LEVEL: string;
    TEST_PROFILE_URL: string;
    // Optional AWS credentials - SDK can pick them up from environment
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_REGION?: string;
    // Optional Twitter credentials
    TWITTER_USERNAME?: string;
    TWITTER_PASSWORD?: string;
    TWITTER_EMAIL?: string;
    // Required Twitter API v2 credentials
    TWITTER_API_KEY: string;
    TWITTER_API_SECRET: string;
    TWITTER_ACCESS_TOKEN: string;
    TWITTER_ACCESS_SECRET: string;
    // Optional: Bearer token if needed for specific v2 endpoints
    TWITTER_BEARER_TOKEN?: string;
    // OpenAI API key for summarization
    OPENAI_API_KEY: string;
    // Browser configuration
    BROWSER_HEADLESS?: boolean;
    // Feature Flags
    POST_REPLY_WITH_VIDEO: boolean;
    USE_TWITTER_API_FOR_REPLY: boolean;
}

function validateConfig(env: NodeJS.ProcessEnv): EnvConfig {
    const requiredKeys: (keyof EnvConfig)[] = [
        'SPEECHLAB_EMAIL',
        'SPEECHLAB_PASSWORD',
        'AWS_S3_BUCKET',
        'TARGET_LANGUAGE',
        'DUB_ACCENT',
        'SOURCE_LANGUAGE',
        'DELAY_BETWEEN_PROFILES_MS',
        'LOG_LEVEL',
        'TEST_PROFILE_URL',
        // Add new required Twitter API keys
        'TWITTER_API_KEY',
        'TWITTER_API_SECRET',
        'TWITTER_ACCESS_TOKEN',
        'TWITTER_ACCESS_SECRET',
        // OpenAI API key
        'OPENAI_API_KEY'
    ];

    for (const key of requiredKeys) {
        if (!env[key]) {
            console.error(`❌ Missing required environment variable: ${key}`);
            process.exit(1); // Exit if required config is missing
        }
    }

    // --- Parse Optional Flags with Defaults ---
    const delayMs = parseInt(env.DELAY_BETWEEN_PROFILES_MS || '300000', 10);
    if (isNaN(delayMs)) {
        console.error(`❌ Invalid non-numeric value for DELAY_BETWEEN_PROFILES_MS: ${env.DELAY_BETWEEN_PROFILES_MS}`);
        process.exit(1);
    }

    // Parse BROWSER_HEADLESS value as boolean (default to false if not provided)
    const browserHeadless = env.BROWSER_HEADLESS ? env.BROWSER_HEADLESS.toLowerCase() === 'true' : false;

    // Default POST_REPLY_WITH_VIDEO to false if not set or invalid
    const postReplyWithVideo = env.POST_REPLY_WITH_VIDEO ? env.POST_REPLY_WITH_VIDEO.toLowerCase() === 'true' : false;
    
    // Default USE_TWITTER_API_FOR_REPLY to false if not set or invalid
    const useTwitterApiForReply = env.USE_TWITTER_API_FOR_REPLY ? env.USE_TWITTER_API_FOR_REPLY.toLowerCase() === 'true' : false;

    return {
        SPEECHLAB_EMAIL: env.SPEECHLAB_EMAIL!,
        SPEECHLAB_PASSWORD: env.SPEECHLAB_PASSWORD!,
        AWS_S3_BUCKET: env.AWS_S3_BUCKET!,
        TARGET_LANGUAGE: env.TARGET_LANGUAGE!,
        DUB_ACCENT: env.DUB_ACCENT!,
        SOURCE_LANGUAGE: env.SOURCE_LANGUAGE!,
        DELAY_BETWEEN_PROFILES_MS: delayMs,
        LOG_LEVEL: env.LOG_LEVEL!,
        TEST_PROFILE_URL: env.TEST_PROFILE_URL!,
        // Optional AWS credentials
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: env.AWS_REGION,
        // Optional Twitter Login credentials
        TWITTER_USERNAME: env.TWITTER_USERNAME,
        TWITTER_PASSWORD: env.TWITTER_PASSWORD,
        TWITTER_EMAIL: env.TWITTER_EMAIL,
        // Required Twitter API
        TWITTER_API_KEY: env.TWITTER_API_KEY!,
        TWITTER_API_SECRET: env.TWITTER_API_SECRET!,
        TWITTER_ACCESS_TOKEN: env.TWITTER_ACCESS_TOKEN!,
        TWITTER_ACCESS_SECRET: env.TWITTER_ACCESS_SECRET!,
        TWITTER_BEARER_TOKEN: env.TWITTER_BEARER_TOKEN,
        // Browser config
        BROWSER_HEADLESS: browserHeadless,
        // Add new flags
        POST_REPLY_WITH_VIDEO: postReplyWithVideo,
        USE_TWITTER_API_FOR_REPLY: useTwitterApiForReply,
        // OpenAI API key for summarization
        OPENAI_API_KEY: env.OPENAI_API_KEY!,
    };
}

// Validate and freeze the configuration object to prevent modifications
export const config: EnvConfig = Object.freeze(validateConfig(process.env));

console.log('ℹ️ Configuration loaded successfully.'); // Add a log to confirm loading 