"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchMentions = fetchMentions;
exports.uploadMedia = uploadMedia;
exports.postReplyWithMedia = postReplyWithMedia;
exports.getLatestTweetId = getLatestTweetId;
var twitter_api_v2_1 = require("twitter-api-v2");
var logger_1 = __importDefault(require("../utils/logger"));
var config_1 = require("../utils/config");
var fs = __importStar(require("fs"));
/**
 * Service for polling Twitter mentions and posting replies using the Twitter API v2
 */
// Initialize Twitter API client
var twitterClient = new twitter_api_v2_1.TwitterApi({
    appKey: config_1.config.TWITTER_API_KEY,
    appSecret: config_1.config.TWITTER_API_SECRET,
    accessToken: config_1.config.TWITTER_ACCESS_TOKEN,
    accessSecret: config_1.config.TWITTER_ACCESS_SECRET,
});
var rwClient = twitterClient.readWrite;
// Rate limiting state
var lastPollTime = 0;
var MIN_POLL_INTERVAL_MS = 60000; // 1 minute between polls to avoid rate limits
/**
 * Get mentions from Twitter API
 * @param sinceId Optional tweet ID to only fetch mentions newer than this
 * @returns Array of mention data
 */
function fetchMentions(sinceId) {
    return __awaiter(this, void 0, void 0, function () {
        var now, timeSinceLastPoll, waitTime_1, me, params, mentionsTimeline, mentions, _loop_1, _i, _a, tweet, error_1;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    logger_1.default.info('[🐦 Mentions] Fetching mentions from Twitter API...');
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 6, , 7]);
                    now = Date.now();
                    timeSinceLastPoll = now - lastPollTime;
                    if (!(timeSinceLastPoll < MIN_POLL_INTERVAL_MS)) return [3 /*break*/, 3];
                    waitTime_1 = MIN_POLL_INTERVAL_MS - timeSinceLastPoll;
                    logger_1.default.info("[\uD83D\uDC26 Mentions] Rate limit protection: waiting ".concat(Math.ceil(waitTime_1 / 1000), "s before polling..."));
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, waitTime_1); })];
                case 2:
                    _d.sent();
                    _d.label = 3;
                case 3: return [4 /*yield*/, rwClient.v2.me()];
                case 4:
                    me = _d.sent();
                    logger_1.default.info("[\uD83D\uDC26 Mentions] Fetching mentions for @".concat(me.data.username, " (ID: ").concat(me.data.id, ")"));
                    params = {
                        max_results: 100, // Maximum allowed
                        'tweet.fields': 'created_at,author_id,conversation_id',
                        'user.fields': 'username',
                        expansions: 'author_id',
                    };
                    if (sinceId) {
                        params.since_id = sinceId;
                        logger_1.default.info("[\uD83D\uDC26 Mentions] Fetching mentions since tweet ID: ".concat(sinceId));
                    }
                    return [4 /*yield*/, rwClient.v2.userMentionTimeline(me.data.id, params)];
                case 5:
                    mentionsTimeline = _d.sent();
                    lastPollTime = Date.now();
                    mentions = [];
                    _loop_1 = function (tweet) {
                        // Get author username from includes
                        var author = (_c = (_b = mentionsTimeline.data.includes) === null || _b === void 0 ? void 0 : _b.users) === null || _c === void 0 ? void 0 : _c.find(function (u) { return u.id === tweet.author_id; });
                        var username = (author === null || author === void 0 ? void 0 : author.username) || 'unknown';
                        mentions.push({
                            tweetId: tweet.id,
                            tweetUrl: "https://twitter.com/".concat(username, "/status/").concat(tweet.id),
                            username: username,
                            text: tweet.text,
                            createdAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
                            authorId: tweet.author_id || '',
                        });
                    };
                    for (_i = 0, _a = mentionsTimeline.data.data || []; _i < _a.length; _i++) {
                        tweet = _a[_i];
                        _loop_1(tweet);
                    }
                    logger_1.default.info("[\uD83D\uDC26 Mentions] \u2705 Fetched ".concat(mentions.length, " mentions"));
                    if (mentions.length > 0) {
                        logger_1.default.debug("[\uD83D\uDC26 Mentions] Latest mention: @".concat(mentions[0].username, ": \"").concat(mentions[0].text.substring(0, 50), "...\""));
                    }
                    return [2 /*return*/, mentions];
                case 6:
                    error_1 = _d.sent();
                    logger_1.default.error('[🐦 Mentions] ❌ Error fetching mentions:', error_1);
                    if (error_1.code) {
                        logger_1.default.error("[\uD83D\uDC26 Mentions] Twitter Error Code: ".concat(error_1.code, ", Message: ").concat(error_1.message));
                    }
                    return [2 /*return*/, []];
                case 7: return [2 /*return*/];
            }
        });
    });
}
/**
 * Upload media to Twitter
 * @param mediaPath Path to media file
 * @returns Media ID string or null if failed
 */
function uploadMedia(mediaPath) {
    return __awaiter(this, void 0, void 0, function () {
        var ext, mimeType, mediaId, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info("[\uD83D\uDC26 Upload] Starting media upload for: ".concat(mediaPath));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    if (!fs.existsSync(mediaPath)) {
                        logger_1.default.error("[\uD83D\uDC26 Upload] File not found: ".concat(mediaPath));
                        return [2 /*return*/, null];
                    }
                    ext = mediaPath.toLowerCase();
                    mimeType = void 0;
                    if (ext.endsWith('.mp4')) {
                        mimeType = twitter_api_v2_1.EUploadMimeType.Mp4;
                    }
                    else if (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) {
                        mimeType = twitter_api_v2_1.EUploadMimeType.Jpeg;
                    }
                    else if (ext.endsWith('.png')) {
                        mimeType = twitter_api_v2_1.EUploadMimeType.Png;
                    }
                    else if (ext.endsWith('.gif')) {
                        mimeType = twitter_api_v2_1.EUploadMimeType.Gif;
                    }
                    else if (ext.endsWith('.webp')) {
                        mimeType = twitter_api_v2_1.EUploadMimeType.Webp;
                    }
                    else {
                        logger_1.default.error("[\uD83D\uDC26 Upload] Unsupported file type: ".concat(ext));
                        return [2 /*return*/, null];
                    }
                    logger_1.default.debug("[\uD83D\uDC26 Upload] Uploading with mime type: ".concat(mimeType));
                    return [4 /*yield*/, twitterClient.v1.uploadMedia(mediaPath, { mimeType: mimeType })];
                case 2:
                    mediaId = _a.sent();
                    logger_1.default.info("[\uD83D\uDC26 Upload] \u2705 Media uploaded successfully. Media ID: ".concat(mediaId));
                    return [2 /*return*/, mediaId];
                case 3:
                    error_2 = _a.sent();
                    logger_1.default.error('[🐦 Upload] ❌ Media upload failed:', error_2);
                    if (error_2.code) {
                        logger_1.default.error("[\uD83D\uDC26 Upload] Twitter Error Code: ".concat(error_2.code, ", Message: ").concat(error_2.message));
                    }
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Post a reply tweet with optional media
 * @param tweetText Reply text
 * @param replyToTweetId Tweet ID to reply to
 * @param mediaPath Optional media file path
 * @returns True if successful
 */
function postReplyWithMedia(tweetText, replyToTweetId, mediaPath) {
    return __awaiter(this, void 0, void 0, function () {
        var mediaId, tweetPayload, result, error_3;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    logger_1.default.info("[\uD83D\uDC26 Reply] Posting reply to tweet ID: ".concat(replyToTweetId));
                    logger_1.default.info("[\uD83D\uDC26 Reply] Reply text: \"".concat(tweetText, "\""));
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 5, , 6]);
                    mediaId = null;
                    if (!mediaPath) return [3 /*break*/, 3];
                    logger_1.default.info("[\uD83D\uDC26 Reply] Uploading media: ".concat(mediaPath));
                    return [4 /*yield*/, uploadMedia(mediaPath)];
                case 2:
                    mediaId = _c.sent();
                    if (!mediaId) {
                        logger_1.default.error('[🐦 Reply] ❌ Failed to upload media');
                        return [2 /*return*/, false];
                    }
                    _c.label = 3;
                case 3:
                    tweetPayload = {
                        text: tweetText,
                        reply: {
                            in_reply_to_tweet_id: replyToTweetId
                        }
                    };
                    if (mediaId) {
                        tweetPayload.media = { media_ids: [mediaId] };
                    }
                    // Post tweet
                    logger_1.default.info("[\uD83D\uDC26 Reply] Posting tweet...");
                    return [4 /*yield*/, rwClient.v2.tweet(tweetPayload)];
                case 4:
                    result = _c.sent();
                    if ((_a = result.data) === null || _a === void 0 ? void 0 : _a.id) {
                        logger_1.default.info("[\uD83D\uDC26 Reply] \u2705 Reply posted successfully! Tweet ID: ".concat(result.data.id));
                        return [2 /*return*/, true];
                    }
                    else {
                        logger_1.default.error('[🐦 Reply] ❌ No tweet ID in response', result.errors);
                        return [2 /*return*/, false];
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_3 = _c.sent();
                    logger_1.default.error('[🐦 Reply] ❌ Error posting reply:', error_3);
                    if (error_3.code) {
                        logger_1.default.error("[\uD83D\uDC26 Reply] Twitter Error Code: ".concat(error_3.code, ", Message: ").concat(error_3.message));
                    }
                    if ((_b = error_3.data) === null || _b === void 0 ? void 0 : _b.errors) {
                        logger_1.default.error("[\uD83D\uDC26 Reply] Twitter API Errors: ".concat(JSON.stringify(error_3.data.errors)));
                    }
                    return [2 /*return*/, false];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Get the latest tweet ID from a user (for sinceId tracking)
 * @param userId User ID to get latest tweet from
 * @returns Latest tweet ID or null
 */
function getLatestTweetId(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var timeline, error_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, rwClient.v2.userTimeline(userId, { max_results: 5 })];
                case 1:
                    timeline = _a.sent();
                    if (timeline.data.data && timeline.data.data.length > 0) {
                        return [2 /*return*/, timeline.data.data[0].id];
                    }
                    return [2 /*return*/, null];
                case 2:
                    error_4 = _a.sent();
                    logger_1.default.error('[🐦 Latest] ❌ Error getting latest tweet ID:', error_4);
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
logger_1.default.info('[🐦 Service] Twitter Mention Service initialized');
