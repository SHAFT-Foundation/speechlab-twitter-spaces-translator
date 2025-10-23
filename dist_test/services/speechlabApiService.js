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
exports.createDubbingProject = createDubbingProject;
exports.generateSharingLink = generateSharingLink;
exports.getProjectByThirdPartyID = getProjectByThirdPartyID;
exports.waitForProjectCompletion = waitForProjectCompletion;
var axios_1 = __importDefault(require("axios"));
var config_1 = require("../utils/config");
var logger_1 = __importDefault(require("../utils/logger"));
var path_1 = __importDefault(require("path"));
var promises_1 = __importDefault(require("fs/promises"));
var API_BASE_URL = 'https://translate-api.speechlab.ai';
// Simple in-memory cache for the token
var cachedToken = null;
var tokenExpiryTime = null; // Store expiry time (optional, needs parsing JWT)
// Create an Axios instance for API calls
var apiClient = axios_1.default.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 30000, // 30 second timeout
});
/**
 * Handles API errors, logging relevant details.
 * @param error The error object (likely AxiosError).
 * @param context Descriptive string for the context where the error occurred.
 */
function handleApiError(error, context) {
    if (axios_1.default.isAxiosError(error)) {
        var axiosError = error;
        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C API Error during ".concat(context, ": ").concat(axiosError.message));
        if (axiosError.response) {
            logger_1.default.error("[\uD83E\uDD16 SpeechLab] Status: ".concat(axiosError.response.status));
            logger_1.default.error("[\uD83E\uDD16 SpeechLab] Data: ".concat(JSON.stringify(axiosError.response.data)));
            logger_1.default.error("[\uD83E\uDD16 SpeechLab] Headers: ".concat(JSON.stringify(axiosError.response.headers)));
        }
        else if (axiosError.request) {
            logger_1.default.error('[🤖 SpeechLab] No response received:', axiosError.request);
        }
        else {
            // Something happened in setting up the request that triggered an Error
            logger_1.default.error('[🤖 SpeechLab] Error setting up request:', axiosError.message);
        }
    }
    else {
        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Non-Axios error during ".concat(context, ":"), error);
    }
}
/**
 * Invalidates the cached authentication token.
 */
function invalidateAuthToken() {
    logger_1.default.info('[🤖 SpeechLab] Invalidating cached authentication token.');
    cachedToken = null;
    tokenExpiryTime = null;
}
/**
 * Authenticates with the SpeechLab API to get a JWT token.
 * Uses simple caching. Add proper JWT expiry check if needed.
 * @returns {Promise<string | null>} The JWT token or null on failure.
 */
function getAuthToken() {
    return __awaiter(this, void 0, void 0, function () {
        var loginPayload, response, token, error_1;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    // Basic check: If we have a token, return it (improve with expiry check later)
                    if (cachedToken) {
                        // TODO: Add check for tokenExpiryTime here if implementing JWT parsing
                        logger_1.default.debug('[🤖 SpeechLab] Using cached authentication token.');
                        return [2 /*return*/, cachedToken];
                    }
                    logger_1.default.info('[🤖 SpeechLab] No cached token. Authenticating with API...');
                    loginPayload = {
                        email: config_1.config.SPEECHLAB_EMAIL,
                        password: config_1.config.SPEECHLAB_PASSWORD,
                    };
                    _d.label = 1;
                case 1:
                    _d.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, apiClient.post('/v1/auth/login', loginPayload)];
                case 2:
                    response = _d.sent();
                    token = (_c = (_b = (_a = response.data) === null || _a === void 0 ? void 0 : _a.tokens) === null || _b === void 0 ? void 0 : _b.accessToken) === null || _c === void 0 ? void 0 : _c.jwtToken;
                    if (token) {
                        logger_1.default.info('[🤖 SpeechLab] ✅ Successfully authenticated and obtained token.');
                        cachedToken = token;
                        // TODO: Decode JWT to get expiry time and set tokenExpiryTime
                        return [2 /*return*/, token];
                    }
                    else {
                        logger_1.default.error('[🤖 SpeechLab] ❌ Authentication successful but token not found in response.');
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Full login response: ".concat(JSON.stringify(response.data)));
                        return [2 /*return*/, null];
                    }
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _d.sent();
                    handleApiError(error_1, 'authentication');
                    return [2 /*return*/, null];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Creates a dubbing project in SpeechLab. Handles 401 errors by retrying once after refreshing the token.
 * @param publicAudioUrl The publicly accessible URL of the source audio file (e.g., S3 URL).
 * @param projectName The desired name for the project.
 * @param targetLanguageCode The detected target language code (e.g., 'es').
 * @param thirdPartyId The unique identifier for this job (e.g., spaceId-langCode).
 * @param sourceLanguageCode Optional source language code. If not provided, uses config.SOURCE_LANGUAGE.
 * @returns {Promise<string | null>} The projectId if successful, otherwise null.
 */
function createDubbingProject(publicAudioUrl, projectName, targetLanguageCode, thirdPartyId, sourceLanguageCode) {
    return __awaiter(this, void 0, void 0, function () {
        var attempt, maxAttempts, finalProjectName, apiTargetLanguage, apiDubAccent, payload, token, response, projectId, error_2, context;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    logger_1.default.info("[\uD83E\uDD16 SpeechLab] Attempting to create dubbing project: Name=\"".concat(projectName, "\", Source=").concat(sourceLanguageCode || config_1.config.SOURCE_LANGUAGE, ", Target=").concat(targetLanguageCode, ", 3rdPartyID=").concat(thirdPartyId));
                    attempt = 1;
                    maxAttempts = 2;
                    finalProjectName = projectName.substring(0, 100);
                    apiTargetLanguage = targetLanguageCode;
                    apiDubAccent = targetLanguageCode;
                    if (targetLanguageCode === 'es') {
                        apiTargetLanguage = 'es_la';
                        apiDubAccent = 'es_la';
                    }
                    else if (targetLanguageCode === 'pt') {
                        // Default to Brazilian Portuguese for 'pt'
                        apiTargetLanguage = 'pt_br';
                        apiDubAccent = 'pt_br';
                    }
                    logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Mapped target language code ".concat(targetLanguageCode, " to API targetLanguage: ").concat(apiTargetLanguage, ", dubAccent: ").concat(apiDubAccent));
                    payload = {
                        name: finalProjectName,
                        sourceLanguage: sourceLanguageCode || config_1.config.SOURCE_LANGUAGE,
                        targetLanguage: apiTargetLanguage, // Use mapped code
                        dubAccent: apiDubAccent, // Use mapped code
                        unitType: "whiteGlove",
                        mediaFileURI: publicAudioUrl,
                        voiceMatchingMode: "source",
                        thirdPartyID: thirdPartyId,
                    };
                    logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Create project payload (Attempt ".concat(attempt, "): ").concat(JSON.stringify(payload)));
                    _c.label = 1;
                case 1:
                    if (!(attempt <= maxAttempts)) return [3 /*break*/, 7];
                    return [4 /*yield*/, getAuthToken()];
                case 2:
                    token = _c.sent();
                    if (!token) {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Cannot create project (Attempt ".concat(attempt, "): Failed to get authentication token."));
                        return [2 /*return*/, null]; // Can't proceed without a token
                    }
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, apiClient.post('/v1/projects/createProjectAndDub', payload, {
                            headers: { 'Authorization': "Bearer ".concat(token) }
                        })];
                case 4:
                    response = _c.sent();
                    projectId = (_a = response.data) === null || _a === void 0 ? void 0 : _a.projectId;
                    if (projectId) {
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \u2705 Successfully created project (Attempt ".concat(attempt, "). Project ID: ").concat(projectId, " (ThirdPartyID: ").concat(thirdPartyId, ")"));
                        return [2 /*return*/, projectId];
                    }
                    else {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Project creation API call successful (Attempt ".concat(attempt, ") but projectId not found in response."));
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Full create project response (Attempt ".concat(attempt, "): ").concat(JSON.stringify(response.data)));
                        return [2 /*return*/, null]; // API succeeded but didn't return expected data
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_2 = _c.sent();
                    context = "project creation for ".concat(finalProjectName, " (3rdPartyID: ").concat(thirdPartyId, ") (Attempt ").concat(attempt, ")");
                    if (axios_1.default.isAxiosError(error_2) && ((_b = error_2.response) === null || _b === void 0 ? void 0 : _b.status) === 401 && attempt < maxAttempts) {
                        logger_1.default.warn("[\uD83E\uDD16 SpeechLab] \u26A0\uFE0F Received 401 Unauthorized on attempt ".concat(attempt, ". Invalidating token and retrying..."));
                        invalidateAuthToken(); // Invalidate the cached token
                        attempt++;
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Create project payload (Attempt ".concat(attempt, "): ").concat(JSON.stringify(payload))); // Log payload for retry
                        return [3 /*break*/, 1]; // Go to the next iteration to retry
                    }
                    else {
                        // Handle non-401 errors or failure on the final attempt
                        handleApiError(error_2, context);
                        return [2 /*return*/, null];
                    }
                    return [3 /*break*/, 6];
                case 6: return [3 /*break*/, 1];
                case 7:
                    // Should theoretically not be reached if logic is correct, but acts as a fallback
                    logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Failed to create project after ".concat(maxAttempts, " attempts."));
                    return [2 /*return*/, null];
            }
        });
    });
}
/**
 * Generates a sharing link for a given SpeechLab project. Handles 401 errors by retrying once after refreshing the token.
 * @param projectId The ID of the project.
 * @returns {Promise<string | null>} The sharing link URL if successful, otherwise null.
 */
function generateSharingLink(projectId) {
    return __awaiter(this, void 0, void 0, function () {
        var attempt, maxAttempts, payload, token, response, link, error_3, context;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    logger_1.default.info("[\uD83E\uDD16 SpeechLab] Attempting to generate sharing link for project ID: ".concat(projectId));
                    attempt = 1;
                    maxAttempts = 2;
                    payload = { projectId: projectId };
                    logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Generate link payload (Attempt ".concat(attempt, "): ").concat(JSON.stringify(payload)));
                    _c.label = 1;
                case 1:
                    if (!(attempt <= maxAttempts)) return [3 /*break*/, 7];
                    return [4 /*yield*/, getAuthToken()];
                case 2:
                    token = _c.sent();
                    if (!token) {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Cannot generate link (Attempt ".concat(attempt, "): Failed to get authentication token."));
                        return [2 /*return*/, null];
                    }
                    _c.label = 3;
                case 3:
                    _c.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, apiClient.post('/v1/collaborations/generateSharingLink', payload, {
                            headers: { 'Authorization': "Bearer ".concat(token) }
                        })];
                case 4:
                    response = _c.sent();
                    link = (_a = response.data) === null || _a === void 0 ? void 0 : _a.link;
                    if (link) {
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \u2705 Successfully generated sharing link (Attempt ".concat(attempt, "): ").concat(link));
                        return [2 /*return*/, link];
                    }
                    else {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Link generation successful (Attempt ".concat(attempt, ") but link not found in response."));
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Full generate link response (Attempt ".concat(attempt, "): ").concat(JSON.stringify(response.data)));
                        return [2 /*return*/, null];
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_3 = _c.sent();
                    context = "sharing link generation for project ".concat(projectId, " (Attempt ").concat(attempt, ")");
                    if (axios_1.default.isAxiosError(error_3) && ((_b = error_3.response) === null || _b === void 0 ? void 0 : _b.status) === 401 && attempt < maxAttempts) {
                        logger_1.default.warn("[\uD83E\uDD16 SpeechLab] \u26A0\uFE0F Received 401 Unauthorized on attempt ".concat(attempt, " for link generation. Invalidating token and retrying..."));
                        invalidateAuthToken();
                        attempt++;
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] Generate link payload (Attempt ".concat(attempt, "): ").concat(JSON.stringify(payload))); // Log payload for retry
                        return [3 /*break*/, 1];
                    }
                    else {
                        handleApiError(error_3, context);
                        return [2 /*return*/, null];
                    }
                    return [3 /*break*/, 6];
                case 6: return [3 /*break*/, 1];
                case 7:
                    logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Failed to generate sharing link after ".concat(maxAttempts, " attempts."));
                    return [2 /*return*/, null];
            }
        });
    });
}
/**
 * Gets project details by thirdPartyID to check its status.
 * Returns the *full* project object if found.
 * @param thirdPartyID The thirdPartyID used when creating the project
 * @returns {Promise<Project | null>} Full project object if found, otherwise null
 */
function getProjectByThirdPartyID(thirdPartyID) {
    return __awaiter(this, void 0, void 0, function () {
        var attempt, maxAttempts, encodedThirdPartyID, url, token, response, tempFilePath, project, status_1, error_4, context;
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
        return __generator(this, function (_w) {
            switch (_w.label) {
                case 0:
                    logger_1.default.info("[\uD83E\uDD16 SpeechLab] Getting project status for thirdPartyID: ".concat(thirdPartyID));
                    attempt = 1;
                    maxAttempts = 2;
                    encodedThirdPartyID = encodeURIComponent(thirdPartyID);
                    url = "/v1/projects?sortBy=createdAt%3Aasc&limit=10&page=1&expand=true&thirdPartyIDs=".concat(encodedThirdPartyID);
                    logger_1.default.debug("[\uD83E\uDD16 SpeechLab] \uD83D\uDD0D Fetching project status from API URL (Attempt ".concat(attempt, "): ").concat(API_BASE_URL).concat(url));
                    _w.label = 1;
                case 1:
                    if (!(attempt <= maxAttempts)) return [3 /*break*/, 7];
                    return [4 /*yield*/, getAuthToken()];
                case 2:
                    token = _w.sent();
                    if (!token) {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Cannot check project status (Attempt ".concat(attempt, "): Failed to get authentication token."));
                        return [2 /*return*/, null];
                    }
                    _w.label = 3;
                case 3:
                    _w.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, apiClient.get(url, {
                            headers: { 'Authorization': "Bearer ".concat(token) }
                        })];
                case 4:
                    response = _w.sent();
                    tempFilePath = path_1.default.join(process.cwd(), "temp_api_response_summary_".concat(thirdPartyID, "_attempt_").concat(attempt, ".json"));
                    try {
                        promises_1.default.writeFile(tempFilePath, JSON.stringify({
                            timestamp: new Date().toISOString(),
                            thirdPartyID: thirdPartyID,
                            attempt: attempt, // Add attempt number to summary
                            requestUrl: "".concat(API_BASE_URL).concat(url),
                            responseStatus: response.status,
                            responseTotalResults: (_a = response.data) === null || _a === void 0 ? void 0 : _a.totalResults,
                            responseFirstProjectId: (_d = (_c = (_b = response.data) === null || _b === void 0 ? void 0 : _b.results) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.id,
                            responseFirstProjectStatus: (_h = (_g = (_f = (_e = response.data) === null || _e === void 0 ? void 0 : _e.results) === null || _f === void 0 ? void 0 : _f[0]) === null || _g === void 0 ? void 0 : _g.job) === null || _h === void 0 ? void 0 : _h.status
                        }, null, 2));
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \uD83D\uDCDD Wrote API response summary (Attempt ".concat(attempt, ") to ").concat(tempFilePath));
                    }
                    catch (writeError) {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Failed to write API response summary to file (Attempt ".concat(attempt, "):"), writeError);
                    }
                    if (((_j = response.data) === null || _j === void 0 ? void 0 : _j.results) && response.data.results.length > 0) {
                        project = response.data.results[0];
                        status_1 = ((_k = project.job) === null || _k === void 0 ? void 0 : _k.status) || "UNKNOWN";
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \u2705 (Attempt ".concat(attempt, ") Found project with ID: ").concat(project.id, " for thirdPartyID: ").concat(thirdPartyID));
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \uD83D\uDCCA (Attempt ".concat(attempt, ") Project status: ").concat(status_1));
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \uD83D\uDCCB (Attempt ".concat(attempt, ") Project details: Name: \\\"").concat(((_l = project.job) === null || _l === void 0 ? void 0 : _l.name) || 'Unknown', "\\\", Source: ").concat(((_m = project.job) === null || _m === void 0 ? void 0 : _m.sourceLanguage) || 'Unknown', ", Target: ").concat(((_o = project.job) === null || _o === void 0 ? void 0 : _o.targetLanguage) || 'Unknown'));
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] \uD83D\uDD0D (Attempt ".concat(attempt, ") Found ").concat(((_t = (_s = (_r = (_q = (_p = project.translations) === null || _p === void 0 ? void 0 : _p[0]) === null || _q === void 0 ? void 0 : _q.dub) === null || _r === void 0 ? void 0 : _r[0]) === null || _s === void 0 ? void 0 : _s.medias) === null || _t === void 0 ? void 0 : _t.length) || 0, " media objects in first translation's first dub."));
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] --- FULL PROJECT RESPONSE (Attempt ".concat(attempt, ") ---"));
                        logger_1.default.debug(JSON.stringify(response.data, null, 2));
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] --- END FULL PROJECT RESPONSE (Attempt ".concat(attempt, ") ---"));
                        return [2 /*return*/, project]; // Success! Return the project details
                    }
                    else {
                        logger_1.default.warn("[\uD83E\uDD16 SpeechLab] \u26A0\uFE0F (Attempt ".concat(attempt, ") No projects found matching thirdPartyID: ").concat(thirdPartyID));
                        if (((_u = response.data) === null || _u === void 0 ? void 0 : _u.totalResults) !== undefined) {
                            logger_1.default.warn("[\uD83E\uDD16 SpeechLab] API reported ".concat(response.data.totalResults, " total results for this query (Attempt ").concat(attempt, ")."));
                        }
                        return [2 /*return*/, null]; // No project found, but API call succeeded
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_4 = _w.sent();
                    context = "getting project status for thirdPartyID: ".concat(thirdPartyID, " (Attempt ").concat(attempt, ")");
                    if (axios_1.default.isAxiosError(error_4) && ((_v = error_4.response) === null || _v === void 0 ? void 0 : _v.status) === 401 && attempt < maxAttempts) {
                        logger_1.default.warn("[\uD83E\uDD16 SpeechLab] \u26A0\uFE0F Received 401 Unauthorized on attempt ".concat(attempt, " for project status check. Invalidating token and retrying..."));
                        invalidateAuthToken();
                        attempt++;
                        logger_1.default.debug("[\uD83E\uDD16 SpeechLab] \uD83D\uDD0D Fetching project status from API URL (Attempt ".concat(attempt, "): ").concat(API_BASE_URL).concat(url)); // Log URL for retry
                        return [3 /*break*/, 1];
                    }
                    else {
                        handleApiError(error_4, context);
                        return [2 /*return*/, null];
                    }
                    return [3 /*break*/, 6];
                case 6: return [3 /*break*/, 1];
                case 7:
                    logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Failed to get project status for ".concat(thirdPartyID, " after ").concat(maxAttempts, " attempts."));
                    return [2 /*return*/, null];
            }
        });
    });
}
/**
 * Waits for a project to reach COMPLETE status, checking at regular intervals.
 * @param thirdPartyID The thirdPartyID of the project to monitor
 * @param maxWaitTimeMs Maximum time to wait in milliseconds (default: 1 hour)
 * @param checkIntervalMs Interval between status checks in milliseconds (default: 30 seconds)
 * @returns {Promise<Project | null>} The full project object if completed successfully, otherwise null
 */
function waitForProjectCompletion(thirdPartyID_1) {
    return __awaiter(this, arguments, void 0, function (thirdPartyID, maxWaitTimeMs, // 1 hour default
    checkIntervalMs // 30 seconds default
    ) {
        var startTime, pollCount, lastProjectDetails, elapsedSeconds, project, elapsedMinutes, status_2, progressPercent, remainingTimeEstimate, elapsedMs, estimatedTotalMs, estimatedRemainingMs, estimatedRemainingMin, maxWaitMinutes;
        var _a, _b, _c, _d;
        if (maxWaitTimeMs === void 0) { maxWaitTimeMs = 60 * 60 * 1000; }
        if (checkIntervalMs === void 0) { checkIntervalMs = 30000; }
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    logger_1.default.info("[\uD83E\uDD16 SpeechLab] Waiting for project completion: ".concat(thirdPartyID));
                    logger_1.default.info("[\uD83E\uDD16 SpeechLab] Maximum wait time: ".concat(maxWaitTimeMs / 1000 / 60, " minutes, Check interval: ").concat(checkIntervalMs / 1000, " seconds"));
                    startTime = Date.now();
                    pollCount = 0;
                    lastProjectDetails = null;
                    _e.label = 1;
                case 1:
                    if (!(Date.now() - startTime < maxWaitTimeMs)) return [3 /*break*/, 4];
                    pollCount++;
                    elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83E\uDD16 SpeechLab] \uD83D\uDD04 Poll #".concat(pollCount, " - Checking project status (").concat(elapsedSeconds, "s elapsed)..."));
                    return [4 /*yield*/, getProjectByThirdPartyID(thirdPartyID)];
                case 2:
                    project = _e.sent();
                    lastProjectDetails = project; // Store the latest result
                    if (!project) {
                        logger_1.default.warn("[\uFFFD\uFFFD SpeechLab] \u26A0\uFE0F Poll #".concat(pollCount, " - Could not retrieve project details, will retry in ").concat(checkIntervalMs / 1000, "s..."));
                    }
                    else if (((_a = project.job) === null || _a === void 0 ? void 0 : _a.status) === "COMPLETE") {
                        elapsedMinutes = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \u2705 Poll #".concat(pollCount, " - Project completed successfully after ").concat(elapsedMinutes, " minutes!"));
                        return [2 /*return*/, project]; // Return the full project object on success
                    }
                    else if (((_b = project.job) === null || _b === void 0 ? void 0 : _b.status) === "FAILED") {
                        logger_1.default.error("[\uD83E\uDD16 SpeechLab] \u274C Poll #".concat(pollCount, " - Project failed to process!"));
                        return [2 /*return*/, null]; // Return null on failure
                    }
                    else {
                        status_2 = ((_c = project.job) === null || _c === void 0 ? void 0 : _c.status) || "UNKNOWN";
                        progressPercent = status_2 === "PROCESSING" ? 50 : 0;
                        remainingTimeEstimate = "unknown";
                        if (progressPercent > 0) {
                            elapsedMs = Date.now() - startTime;
                            estimatedTotalMs = (elapsedMs / progressPercent) * 100;
                            estimatedRemainingMs = estimatedTotalMs - elapsedMs;
                            estimatedRemainingMin = Math.ceil(estimatedRemainingMs / 1000 / 60);
                            remainingTimeEstimate = "~".concat(estimatedRemainingMin, " minutes");
                        }
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \uD83D\uDD52 Poll #".concat(pollCount, " - Project status: ").concat(status_2, ", Progress: ").concat(progressPercent, "%, Estimated time remaining: ").concat(remainingTimeEstimate));
                        logger_1.default.info("[\uD83E\uDD16 SpeechLab] \u23F3 Poll #".concat(pollCount, " - Will check again in ").concat(checkIntervalMs / 1000, "s..."));
                    }
                    logger_1.default.debug("[\uD83E\uDD16 SpeechLab] \uD83D\uDCA4 Poll #".concat(pollCount, " - Sleeping for ").concat(checkIntervalMs / 1000, "s before next check..."));
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, checkIntervalMs); })];
                case 3:
                    _e.sent();
                    return [3 /*break*/, 1];
                case 4:
                    maxWaitMinutes = (maxWaitTimeMs / 1000 / 60).toFixed(1);
                    logger_1.default.warn("[\uD83E\uDD16 SpeechLab] \u23F0 Poll #".concat(pollCount, " - Maximum wait time of ").concat(maxWaitMinutes, " minutes exceeded without project completion."));
                    return [2 /*return*/, ((_d = lastProjectDetails === null || lastProjectDetails === void 0 ? void 0 : lastProjectDetails.job) === null || _d === void 0 ? void 0 : _d.status) === "COMPLETE" ? lastProjectDetails : null]; // Return last details only if complete, else null
            }
        });
    });
}
