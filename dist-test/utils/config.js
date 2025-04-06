"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
var dotenv_1 = require("dotenv");
var path_1 = require("path");
// Load environment variables from .env file
// Using path.resolve ensures it finds .env in the project root
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), '.env') });
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
    ];
    for (var _i = 0, requiredKeys_1 = requiredKeys; _i < requiredKeys_1.length; _i++) {
        var key = requiredKeys_1[_i];
        if (!env[key]) {
            console.error("\u274C Missing required environment variable: ".concat(key));
            process.exit(1); // Exit if required config is missing
        }
    }
    var delayMs = parseInt(env.DELAY_BETWEEN_PROFILES_MS, 10);
    if (isNaN(delayMs)) {
        console.error("\u274C Invalid non-numeric value for DELAY_BETWEEN_PROFILES_MS: ".concat(env.DELAY_BETWEEN_PROFILES_MS));
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
        // Optional values
        AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: env.AWS_REGION,
        TWITTER_USERNAME: env.TWITTER_USERNAME,
        TWITTER_PASSWORD: env.TWITTER_PASSWORD,
    };
}
// Validate and freeze the configuration object to prevent modifications
exports.config = Object.freeze(validateConfig(process.env));
console.log('ℹ️ Configuration loaded successfully.'); // Add a log to confirm loading 
