"use strict";
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
var twitterMentionService_1 = require("./services/twitterMentionService");
/**
 * Test script for Twitter API mention polling
 *
 * This script tests the Twitter API integration for fetching mentions
 * and posting replies.
 */
function testMentionFetching() {
    return __awaiter(this, void 0, void 0, function () {
        var mentions_1, testSinceId, newMentions, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    logger_1.default.info('🧪 Testing Twitter API Mention Fetching');
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 5, , 6]);
                    // Test 1: Fetch recent mentions
                    logger_1.default.info('\n[Test 1] Fetching recent mentions...');
                    return [4 /*yield*/, (0, twitterMentionService_1.fetchMentions)()];
                case 2:
                    mentions_1 = _a.sent();
                    if (mentions_1.length === 0) {
                        logger_1.default.info('✅ No mentions found (this is normal if you have no recent mentions)');
                    }
                    else {
                        logger_1.default.info("\u2705 Fetched ".concat(mentions_1.length, " mention(s):"));
                        mentions_1.forEach(function (mention, index) {
                            logger_1.default.info("\n[Mention ".concat(index + 1, "/").concat(mentions_1.length, "]"));
                            logger_1.default.info("  Tweet ID: ".concat(mention.tweetId));
                            logger_1.default.info("  URL: ".concat(mention.tweetUrl));
                            logger_1.default.info("  From: @".concat(mention.username));
                            logger_1.default.info("  Text: \"".concat(mention.text, "\""));
                            logger_1.default.info("  Created: ".concat(mention.createdAt.toISOString()));
                        });
                    }
                    if (!(mentions_1.length > 0)) return [3 /*break*/, 4];
                    logger_1.default.info('\n[Test 2] Testing sinceId parameter...');
                    testSinceId = mentions_1[0].tweetId;
                    logger_1.default.info("Using sinceId: ".concat(testSinceId));
                    return [4 /*yield*/, (0, twitterMentionService_1.fetchMentions)(testSinceId)];
                case 3:
                    newMentions = _a.sent();
                    logger_1.default.info("\u2705 Fetched ".concat(newMentions.length, " mention(s) since ID ").concat(testSinceId));
                    if (newMentions.length === 0) {
                        logger_1.default.info('(No new mentions since this ID - this is expected)');
                    }
                    _a.label = 4;
                case 4:
                    logger_1.default.info('\n═══════════════════════════════════════════════════════════');
                    logger_1.default.info('✅ All mention fetching tests completed successfully');
                    logger_1.default.info('═══════════════════════════════════════════════════════════');
                    return [3 /*break*/, 6];
                case 5:
                    error_1 = _a.sent();
                    logger_1.default.error('\n❌ Test failed:', error_1);
                    process.exit(1);
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function testReplyPosting() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            logger_1.default.info('\n═══════════════════════════════════════════════════════════');
            logger_1.default.info('🧪 Testing Twitter API Reply Posting');
            logger_1.default.info('═══════════════════════════════════════════════════════════');
            logger_1.default.info('⚠️  This test is DISABLED by default to avoid posting test tweets');
            logger_1.default.info('⚠️  To enable, uncomment the postReplyWithMedia call below');
            logger_1.default.info('═══════════════════════════════════════════════════════════');
            return [2 /*return*/];
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info('Starting Twitter API integration tests...\n');
                    // Run mention fetching tests
                    return [4 /*yield*/, testMentionFetching()];
                case 1:
                    // Run mention fetching tests
                    _a.sent();
                    // Run reply posting tests (disabled by default)
                    return [4 /*yield*/, testReplyPosting()];
                case 2:
                    // Run reply posting tests (disabled by default)
                    _a.sent();
                    logger_1.default.info('\n✅ All tests completed!');
                    process.exit(0);
                    return [2 /*return*/];
            }
        });
    });
}
// Run the tests
main().catch(function (error) {
    logger_1.default.error('Fatal error:', error);
    process.exit(1);
});
