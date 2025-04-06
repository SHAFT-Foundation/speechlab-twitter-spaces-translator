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
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Simple test file to directly post a split reply with the translation link
 */
var logger_1 = require("./utils/logger");
var playwright_1 = require("playwright");
var fs_1 = require("fs");
var path_1 = require("path");
// Using the existing sharing link provided
var EXISTING_SHARING_LINK = "https://translate.speechlab.ai/projects/67f2ce9c2ee951002667cd7b?usp=sharing&token=6231cab4aa64180661d63c6a8a3fc9d730088a3e82840942b1ce01c7ba7991f28f9c0d5a45278fa746042425a7c869918daf86c688dbb17820370eb51fb24144&uid=64c02c788cc17800260aaa14&rid=63c7303736135300262305cc";
// Known Space tweet from the host (directly embedding a Space)
var KNOWN_SPACE_TWEET_URL = "https://x.com/shaftfinance/status/1902388551771152713";
/**
 * Simple function to post a split reply to a tweet
 * First post the text, then post the link as a reply to our own comment
 */
function postSplitReply(tweetUrl) {
    return __awaiter(this, void 0, void 0, function () {
        var browser, context, page, timestamp, screenshotsDir, messageTstamp, firstMessage, timestampSelector, ourReplyArticle, replyButton, linkText, error_1, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info("[\uD83E\uDDEA Test] Posting split reply to tweet: ".concat(tweetUrl));
                    return [4 /*yield*/, playwright_1.chromium.launch({
                            headless: false,
                            args: ['--no-sandbox']
                        })];
                case 1:
                    browser = _a.sent();
                    return [4 /*yield*/, browser.newContext()];
                case 2:
                    context = _a.sent();
                    return [4 /*yield*/, context.newPage()];
                case 3:
                    page = _a.sent();
                    timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
                    screenshotsDir = path_1.default.join(process.cwd(), 'logs', 'twitter', 'screenshots', "split-reply-".concat(timestamp));
                    return [4 /*yield*/, fs_1.default.promises.mkdir(screenshotsDir, { recursive: true })];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5:
                    _a.trys.push([5, 46, 48, 50]);
                    // Login to Twitter
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Logging into Twitter...");
                    // Navigate to Twitter login
                    return [4 /*yield*/, page.goto('https://twitter.com/i/flow/login', { waitUntil: 'domcontentloaded' })];
                case 6:
                    // Navigate to Twitter login
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(2000)];
                case 7:
                    _a.sent();
                    // Fill username
                    return [4 /*yield*/, page.fill('input[autocomplete="username"]', 'SpeechlabAgent')];
                case 8:
                    // Fill username
                    _a.sent();
                    return [4 /*yield*/, page.click('div[role="button"]:has-text("Next")')];
                case 9:
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(2000)];
                case 10:
                    _a.sent();
                    // Fill password (use env var or config)
                    return [4 /*yield*/, page.fill('input[name="password"]', 'SpeechlabAgent789!')];
                case 11:
                    // Fill password (use env var or config)
                    _a.sent();
                    return [4 /*yield*/, page.click('div[data-testid="LoginForm_Login_Button"]')];
                case 12:
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(5000)];
                case 13:
                    _a.sent();
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Successfully logged in");
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'login-completed.png') })];
                case 14:
                    _a.sent();
                    // Navigate to tweet
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Navigating to tweet: ".concat(tweetUrl));
                    return [4 /*yield*/, page.goto(tweetUrl, { waitUntil: 'domcontentloaded' })];
                case 15:
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(5000)];
                case 16:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'tweet-page.png') })];
                case 17:
                    _a.sent();
                    messageTstamp = new Date().toISOString().replace(/[T]/g, ' ').substring(0, 16);
                    firstMessage = "Speechlab Twitter Space Agent sponsored by @shaftfinance $shaft has dubbed this @shaftfinance space in Latin Spanish! Contact for more languages!";
                    // Step 1: Post the first reply with just text
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Posting first reply with just text");
                    // Click reply button
                    return [4 /*yield*/, page.click('[data-testid="reply"]')];
                case 18:
                    // Click reply button
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(2000)];
                case 19:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'reply-dialog.png') })];
                case 20:
                    _a.sent();
                    // Type first reply text
                    return [4 /*yield*/, page.fill('div[data-testid="tweetTextarea_0"]', firstMessage)];
                case 21:
                    // Type first reply text
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(1000)];
                case 22:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'first-reply-text.png') })];
                case 23:
                    _a.sent();
                    // Click reply button
                    return [4 /*yield*/, page.click('[data-testid="tweetButton"]')];
                case 24:
                    // Click reply button
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(5000)];
                case 25:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'first-reply-posted.png') })];
                case 26:
                    _a.sent();
                    logger_1.default.info("[\uD83D\uDC26 Twitter] First reply posted successfully. Waiting for it to appear...");
                    // Step 2: Refresh the page and find our own reply
                    return [4 /*yield*/, page.reload()];
                case 27:
                    // Step 2: Refresh the page and find our own reply
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(5000)];
                case 28:
                    _a.sent();
                    timestampSelector = "text=\"".concat(messageTstamp.substring(0, 10), "\"");
                    _a.label = 29;
                case 29:
                    _a.trys.push([29, 43, , 45]);
                    // Wait for our reply to appear
                    return [4 /*yield*/, page.waitForSelector(timestampSelector, { timeout: 10000 })];
                case 30:
                    // Wait for our reply to appear
                    _a.sent();
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Found our reply with the timestamp!");
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'our-reply-found.png') })];
                case 31:
                    _a.sent();
                    ourReplyArticle = page.locator("article:has(".concat(timestampSelector, ")")).first();
                    return [4 /*yield*/, ourReplyArticle.scrollIntoViewIfNeeded()];
                case 32:
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(1000)];
                case 33:
                    _a.sent();
                    replyButton = ourReplyArticle.locator('[data-testid="reply"]');
                    return [4 /*yield*/, replyButton.click()];
                case 34:
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(2000)];
                case 35:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'replying-to-our-reply.png') })];
                case 36:
                    _a.sent();
                    linkText = "Here is the link: ".concat(EXISTING_SHARING_LINK);
                    return [4 /*yield*/, page.fill('div[data-testid="tweetTextarea_0"]', linkText)];
                case 37:
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(1000)];
                case 38:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'second-reply-text.png') })];
                case 39:
                    _a.sent();
                    // Click reply button
                    return [4 /*yield*/, page.click('[data-testid="tweetButton"]')];
                case 40:
                    // Click reply button
                    _a.sent();
                    return [4 /*yield*/, page.waitForTimeout(5000)];
                case 41:
                    _a.sent();
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'second-reply-posted.png') })];
                case 42:
                    _a.sent();
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Second reply with link posted successfully!");
                    return [3 /*break*/, 45];
                case 43:
                    error_1 = _a.sent();
                    logger_1.default.error("[\uD83D\uDC26 Twitter] Error finding our reply: ".concat(error_1));
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'find-reply-error.png') })];
                case 44:
                    _a.sent();
                    return [3 /*break*/, 45];
                case 45: return [3 /*break*/, 50];
                case 46:
                    error_2 = _a.sent();
                    logger_1.default.error("[\uD83D\uDC26 Twitter] Error posting split reply: ".concat(error_2));
                    return [4 /*yield*/, page.screenshot({ path: path_1.default.join(screenshotsDir, 'error.png') })];
                case 47:
                    _a.sent();
                    return [3 /*break*/, 50];
                case 48: return [4 /*yield*/, browser.close()];
                case 49:
                    _a.sent();
                    logger_1.default.info("[\uD83D\uDC26 Twitter] Browser closed");
                    return [7 /*endfinally*/];
                case 50: return [2 /*return*/];
            }
        });
    });
}
/**
 * Main function
 */
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var args, tweetUrl;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    args = process.argv.slice(2);
                    tweetUrl = args[0] || KNOWN_SPACE_TWEET_URL;
                    logger_1.default.info("[\uD83E\uDDEA Test] Starting split reply test for tweet: ".concat(tweetUrl));
                    return [4 /*yield*/, postSplitReply(tweetUrl)];
                case 1:
                    _a.sent();
                    logger_1.default.info("[\uD83E\uDDEA Test] Split reply test completed");
                    return [2 /*return*/];
            }
        });
    });
}
// Run the main function
main().catch(function (error) {
    logger_1.default.error("[\uD83E\uDDEA Test] Unhandled error: ".concat(error));
});
