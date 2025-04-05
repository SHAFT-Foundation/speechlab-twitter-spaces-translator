import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
// Using path.resolve ensures it finds .env in the project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

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
    ];

    for (const key of requiredKeys) {
        if (!env[key]) {
            console.error(`❌ Missing required environment variable: ${key}`);
            process.exit(1); // Exit if required config is missing
        }
    }

    const delayMs = parseInt(env.DELAY_BETWEEN_PROFILES_MS!, 10);
    if (isNaN(delayMs)) {
        console.error(`❌ Invalid non-numeric value for DELAY_BETWEEN_PROFILES_MS: ${env.DELAY_BETWEEN_PROFILES_MS}`);
        process.exit(1);
    }


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
        // Optional values
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: env.AWS_REGION,
        TWITTER_USERNAME: env.TWITTER_USERNAME,
        TWITTER_PASSWORD: env.TWITTER_PASSWORD,
    };
}

// Validate and freeze the configuration object to prevent modifications
export const config: EnvConfig = Object.freeze(validateConfig(process.env));

console.log('ℹ️ Configuration loaded successfully.'); // Add a log to confirm loading 