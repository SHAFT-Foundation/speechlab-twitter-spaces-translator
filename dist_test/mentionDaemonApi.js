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
var logger_1 = __importDefault(require("./utils/logger"));
var config_1 = require("./utils/config");
var twitterMentionService_1 = require("./services/twitterMentionService");
var languageUtils_1 = require("./utils/languageUtils");
var path = __importStar(require("path"));
var fs = __importStar(require("fs"));
/**
 * Twitter Mention Daemon - Twitter API Implementation
 *
 * This daemon polls Twitter mentions using the Twitter API, processes dubbing requests,
 * and posts video replies back to mentions.
 */
// State management
var lastProcessedMentionId = null;
var processedMentionIds = new Set();
var STATE_FILE = path.join(process.cwd(), 'mention_daemon_state.json');
/**
 * Load daemon state from disk
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            var state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            lastProcessedMentionId = state.lastProcessedMentionId || null;
            if (state.processedMentionIds && Array.isArray(state.processedMentionIds)) {
                state.processedMentionIds.forEach(function (id) { return processedMentionIds.add(id); });
            }
            logger_1.default.info("[\uD83D\uDCBE State] Loaded state: last processed ID = ".concat(lastProcessedMentionId, ", ").concat(processedMentionIds.size, " processed mentions"));
        }
        else {
            logger_1.default.info('[💾 State] No existing state file found, starting fresh');
        }
    }
    catch (error) {
        logger_1.default.error('[💾 State] ❌ Error loading state:', error);
    }
}
/**
 * Save daemon state to disk
 */
function saveState() {
    try {
        var state = {
            lastProcessedMentionId: lastProcessedMentionId,
            processedMentionIds: Array.from(processedMentionIds),
            lastSaved: new Date().toISOString()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        logger_1.default.debug("[\uD83D\uDCBE State] State saved: ".concat(processedMentionIds.size, " processed mentions"));
    }
    catch (error) {
        logger_1.default.error('[💾 State] ❌ Error saving state:', error);
    }
}
/**
 * Process a single mention and create dubbed video response
 */
function processMention(mention) {
    return __awaiter(this, void 0, void 0, function () {
        var spaceIdRegex, match, errorText, spaceId, spaceUrl, targetLanguage, limitationText, error_1, errorText, replyError_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    logger_1.default.info("[\uD83D\uDD04 Process] Processing mention from @".concat(mention.username));
                    logger_1.default.info("[\uD83D\uDD04 Process] Tweet ID: ".concat(mention.tweetId));
                    logger_1.default.info("[\uD83D\uDD04 Process] Text: \"".concat(mention.text, "\""));
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 5, , 10]);
                    spaceIdRegex = /(?:https?:\/\/)?(?:twitter\.com|x\.com)\/i\/spaces\/([a-zA-Z0-9]+)/;
                    match = mention.text.match(spaceIdRegex);
                    if (!(!match || !match[1])) return [3 /*break*/, 3];
                    logger_1.default.warn("[\uD83D\uDD04 Process] \u26A0\uFE0F No Space ID found in mention text");
                    errorText = "@".concat(mention.username, " Sorry, I couldn't find a Twitter Space URL in your mention. Please include a Space URL like: https://twitter.com/i/spaces/[SPACE_ID]");
                    return [4 /*yield*/, (0, twitterMentionService_1.postReplyWithMedia)(errorText, mention.tweetId)];
                case 2:
                    _a.sent();
                    return [2 /*return*/, false];
                case 3:
                    spaceId = match[1];
                    logger_1.default.info("[\uD83D\uDD04 Process] \u2705 Found Space ID: ".concat(spaceId));
                    spaceUrl = "https://twitter.com/i/spaces/".concat(spaceId);
                    logger_1.default.info("[\uD83D\uDD04 Process] Space URL: ".concat(spaceUrl));
                    targetLanguage = (0, languageUtils_1.detectLanguage)(mention.text);
                    logger_1.default.info("[\uD83D\uDD04 Process] Target language: ".concat((0, languageUtils_1.getLanguageName)(targetLanguage)));
                    // For now, we'll skip M3U8 extraction and use a placeholder
                    // In production, you'd need to extract the M3U8 URL from the Space
                    // This would require either Playwright scraping or Twitter's API if available
                    logger_1.default.warn("[\uD83D\uDD04 Process] \u26A0\uFE0F M3U8 extraction not yet implemented for API-only flow");
                    logger_1.default.warn("[\uD83D\uDD04 Process] \u26A0\uFE0F This is a limitation - Twitter API doesn't provide Space audio URLs");
                    limitationText = "@".concat(mention.username, " Thanks for your request! Currently working on API-only implementation. Space audio extraction requires additional development.");
                    return [4 /*yield*/, (0, twitterMentionService_1.postReplyWithMedia)(limitationText, mention.tweetId)];
                case 4:
                    _a.sent();
                    return [2 /*return*/, false];
                case 5:
                    error_1 = _a.sent();
                    logger_1.default.error("[\uD83D\uDD04 Process] \u274C Error processing mention:", error_1);
                    _a.label = 6;
                case 6:
                    _a.trys.push([6, 8, , 9]);
                    errorText = "@".concat(mention.username, " Sorry, I encountered an error processing your request. Please try again later.");
                    return [4 /*yield*/, (0, twitterMentionService_1.postReplyWithMedia)(errorText, mention.tweetId)];
                case 7:
                    _a.sent();
                    return [3 /*break*/, 9];
                case 8:
                    replyError_1 = _a.sent();
                    logger_1.default.error("[\uD83D\uDD04 Process] \u274C Failed to send error reply:", replyError_1);
                    return [3 /*break*/, 9];
                case 9: return [2 /*return*/, false];
                case 10: return [2 /*return*/];
            }
        });
    });
}
/**
 * Main polling loop
 */
function pollMentions() {
    return __awaiter(this, void 0, void 0, function () {
        var mentions, mentionsToProcess, _i, mentionsToProcess_1, mention, success, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info('[🔁 Poll] Starting mention poll cycle...');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 8, , 9]);
                    return [4 /*yield*/, (0, twitterMentionService_1.fetchMentions)(lastProcessedMentionId || undefined)];
                case 2:
                    mentions = _a.sent();
                    if (mentions.length === 0) {
                        logger_1.default.info('[🔁 Poll] No new mentions found');
                        return [2 /*return*/];
                    }
                    logger_1.default.info("[\uD83D\uDD01 Poll] Found ".concat(mentions.length, " new mention(s)"));
                    mentionsToProcess = mentions.reverse();
                    _i = 0, mentionsToProcess_1 = mentionsToProcess;
                    _a.label = 3;
                case 3:
                    if (!(_i < mentionsToProcess_1.length)) return [3 /*break*/, 7];
                    mention = mentionsToProcess_1[_i];
                    // Skip if already processed
                    if (processedMentionIds.has(mention.tweetId)) {
                        logger_1.default.debug("[\uD83D\uDD01 Poll] Skipping already processed mention: ".concat(mention.tweetId));
                        return [3 /*break*/, 6];
                    }
                    // Process mention
                    logger_1.default.info("[\uD83D\uDD01 Poll] Processing mention ".concat(mention.tweetId, "..."));
                    return [4 /*yield*/, processMention(mention)];
                case 4:
                    success = _a.sent();
                    // Mark as processed regardless of success
                    processedMentionIds.add(mention.tweetId);
                    lastProcessedMentionId = mention.tweetId;
                    // Save state after each mention
                    saveState();
                    logger_1.default.info("[\uD83D\uDD01 Poll] Mention ".concat(mention.tweetId, " ").concat(success ? '✅ completed' : '⚠️ failed'));
                    // Wait between mentions to avoid rate limits
                    logger_1.default.info("[\uD83D\uDD01 Poll] Waiting ".concat(config_1.config.DELAY_BETWEEN_PROFILES_MS / 1000, "s before next mention..."));
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, config_1.config.DELAY_BETWEEN_PROFILES_MS); })];
                case 5:
                    _a.sent();
                    _a.label = 6;
                case 6:
                    _i++;
                    return [3 /*break*/, 3];
                case 7:
                    logger_1.default.info('[🔁 Poll] ✅ Poll cycle completed');
                    return [3 /*break*/, 9];
                case 8:
                    error_2 = _a.sent();
                    logger_1.default.error('[🔁 Poll] ❌ Error in poll cycle:', error_2);
                    return [3 /*break*/, 9];
                case 9: return [2 /*return*/];
            }
        });
    });
}
/**
 * Start the mention daemon
 */
function startDaemon() {
    return __awaiter(this, void 0, void 0, function () {
        var pollIntervalMs;
        var _this = this;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    logger_1.default.info('🚀 Starting Twitter Mention Daemon (API Implementation)');
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    // Load previous state
                    loadState();
                    pollIntervalMs = config_1.config.MENTION_POLL_INTERVAL_MS || 300000;
                    logger_1.default.info("[\u2699\uFE0F Config] Poll interval: ".concat(pollIntervalMs / 1000, "s (").concat(pollIntervalMs / 60000, "m)"));
                    logger_1.default.info("[\u2699\uFE0F Config] Delay between mentions: ".concat(config_1.config.DELAY_BETWEEN_PROFILES_MS / 1000, "s"));
                    // Initial poll
                    return [4 /*yield*/, pollMentions()];
                case 1:
                    // Initial poll
                    _a.sent();
                    // Set up polling interval
                    setInterval(function () { return __awaiter(_this, void 0, void 0, function () {
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0: return [4 /*yield*/, pollMentions()];
                                case 1:
                                    _a.sent();
                                    return [2 /*return*/];
                            }
                        });
                    }); }, pollIntervalMs);
                    logger_1.default.info('[✅ Daemon] Mention daemon is now running');
                    logger_1.default.info('[✅ Daemon] Press Ctrl+C to stop');
                    return [2 /*return*/];
            }
        });
    });
}
// Handle graceful shutdown
process.on('SIGINT', function () {
    logger_1.default.info('\n[🛑 Shutdown] Received SIGINT, saving state and shutting down...');
    saveState();
    process.exit(0);
});
process.on('SIGTERM', function () {
    logger_1.default.info('\n[🛑 Shutdown] Received SIGTERM, saving state and shutting down...');
    saveState();
    process.exit(0);
});
// Start the daemon
startDaemon().catch(function (error) {
    logger_1.default.error('[❌ Fatal] Fatal error in daemon:', error);
    saveState();
    process.exit(1);
});
