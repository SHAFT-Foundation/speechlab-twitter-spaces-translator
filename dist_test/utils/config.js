"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
var dotenv_1 = __importDefault(require("dotenv"));
var path_1 = __importDefault(require("path"));
// Load environment variables from .env file
// Using path.resolve ensures it finds .env in the project root
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), '.env') });
// --- TEMPORARY DEBUG LOG ---
console.log("[DEBUG] Value of process.env.TWITTER_USERNAME after dotenv.config: '".concat(process.env.TWITTER_USERNAME, "'"));
function validateConfig(env) {
    var requiredKeys = [
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
        'TWITTER_ACCESS_SECRET'
    ];
    for (var _i = 0, requiredKeys_1 = requiredKeys; _i < requiredKeys_1.length; _i++) {
        var key = requiredKeys_1[_i];
        if (!env[key]) {
            console.error("\u274C Missing required environment variable: ".concat(key));
            process.exit(1); // Exit if required config is missing
        }
    }
    // --- Parse Optional Flags with Defaults ---
    var delayMs = parseInt(env.DELAY_BETWEEN_PROFILES_MS || '300000', 10);
    if (isNaN(delayMs)) {
        console.error("\u274C Invalid non-numeric value for DELAY_BETWEEN_PROFILES_MS: ".concat(env.DELAY_BETWEEN_PROFILES_MS));
        process.exit(1);
    }
    // Parse BROWSER_HEADLESS value as boolean (default to false if not provided)
    var browserHeadless = env.BROWSER_HEADLESS ? env.BROWSER_HEADLESS.toLowerCase() === 'true' : false;
    // Default POST_REPLY_WITH_VIDEO to false if not set or invalid
    var postReplyWithVideo = env.POST_REPLY_WITH_VIDEO ? env.POST_REPLY_WITH_VIDEO.toLowerCase() === 'true' : false;
    // Default USE_TWITTER_API_FOR_REPLY to false if not set or invalid
    var useTwitterApiForReply = env.USE_TWITTER_API_FOR_REPLY ? env.USE_TWITTER_API_FOR_REPLY.toLowerCase() === 'true' : false;
    // Default PROCESS_VIDEO_IN_MENTIONS to false if not set or invalid
    var processVideoInMentions = env.PROCESS_VIDEO_IN_MENTIONS ? env.PROCESS_VIDEO_IN_MENTIONS.toLowerCase() === 'true' : false;
    // Default ATTACH_VIDEO_TO_REPLY to false if not set or invalid
    var attachVideoToReply = env.ATTACH_VIDEO_TO_REPLY ? env.ATTACH_VIDEO_TO_REPLY.toLowerCase() === 'true' : false;
    // Parse MENTION_POLL_INTERVAL_MS with default of 5 minutes (300000ms)
    var mentionPollIntervalMs = parseInt(env.MENTION_POLL_INTERVAL_MS || '300000', 10);
    if (isNaN(mentionPollIntervalMs)) {
        console.error("\u274C Invalid non-numeric value for MENTION_POLL_INTERVAL_MS: ".concat(env.MENTION_POLL_INTERVAL_MS));
        process.exit(1);
    }
    return {
        SPEECHLAB_EMAIL: env.SPEECHLAB_EMAIL,
        SPEECHLAB_PASSWORD: env.SPEECHLAB_PASSWORD,
        AWS_S3_BUCKET: env.AWS_S3_BUCKET,
        TARGET_LANGUAGE: env.TARGET_LANGUAGE,
        DUB_ACCENT: env.DUB_ACCENT,
        SOURCE_LANGUAGE: env.SOURCE_LANGUAGE,
        DELAY_BETWEEN_PROFILES_MS: delayMs,
        LOG_LEVEL: env.LOG_LEVEL,
        TEST_PROFILE_URL: env.TEST_PROFILE_URL,
        // Optional AWS credentials
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: env.AWS_REGION,
        // Optional Twitter Login credentials
        TWITTER_USERNAME: env.TWITTER_USERNAME,
        TWITTER_PASSWORD: env.TWITTER_PASSWORD,
        TWITTER_EMAIL: env.TWITTER_EMAIL,
        // Required Twitter API
        TWITTER_API_KEY: env.TWITTER_API_KEY,
        TWITTER_API_SECRET: env.TWITTER_API_SECRET,
        TWITTER_ACCESS_TOKEN: env.TWITTER_ACCESS_TOKEN,
        TWITTER_ACCESS_SECRET: env.TWITTER_ACCESS_SECRET,
        TWITTER_BEARER_TOKEN: env.TWITTER_BEARER_TOKEN,
        // Browser config
        BROWSER_HEADLESS: browserHeadless,
        // Add new flags
        POST_REPLY_WITH_VIDEO: postReplyWithVideo,
        USE_TWITTER_API_FOR_REPLY: useTwitterApiForReply,
        // Video processing flags
        PROCESS_VIDEO_IN_MENTIONS: processVideoInMentions,
        ATTACH_VIDEO_TO_REPLY: attachVideoToReply,
        // Mention polling
        MENTION_POLL_INTERVAL_MS: mentionPollIntervalMs,
    };
}
// Validate and freeze the configuration object to prevent modifications
exports.config = Object.freeze(validateConfig(process.env));
console.log('ℹ️ Configuration loaded successfully.'); // Add a log to confirm loading 
