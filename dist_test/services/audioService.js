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
exports.downloadAndUploadAudio = downloadAndUploadAudio;
exports.uploadLocalFileToS3 = uploadLocalFileToS3;
exports.downloadAndUploadVideo = downloadAndUploadVideo;
var child_process_1 = require("child_process");
var fs = __importStar(require("fs"));
var fs_1 = require("fs");
var path = __importStar(require("path"));
var client_s3_1 = require("@aws-sdk/client-s3");
var config_1 = require("../utils/config");
var logger_1 = __importDefault(require("../utils/logger"));
var uuid_1 = require("uuid"); // Using uuid for unique filenames
// Configure AWS S3 Client
// The SDK automatically picks up credentials from environment variables, EC2 instance profiles, etc.
// Region can be optionally specified if not default or in env variables.
var s3Client = new client_s3_1.S3Client({ region: config_1.config.AWS_REGION }); // Use region from config if available
var TEMP_DIR = path.join(process.cwd(), 'temp_audio'); // Define a directory for temporary downloads
var TEMP_VIDEO_DIR = path.join(process.cwd(), 'temp_video'); // Define a directory for temporary video downloads
/**
 * Ensures the temporary directory for audio downloads exists.
 */
function ensureTempDirExists() {
    if (!fs.existsSync(TEMP_DIR)) {
        logger_1.default.debug("[\uD83C\uDFA7 Audio] Creating temporary directory: ".concat(TEMP_DIR));
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}
/**
 * Ensures the temporary directory for video downloads exists.
 */
function ensureTempVideoDirExists() {
    if (!fs.existsSync(TEMP_VIDEO_DIR)) {
        logger_1.default.debug("[\uD83C\uDFAC Video] Creating temporary directory: ".concat(TEMP_VIDEO_DIR));
        fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });
    }
}
/**
 * Executes the ffmpeg command to download and convert the M3U8 stream.
 * @param m3u8Url URL of the M3U8 playlist.
 * @param outputFilePath Path where the downloaded audio file should be saved.
 * @returns Promise that resolves on successful download, rejects on error.
 */
function runFfmpegDownload(m3u8Url, outputFilePath) {
    return new Promise(function (resolve, reject) {
        var ffmpegArgs = [
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-i', m3u8Url,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-y',
            outputFilePath
        ];
        // Log the full ffmpeg command prominently
        var ffmpegCommand = "ffmpeg ".concat(ffmpegArgs.join(' '));
        logger_1.default.info('-------------------------------------------');
        logger_1.default.info("[\uD83C\uDFA7 Audio] EXECUTING FFMPEG COMMAND:");
        logger_1.default.info(ffmpegCommand);
        logger_1.default.info('-------------------------------------------');
        // Create timestamps for progress tracking
        var startTime = Date.now();
        var lastProgressUpdate = startTime;
        var lastProgressTimestamp = 0; // Last timestamp reported by ffmpeg
        var duration = 0; // Duration in seconds (will be determined from ffmpeg)
        var totalSize = 0; // Keep track of estimated total size
        var progressLogCounter = 0; // Count progress logs to throttle output
        logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDD52 Download started at ".concat(new Date().toISOString()));
        var ffmpegProcess = (0, child_process_1.spawn)('ffmpeg', ffmpegArgs);
        var ffmpegOutput = '';
        ffmpegProcess.stdout.on('data', function (data) {
            var output = data.toString();
            ffmpegOutput += output;
            // Parse progress information from ffmpeg
            var time = /time=(\d+:\d+:\d+\.\d+)/g.exec(output);
            var size = /size=\s*(\d+)kB/g.exec(output);
            var speed = /speed=\s*(\d+\.\d+)x/g.exec(output);
            if (time) {
                var timeStr = time[1];
                var _a = timeStr.split(':').map(parseFloat), hours = _a[0], minutes = _a[1], seconds = _a[2];
                var currentTimestamp = Math.floor(hours * 3600 + minutes * 60 + seconds);
                // Only log progress every 5 seconds of media time or after 10 seconds of real time
                var currentTime = Date.now();
                var realTimeElapsed = currentTime - lastProgressUpdate;
                var mediaTimeElapsed = currentTimestamp - lastProgressTimestamp;
                if (mediaTimeElapsed >= 5 || realTimeElapsed >= 10000 || progressLogCounter % 10 === 0) {
                    if (size) {
                        totalSize = parseInt(size[1], 10); // Size in kB
                        var downloadedMB = (totalSize / 1024).toFixed(2);
                        var elapsedSeconds = (currentTime - startTime) / 1000;
                        var downloadRateMBps = (totalSize / 1024 / elapsedSeconds).toFixed(2);
                        logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDCE5 Progress - Time: ".concat(timeStr, ", Downloaded: ").concat(downloadedMB, " MB, Rate: ").concat(downloadRateMBps, " MB/s"));
                        if (speed) {
                            logger_1.default.debug("[\uD83C\uDFA7 Audio] Processing speed: ".concat(speed[1], "x"));
                        }
                    }
                    else {
                        logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDCE5 Progress - Time: ".concat(timeStr));
                    }
                    lastProgressUpdate = currentTime;
                    lastProgressTimestamp = currentTimestamp;
                }
                progressLogCounter++;
            }
        });
        ffmpegProcess.stderr.on('data', function (data) {
            var output = data.toString();
            ffmpegOutput += output;
            // Parse duration information
            var durationMatch = /Duration: (\d+:\d+:\d+\.\d+)/g.exec(output);
            if (durationMatch) {
                var durationStr = durationMatch[1];
                var _a = durationStr.split(':').map(parseFloat), hours = _a[0], minutes = _a[1], seconds = _a[2];
                duration = Math.floor(hours * 3600 + minutes * 60 + seconds);
                logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDD52 Detected media duration: ".concat(durationStr, " (").concat(duration, " seconds)"));
            }
            // Only log stderr for important messages, not every frame
            if (!output.includes("frame=") && !output.includes("size=")) {
                logger_1.default.debug("[\uD83C\uDFA7 Audio] ffmpeg: ".concat(output.trim()));
            }
        });
        ffmpegProcess.on('close', function (code) {
            var endTime = Date.now();
            var elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
            if (code === 0) {
                // Get file size
                try {
                    var stats = fs.statSync(outputFilePath);
                    var fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2705 Download completed in ".concat(elapsedSeconds, "s. File size: ").concat(fileSizeMB, " MB"));
                }
                catch (err) {
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2705 Download completed in ".concat(elapsedSeconds, "s"));
                }
                resolve();
            }
            else {
                logger_1.default.error("[\uD83C\uDFA7 Audio] \u274C ffmpeg process exited with code ".concat(code, " after ").concat(elapsedSeconds, "s"));
                logger_1.default.error("[\uD83C\uDFA7 Audio] ffmpeg output: \n".concat(ffmpegOutput));
                reject(new Error("ffmpeg failed with code ".concat(code)));
            }
        });
        ffmpegProcess.on('error', function (err) {
            logger_1.default.error("[\uD83C\uDFA7 Audio] \u274C Failed to start ffmpeg process for URL: ".concat(m3u8Url), err);
            reject(err);
        });
    });
}
/**
 * Uploads a file to the configured S3 bucket.
 * @param localFilePath Path to the local file to upload.
 * @param s3Key The desired key (filename) for the object in S3.
 * @returns Promise resolving with the public URL of the uploaded object.
 */
function uploadToS3(localFilePath, s3Key) {
    return __awaiter(this, void 0, void 0, function () {
        var MAX_RETRIES, attempt, lastError, errorMsg, stats, fileSizeMB, fileSizeBytes, errorMsg, _loop_1, state_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    MAX_RETRIES = 3;
                    attempt = 0;
                    lastError = null;
                    // Verify file exists before attempting upload
                    if (!fs.existsSync(localFilePath)) {
                        errorMsg = "[\uD83C\uDFA7 Audio] \u274C ERROR: File does not exist at path: ".concat(localFilePath);
                        logger_1.default.error(errorMsg);
                        throw new Error(errorMsg);
                    }
                    stats = fs.statSync(localFilePath);
                    fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                    fileSizeBytes = stats.size;
                    // Validate file has actual content
                    if (fileSizeBytes <= 0) {
                        errorMsg = "[\uD83C\uDFA7 Audio] \u274C ERROR: File exists but has zero bytes: ".concat(localFilePath);
                        logger_1.default.error(errorMsg);
                        throw new Error(errorMsg);
                    }
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2705 VERIFICATION: File exists at path: ".concat(localFilePath));
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDCCA FILE INFO: Size: ".concat(fileSizeMB, " MB (").concat(fileSizeBytes, " bytes), Created: ").concat(stats.birthtime));
                    _loop_1 = function () {
                        var startTime, fileBuffer, uploadParams, command, region, _b, publicUrl, endTime, elapsedSeconds, error_1, delayMs_1;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    attempt++;
                                    _c.label = 1;
                                case 1:
                                    _c.trys.push([1, 5, , 8]);
                                    logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDCE4 Starting S3 upload (attempt ".concat(attempt, "/").concat(MAX_RETRIES, "): ").concat(localFilePath, " (").concat(fileSizeMB, " MB) to key: ").concat(s3Key));
                                    startTime = Date.now();
                                    fileBuffer = fs.readFileSync(localFilePath);
                                    uploadParams = {
                                        Bucket: config_1.config.AWS_S3_BUCKET,
                                        Key: s3Key,
                                        Body: fileBuffer,
                                        ContentType: 'audio/aac', // Set content type to audio/aac
                                    };
                                    logger_1.default.debug("[\uD83C\uDFA7 Audio] \uD83D\uDCCB Uploading to bucket: ".concat(config_1.config.AWS_S3_BUCKET));
                                    command = new client_s3_1.PutObjectCommand(uploadParams);
                                    return [4 /*yield*/, s3Client.send(command)];
                                case 2:
                                    _c.sent();
                                    _b = config_1.config.AWS_REGION;
                                    if (_b) return [3 /*break*/, 4];
                                    return [4 /*yield*/, s3Client.config.region()];
                                case 3:
                                    _b = (_c.sent());
                                    _c.label = 4;
                                case 4:
                                    region = _b || 'us-east-1';
                                    publicUrl = "https://".concat(config_1.config.AWS_S3_BUCKET, ".s3.").concat(region, ".amazonaws.com/").concat(s3Key);
                                    endTime = Date.now();
                                    elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
                                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2705 S3 upload successful (".concat(elapsedSeconds, "s). Public URL: ").concat(publicUrl));
                                    return [2 /*return*/, { value: publicUrl }];
                                case 5:
                                    error_1 = _c.sent();
                                    lastError = error_1;
                                    logger_1.default.error("[\uD83C\uDFA7 Audio] \u274C S3 upload attempt ".concat(attempt, "/").concat(MAX_RETRIES, " failed:"), error_1);
                                    if (!(attempt < MAX_RETRIES)) return [3 /*break*/, 7];
                                    delayMs_1 = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
                                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u23F3 Retrying in ".concat((delayMs_1 / 1000).toFixed(1), "s..."));
                                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, delayMs_1); })];
                                case 6:
                                    _c.sent();
                                    _c.label = 7;
                                case 7: return [3 /*break*/, 8];
                                case 8: return [2 /*return*/];
                            }
                        });
                    };
                    _a.label = 1;
                case 1:
                    if (!(attempt < MAX_RETRIES)) return [3 /*break*/, 3];
                    return [5 /*yield**/, _loop_1()];
                case 2:
                    state_1 = _a.sent();
                    if (typeof state_1 === "object")
                        return [2 /*return*/, state_1.value];
                    return [3 /*break*/, 1];
                case 3:
                    // If we get here, all attempts failed
                    logger_1.default.error("[\uD83C\uDFA7 Audio] \u274C All ".concat(MAX_RETRIES, " S3 upload attempts failed for key: ").concat(s3Key));
                    throw new Error("S3 upload failed after ".concat(MAX_RETRIES, " attempts: ").concat(lastError instanceof Error ? lastError.message : String(lastError)));
            }
        });
    });
}
/**
 * Downloads audio from an M3U8 URL using ffmpeg and uploads it to S3.
 * @param m3u8Url The URL of the M3U8 playlist.
 * @param spaceName Optional name for the space, used for naming the S3 file.
 * @returns Promise resolving with the public S3 URL of the uploaded audio.
 */
function downloadAndUploadAudio(m3u8Url, spaceName) {
    return __awaiter(this, void 0, void 0, function () {
        var uniqueId, sanitizedNamePart, outputFilename, localFilePath, s3Key, downloadStartTime, downloadEndTime, downloadElapsedSec, uploadStartTime, publicUrl, uploadEndTime, uploadElapsedSec, totalElapsedSec, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    ensureTempDirExists();
                    uniqueId = (0, uuid_1.v4)();
                    sanitizedNamePart = spaceName ? spaceName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) : uniqueId;
                    outputFilename = "".concat(sanitizedNamePart, "_").concat(uniqueId, ".aac");
                    localFilePath = path.join(TEMP_DIR, outputFilename);
                    s3Key = "twitter-space-audio/".concat(outputFilename);
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDD04 Processing Twitter Space \"".concat(spaceName || 'Unnamed Space', "\""));
                    logger_1.default.info("[\uD83C\uDFA7 Audio] Output filename: ".concat(outputFilename));
                    logger_1.default.info("[\uD83C\uDFA7 Audio] Download queue initialized");
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    // Step 1: Download using ffmpeg
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDD3D Step 1/3: Downloading audio stream...");
                    downloadStartTime = Date.now();
                    return [4 /*yield*/, runFfmpegDownload(m3u8Url, localFilePath)];
                case 2:
                    _a.sent();
                    downloadEndTime = Date.now();
                    downloadElapsedSec = ((downloadEndTime - downloadStartTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2713 Download step completed in ".concat(downloadElapsedSec, "s"));
                    // Step 2: Upload the downloaded file to S3
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDD3C Step 2/3: Uploading to S3...");
                    uploadStartTime = Date.now();
                    return [4 /*yield*/, uploadToS3(localFilePath, s3Key)];
                case 3:
                    publicUrl = _a.sent();
                    uploadEndTime = Date.now();
                    uploadElapsedSec = ((uploadEndTime - uploadStartTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2713 Upload step completed in ".concat(uploadElapsedSec, "s"));
                    // Step 3: Clean up the local temporary file
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \uD83D\uDDD1\uFE0F Step 3/3: Cleaning up temporary file...");
                    fs.unlink(localFilePath, function (err) {
                        if (err) {
                            logger_1.default.warn("[\uD83C\uDFA7 Audio] \u26A0\uFE0F Failed to delete temporary file ".concat(localFilePath, ":"), err);
                        }
                        else {
                            logger_1.default.info("[\uD83C\uDFA7 Audio] \u2713 Successfully deleted temporary file");
                        }
                    });
                    totalElapsedSec = ((Date.now() - downloadStartTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83C\uDFA7 Audio] \u2705 Audio processing completed in ".concat(totalElapsedSec, "s"));
                    return [2 /*return*/, publicUrl];
                case 4:
                    error_2 = _a.sent();
                    logger_1.default.error("[\uD83C\uDFA7 Audio] \u274C Failed to process audio for ".concat(m3u8Url, ":"), error_2);
                    // Attempt cleanup even on error
                    if (fs.existsSync(localFilePath)) {
                        logger_1.default.debug("[\uD83C\uDFA7 Audio] Cleaning up temporary file after error: ".concat(localFilePath));
                        fs.unlink(localFilePath, function (err) {
                            if (err)
                                logger_1.default.warn("[\uD83C\uDFA7 Audio] Failed to delete temporary file ".concat(localFilePath, " after error:"), err);
                        });
                    }
                    return [2 /*return*/, null]; // Indicate failure
                case 5: return [2 /*return*/];
            }
        });
    });
}
/**
 * Uploads a locally stored file to the configured S3 public bucket.
 * @param localFilePath Path to the local file to upload.
 * @param s3Key The desired key (filename including any prefixes) for the object in S3.
 * @returns Promise resolving with the public URL of the uploaded object, or null on failure.
 */
function uploadLocalFileToS3(localFilePath, s3Key) {
    return __awaiter(this, void 0, void 0, function () {
        var MAX_RETRIES, attempt, lastError, stats, fileSizeMB, fileBuffer, contentType, ext, _loop_2, state_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    MAX_RETRIES = 3;
                    attempt = 0;
                    lastError = null;
                    logger_1.default.info("[\u2601\uFE0F S3] Attempting to upload local file to S3.");
                    logger_1.default.debug("[\u2601\uFE0F S3]   Local Path: ".concat(localFilePath));
                    logger_1.default.debug("[\u2601\uFE0F S3]   Target Key: ".concat(s3Key));
                    logger_1.default.debug("[\u2601\uFE0F S3]   Target Bucket: ".concat(config_1.config.AWS_S3_BUCKET));
                    try {
                        if (!fs.existsSync(localFilePath)) {
                            logger_1.default.error("[\u2601\uFE0F S3] \u274C File does not exist at local path: ".concat(localFilePath));
                            return [2 /*return*/, null];
                        }
                        stats = fs.statSync(localFilePath);
                        if (stats.size <= 0) {
                            logger_1.default.error("[\u2601\uFE0F S3] \u274C File exists but has zero bytes: ".concat(localFilePath));
                            return [2 /*return*/, null];
                        }
                        fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                        logger_1.default.info("[\u2601\uFE0F S3] File verified locally (".concat(fileSizeMB, " MB). Proceeding with upload attempts..."));
                    }
                    catch (error) {
                        logger_1.default.error("[\u2601\uFE0F S3] \u274C Error accessing local file ".concat(localFilePath, ":"), error);
                        return [2 /*return*/, null];
                    }
                    return [4 /*yield*/, fs_1.promises.readFile(localFilePath)];
                case 1:
                    fileBuffer = _a.sent();
                    contentType = 'application/octet-stream';
                    ext = path.extname(localFilePath).toLowerCase();
                    if (ext === '.mp3')
                        contentType = 'audio/mpeg';
                    else if (ext === '.aac')
                        contentType = 'audio/aac';
                    else if (ext === '.mp4')
                        contentType = 'video/mp4';
                    logger_1.default.debug("[\u2601\uFE0F S3] Determined Content-Type: ".concat(contentType));
                    _loop_2 = function () {
                        var startTime, uploadParams, command, region, _b, publicUrl, endTime, elapsedSeconds, error_3, delayMs_2;
                        return __generator(this, function (_c) {
                            switch (_c.label) {
                                case 0:
                                    attempt++;
                                    _c.label = 1;
                                case 1:
                                    _c.trys.push([1, 5, , 8]);
                                    logger_1.default.info("[\u2601\uFE0F S3] Starting upload attempt ".concat(attempt, "/").concat(MAX_RETRIES, "..."));
                                    startTime = Date.now();
                                    uploadParams = {
                                        Bucket: config_1.config.AWS_S3_BUCKET,
                                        Key: s3Key,
                                        Body: fileBuffer, // Use buffer instead of stream
                                        ContentType: contentType,
                                        // Consider adding ACL: 'public-read' if bucket policy doesn't automatically make it public
                                        // ACL: 'public-read'
                                    };
                                    command = new client_s3_1.PutObjectCommand(uploadParams);
                                    return [4 /*yield*/, s3Client.send(command)];
                                case 2:
                                    _c.sent();
                                    _b = config_1.config.AWS_REGION;
                                    if (_b) return [3 /*break*/, 4];
                                    return [4 /*yield*/, s3Client.config.region()];
                                case 3:
                                    _b = (_c.sent());
                                    _c.label = 4;
                                case 4:
                                    region = _b || 'us-east-1';
                                    publicUrl = "https://".concat(config_1.config.AWS_S3_BUCKET, ".s3.").concat(region, ".amazonaws.com/").concat(s3Key);
                                    endTime = Date.now();
                                    elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
                                    logger_1.default.info("[\u2601\uFE0F S3] \u2705 S3 upload successful (attempt ".concat(attempt, ", ").concat(elapsedSeconds, "s). Public URL: ").concat(publicUrl));
                                    return [2 /*return*/, { value: publicUrl }];
                                case 5:
                                    error_3 = _c.sent();
                                    lastError = error_3;
                                    logger_1.default.error("[\u2601\uFE0F S3] \u274C S3 upload attempt ".concat(attempt, "/").concat(MAX_RETRIES, " failed:"), error_3);
                                    if (!(attempt < MAX_RETRIES)) return [3 /*break*/, 7];
                                    delayMs_2 = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
                                    logger_1.default.info("[\u2601\uFE0F S3] \u23F3 Retrying in ".concat((delayMs_2 / 1000).toFixed(1), "s..."));
                                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, delayMs_2); })];
                                case 6:
                                    _c.sent();
                                    _c.label = 7;
                                case 7: return [3 /*break*/, 8];
                                case 8: return [2 /*return*/];
                            }
                        });
                    };
                    _a.label = 2;
                case 2:
                    if (!(attempt < MAX_RETRIES)) return [3 /*break*/, 4];
                    return [5 /*yield**/, _loop_2()];
                case 3:
                    state_2 = _a.sent();
                    if (typeof state_2 === "object")
                        return [2 /*return*/, state_2.value];
                    return [3 /*break*/, 2];
                case 4:
                    logger_1.default.error("[\u2601\uFE0F S3] \u274C All ".concat(MAX_RETRIES, " S3 upload attempts failed for key: ").concat(s3Key));
                    return [2 /*return*/, null]; // Return null if all retries fail
            }
        });
    });
}
/**
 * Executes the ffmpeg command to download and convert the M3U8 video stream.
 * @param m3u8Url URL of the M3U8 playlist for video.
 * @param outputFilePath Path where the downloaded video file should be saved.
 * @returns Promise that resolves on successful download, rejects on error.
 */
function runFfmpegVideoDownload(m3u8Url, outputFilePath) {
    return new Promise(function (resolve, reject) {
        var ffmpegArgs = [
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-i', m3u8Url,
            '-c:v', 'libx264', // Video codec: H.264 for Twitter compatibility
            '-c:a', 'aac', // Audio codec: AAC
            '-movflags', '+faststart', // Optimize for web streaming
            '-preset', 'medium', // Balance between speed and quality
            '-crf', '23', // Constant Rate Factor (quality: 18-28, lower is better)
            '-y', // Overwrite output file
            outputFilePath
        ];
        var ffmpegCommand = "ffmpeg ".concat(ffmpegArgs.join(' '));
        logger_1.default.info('-------------------------------------------');
        logger_1.default.info("[\uD83C\uDFAC Video] EXECUTING FFMPEG COMMAND:");
        logger_1.default.info(ffmpegCommand);
        logger_1.default.info('-------------------------------------------');
        var startTime = Date.now();
        var lastProgressUpdate = startTime;
        var lastProgressTimestamp = 0;
        var progressLogCounter = 0;
        logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDD52 Video download started at ".concat(new Date().toISOString()));
        var ffmpegProcess = (0, child_process_1.spawn)('ffmpeg', ffmpegArgs);
        var ffmpegOutput = '';
        ffmpegProcess.stdout.on('data', function (data) {
            var output = data.toString();
            ffmpegOutput += output;
            // Parse progress information from ffmpeg
            var time = /time=(\d+:\d+:\d+\.\d+)/g.exec(output);
            var size = /size=\s*(\d+)kB/g.exec(output);
            var speed = /speed=\s*(\d+\.\d+)x/g.exec(output);
            if (time) {
                var timeStr = time[1];
                var _a = timeStr.split(':').map(parseFloat), hours = _a[0], minutes = _a[1], seconds = _a[2];
                var currentTimestamp = Math.floor(hours * 3600 + minutes * 60 + seconds);
                var currentTime = Date.now();
                var realTimeElapsed = currentTime - lastProgressUpdate;
                var mediaTimeElapsed = currentTimestamp - lastProgressTimestamp;
                if (mediaTimeElapsed >= 5 || realTimeElapsed >= 10000 || progressLogCounter % 10 === 0) {
                    if (size) {
                        var totalSize = parseInt(size[1], 10);
                        var downloadedMB = (totalSize / 1024).toFixed(2);
                        var elapsedSeconds = (currentTime - startTime) / 1000;
                        var downloadRateMBps = (totalSize / 1024 / elapsedSeconds).toFixed(2);
                        logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDCE5 Progress - Time: ".concat(timeStr, ", Downloaded: ").concat(downloadedMB, " MB, Rate: ").concat(downloadRateMBps, " MB/s"));
                        if (speed) {
                            logger_1.default.debug("[\uD83C\uDFAC Video] Processing speed: ".concat(speed[1], "x"));
                        }
                    }
                    else {
                        logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDCE5 Progress - Time: ".concat(timeStr));
                    }
                    lastProgressUpdate = currentTime;
                    lastProgressTimestamp = currentTimestamp;
                }
                progressLogCounter++;
            }
        });
        ffmpegProcess.stderr.on('data', function (data) {
            var output = data.toString();
            ffmpegOutput += output;
            // FFmpeg writes progress to stderr, so parse it here too
            var time = /time=(\d+:\d+:\d+\.\d+)/g.exec(output);
            var size = /size=\s*(\d+)kB/g.exec(output);
            var speed = /speed=\s*(\d+\.\d+)x/g.exec(output);
            if (time) {
                var timeStr = time[1];
                var _a = timeStr.split(':').map(parseFloat), hours = _a[0], minutes = _a[1], seconds = _a[2];
                var currentTimestamp = Math.floor(hours * 3600 + minutes * 60 + seconds);
                var currentTime = Date.now();
                var realTimeElapsed = currentTime - lastProgressUpdate;
                var mediaTimeElapsed = currentTimestamp - lastProgressTimestamp;
                if (mediaTimeElapsed >= 5 || realTimeElapsed >= 10000 || progressLogCounter % 10 === 0) {
                    if (size) {
                        var totalSize = parseInt(size[1], 10);
                        var downloadedMB = (totalSize / 1024).toFixed(2);
                        var elapsedSeconds = (currentTime - startTime) / 1000;
                        var downloadRateMBps = (totalSize / 1024 / elapsedSeconds).toFixed(2);
                        logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDCE5 Progress - Time: ".concat(timeStr, ", Downloaded: ").concat(downloadedMB, " MB, Rate: ").concat(downloadRateMBps, " MB/s"));
                        if (speed) {
                            logger_1.default.debug("[\uD83C\uDFAC Video] Processing speed: ".concat(speed[1], "x"));
                        }
                    }
                    else {
                        logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDCE5 Progress - Time: ".concat(timeStr));
                    }
                    lastProgressUpdate = currentTime;
                    lastProgressTimestamp = currentTimestamp;
                }
                progressLogCounter++;
            }
        });
        ffmpegProcess.on('close', function (code) {
            var elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            logger_1.default.info("[\uD83C\uDFAC Video] \u23F1\uFE0F FFmpeg process finished in ".concat(elapsedTime, "s with code ").concat(code));
            if (code === 0) {
                // Check if output file was created and has content
                if (fs.existsSync(outputFilePath)) {
                    var stats = fs.statSync(outputFilePath);
                    var fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                    logger_1.default.info("[\uD83C\uDFAC Video] \u2705 Video downloaded successfully! Size: ".concat(fileSizeMB, " MB"));
                    resolve();
                }
                else {
                    logger_1.default.error('[🎬 Video] ❌ FFmpeg exited with code 0 but output file does not exist.');
                    reject(new Error('Video file not created despite successful FFmpeg exit'));
                }
            }
            else {
                logger_1.default.error("[\uD83C\uDFAC Video] \u274C FFmpeg exited with non-zero code: ".concat(code));
                logger_1.default.error("[\uD83C\uDFAC Video] FFmpeg output (last 500 chars): ".concat(ffmpegOutput.slice(-500)));
                reject(new Error("FFmpeg failed with exit code ".concat(code)));
            }
        });
        ffmpegProcess.on('error', function (err) {
            logger_1.default.error('[🎬 Video] ❌ FFmpeg process error:', err);
            reject(err);
        });
    });
}
/**
 * Downloads a video from M3U8 URL using FFmpeg and uploads to S3.
 * Similar to downloadAndUploadAudio but handles video streams.
 * @param m3u8Url The M3U8 video stream URL to download.
 * @param fileName Descriptive name for the video (used for output filename).
 * @returns Promise resolving with the public S3 URL of the uploaded video, or null on failure.
 */
function downloadAndUploadVideo(m3u8Url, fileName) {
    return __awaiter(this, void 0, void 0, function () {
        var sanitizedName, timestamp, outputFilename, localFilePath, s3Key, downloadStartTime, downloadEndTime, downloadElapsedSec, uploadStartTime, publicUrl, uploadEndTime, uploadElapsedSec, totalElapsedSec, error_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    ensureTempDirExists();
                    sanitizedName = fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
                    timestamp = Date.now();
                    outputFilename = "".concat(sanitizedName, "_").concat(timestamp, ".mp4");
                    localFilePath = path.join(TEMP_DIR, outputFilename);
                    s3Key = "twitter-video/".concat(outputFilename);
                    logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDD04 Processing video \"".concat(fileName, "\""));
                    logger_1.default.info("[\uD83C\uDFAC Video] Output filename: ".concat(outputFilename));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    // Step 1: Download video using ffmpeg
                    logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDD3D Step 1/3: Downloading video stream...");
                    downloadStartTime = Date.now();
                    return [4 /*yield*/, runFfmpegVideoDownload(m3u8Url, localFilePath)];
                case 2:
                    _a.sent();
                    downloadEndTime = Date.now();
                    downloadElapsedSec = ((downloadEndTime - downloadStartTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83C\uDFAC Video] \u2713 Download step completed in ".concat(downloadElapsedSec, "s"));
                    // Step 2: Upload the downloaded video to S3
                    logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDD3C Step 2/3: Uploading to S3...");
                    uploadStartTime = Date.now();
                    return [4 /*yield*/, uploadLocalFileToS3(localFilePath, s3Key)];
                case 3:
                    publicUrl = _a.sent();
                    uploadEndTime = Date.now();
                    uploadElapsedSec = ((uploadEndTime - uploadStartTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83C\uDFAC Video] \u2713 Upload step completed in ".concat(uploadElapsedSec, "s"));
                    if (!publicUrl) {
                        throw new Error('S3 upload returned null');
                    }
                    // Step 3: Clean up the local temporary file
                    logger_1.default.info("[\uD83C\uDFAC Video] \uD83D\uDDD1\uFE0F Step 3/3: Cleaning up temporary file...");
                    fs.unlink(localFilePath, function (err) {
                        if (err) {
                            logger_1.default.warn("[\uD83C\uDFAC Video] \u26A0\uFE0F Failed to delete temporary file ".concat(localFilePath, ":"), err);
                        }
                        else {
                            logger_1.default.info("[\uD83C\uDFAC Video] \u2713 Successfully deleted temporary file");
                        }
                    });
                    totalElapsedSec = ((Date.now() - downloadStartTime) / 1000).toFixed(1);
                    logger_1.default.info("[\uD83C\uDFAC Video] \u2705 Video processing completed in ".concat(totalElapsedSec, "s"));
                    return [2 /*return*/, publicUrl];
                case 4:
                    error_4 = _a.sent();
                    logger_1.default.error("[\uD83C\uDFAC Video] \u274C Failed to process video for ".concat(m3u8Url, ":"), error_4);
                    // Attempt cleanup even on error
                    if (fs.existsSync(localFilePath)) {
                        logger_1.default.debug("[\uD83C\uDFAC Video] Cleaning up temporary file after error: ".concat(localFilePath));
                        fs.unlink(localFilePath, function (err) {
                            if (err)
                                logger_1.default.warn("[\uD83C\uDFAC Video] Failed to delete temporary file ".concat(localFilePath, " after error:"), err);
                        });
                    }
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
