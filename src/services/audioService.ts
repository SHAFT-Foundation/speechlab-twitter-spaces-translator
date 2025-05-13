import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand, PutObjectCommandInput, S3ClientConfig } from "@aws-sdk/client-s3";
import { config } from '../utils/config';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid'; // Using uuid for unique filenames
import * as fsPromises from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const TEMP_AUDIO_DIR = path.join(process.cwd(), 'temp_audio');

let s3Client: S3Client | null = null;

if (config.AWS_REGION && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY && config.AWS_S3_BUCKET) {
    const s3Config: S3ClientConfig = {
        region: config.AWS_REGION,
        credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        },
    };
    s3Client = new S3Client(s3Config);
    logger.info('[Audio Service] AWS S3 client initialized.');
} else {
    logger.warn('[Audio Service] AWS S3 client not fully configured. S3 operations will fail. Please check AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET in your environment variables.');
}

/**
 * Ensures the temporary audio directory exists.
 */
async function ensureTempDirExists(): Promise<void> {
    try {
        await fsPromises.mkdir(TEMP_AUDIO_DIR, { recursive: true });
    } catch (error) {
        logger.error('[Audio Service] Error creating temp audio directory:', error);
        throw error; // Re-throw to indicate failure
    }
}

/**
 * Executes the ffmpeg command to download and convert the M3U8 stream.
 * @param m3u8Url URL of the M3U8 playlist.
 * @param outputFilePath Path where the downloaded audio file should be saved.
 * @returns Promise that resolves on successful download, rejects on error.
 */
function runFfmpegDownload(m3u8Url: string, outputFilePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpegArgs = [
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-i', m3u8Url,
            '-c', 'copy', 
            '-bsf:a', 'aac_adtstoasc',
            '-y',
            outputFilePath
        ];

        // Log the full ffmpeg command prominently
        const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;
        logger.info('-------------------------------------------');
        logger.info(`[🎧 Audio] EXECUTING FFMPEG COMMAND:`);
        logger.info(ffmpegCommand);
        logger.info('-------------------------------------------');

        // Create timestamps for progress tracking
        const startTime = Date.now();
        let lastProgressUpdate = startTime;
        let lastProgressTimestamp = 0; // Last timestamp reported by ffmpeg
        let duration = 0; // Duration in seconds (will be determined from ffmpeg)
        let totalSize = 0; // Keep track of estimated total size
        let progressLogCounter = 0; // Count progress logs to throttle output
        
        logger.info(`[🎧 Audio] 🕒 Download started at ${new Date().toISOString()}`);

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        let ffmpegOutput = '';
        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            ffmpegOutput += output;
            
            // Parse progress information from ffmpeg
            const time = /time=(\d+:\d+:\d+\.\d+)/g.exec(output);
            const size = /size=\s*(\d+)kB/g.exec(output);
            const speed = /speed=\s*(\d+\.\d+)x/g.exec(output);
            
            if (time) {
                const timeStr = time[1];
                const [hours, minutes, seconds] = timeStr.split(':').map(parseFloat);
                const currentTimestamp = Math.floor(hours * 3600 + minutes * 60 + seconds);
                
                // Only log progress every 5 seconds of media time or after 10 seconds of real time
                const currentTime = Date.now();
                const realTimeElapsed = currentTime - lastProgressUpdate;
                const mediaTimeElapsed = currentTimestamp - lastProgressTimestamp;
                
                if (mediaTimeElapsed >= 5 || realTimeElapsed >= 10000 || progressLogCounter % 10 === 0) {
                    if (size) {
                        totalSize = parseInt(size[1], 10); // Size in kB
                        const downloadedMB = (totalSize / 1024).toFixed(2);
                        const elapsedSeconds = (currentTime - startTime) / 1000;
                        const downloadRateMBps = (totalSize / 1024 / elapsedSeconds).toFixed(2);
                        
                        logger.info(`[🎧 Audio] 📥 Progress - Time: ${timeStr}, Downloaded: ${downloadedMB} MB, Rate: ${downloadRateMBps} MB/s`);
                        
                        if (speed) {
                            logger.debug(`[🎧 Audio] Processing speed: ${speed[1]}x`);
                        }
                    } else {
                        logger.info(`[🎧 Audio] 📥 Progress - Time: ${timeStr}`);
                    }
                    
                    lastProgressUpdate = currentTime;
                    lastProgressTimestamp = currentTimestamp;
                }
                
                progressLogCounter++;
            }
        });

        ffmpegProcess.stderr.on('data', (data) => {
            const output = data.toString();
            ffmpegOutput += output;
            
            // Parse duration information
            const durationMatch = /Duration: (\d+:\d+:\d+\.\d+)/g.exec(output);
            if (durationMatch) {
                const durationStr = durationMatch[1];
                const [hours, minutes, seconds] = durationStr.split(':').map(parseFloat);
                duration = Math.floor(hours * 3600 + minutes * 60 + seconds);
                logger.info(`[🎧 Audio] 🕒 Detected media duration: ${durationStr} (${duration} seconds)`);
            }
            
            // Only log stderr for important messages, not every frame
            if (!output.includes("frame=") && !output.includes("size=")) {
                logger.debug(`[🎧 Audio] ffmpeg: ${output.trim()}`);
            }
        });

        ffmpegProcess.on('close', (code) => {
            const endTime = Date.now();
            const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
            
            if (code === 0) {
                // Get file size
                try {
                    const stats = fs.statSync(outputFilePath);
                    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                    logger.info(`[🎧 Audio] ✅ Download completed in ${elapsedSeconds}s. File size: ${fileSizeMB} MB`);
                } catch (err) {
                    logger.info(`[🎧 Audio] ✅ Download completed in ${elapsedSeconds}s`);
                }
                resolve();
            } else {
                logger.error(`[🎧 Audio] ❌ ffmpeg process exited with code ${code} after ${elapsedSeconds}s`);
                logger.error(`[🎧 Audio] ffmpeg output: \n${ffmpegOutput}`);
                reject(new Error(`ffmpeg failed with code ${code}`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            logger.error(`[🎧 Audio] ❌ Failed to start ffmpeg process for URL: ${m3u8Url}`, err);
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
async function uploadToS3(localFilePath: string, s3Key: string): Promise<string> {
    // Maximum number of retries for upload
    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastError: any = null;

    // Verify file exists before attempting upload
    if (!fs.existsSync(localFilePath)) {
        const errorMsg = `[🎧 Audio] ❌ ERROR: File does not exist at path: ${localFilePath}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Log file info to confirm it's there
    const stats = fs.statSync(localFilePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    const fileSizeBytes = stats.size;
    
    // Validate file has actual content
    if (fileSizeBytes <= 0) {
        const errorMsg = `[🎧 Audio] ❌ ERROR: File exists but has zero bytes: ${localFilePath}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }
    
    logger.info(`[🎧 Audio] ✅ VERIFICATION: File exists at path: ${localFilePath}`);
    logger.info(`[🎧 Audio] 📊 FILE INFO: Size: ${fileSizeMB} MB (${fileSizeBytes} bytes), Created: ${stats.birthtime}`);
    
    // Retry loop
    while (attempt < MAX_RETRIES) {
        attempt++;
        try {
            logger.info(`[🎧 Audio] 📤 Starting S3 upload (attempt ${attempt}/${MAX_RETRIES}): ${localFilePath} (${fileSizeMB} MB) to key: ${s3Key}`);
            
            const startTime = Date.now();
            
            // Read file into memory rather than using streams for small to medium files
            // This can be more reliable for avoiding EPIPE errors
            const fileBuffer = fs.readFileSync(localFilePath);
            
            // Use the correct content type for AAC files
            const uploadParams: PutObjectCommandInput = {
                Bucket: config.AWS_S3_BUCKET,
                Key: s3Key,
                Body: fileBuffer,
                ContentType: 'audio/aac', // Set content type to audio/aac
            };

            logger.debug(`[🎧 Audio] 📋 Uploading to bucket: ${config.AWS_S3_BUCKET}`);
            const command = new PutObjectCommand(uploadParams);
            await s3Client.send(command);

            // Construct the public URL (consider different S3 URL formats if needed, e.g., virtual hosted-style)
            // Determine region for URL construction
            const region = config.AWS_REGION || await s3Client.config.region() || 'us-east-1';
            const publicUrl = `https://${config.AWS_S3_BUCKET}.s3.${region}.amazonaws.com/${s3Key}`;

            const endTime = Date.now();
            const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
            logger.info(`[🎧 Audio] ✅ S3 upload successful (${elapsedSeconds}s). Public URL: ${publicUrl}`);
            return publicUrl;
            
        } catch (error) {
            lastError = error;
            logger.error(`[🎧 Audio] ❌ S3 upload attempt ${attempt}/${MAX_RETRIES} failed:`, error);
            
            if (attempt < MAX_RETRIES) {
                // Exponential backoff with jitter
                const delayMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 10000);
                logger.info(`[🎧 Audio] ⏳ Retrying in ${(delayMs/1000).toFixed(1)}s...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    
    // If we get here, all attempts failed
    logger.error(`[🎧 Audio] ❌ All ${MAX_RETRIES} S3 upload attempts failed for key: ${s3Key}`);
    throw new Error(`S3 upload failed after ${MAX_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Downloads audio from an M3U8 URL to a local MP3 file using ffmpeg.
 * @param m3u8Url The URL of the M3U8 playlist.
 * @param localPath The local path to save the MP3 file.
 * @returns True if successful, false otherwise.
 */
async function downloadM3u8ToMp3(m3u8Url: string, localPath: string): Promise<boolean> {
    try {
        logger.info(`[Audio Service] Downloading M3U8: ${m3u8Url} to ${localPath}`);
        const { stderr } = await execPromise(`ffmpeg -y -protocol_whitelist file,http,https,tcp,tls,crypto -i "${m3u8Url}" -c copy "${localPath}"`, { timeout: 300000 }); // 5 min timeout
        // ffmpeg often outputs to stderr for verbose info, so check for actual error keywords if necessary, or ignore if primarily informational
        if (stderr && !stderr.includes('conversion rate') && !stderr.includes('bytes received') && !stderr.toLowerCase().includes('ffmpeg version')) {
            logger.warn(`[Audio Service] ffmpeg stderr during download: ${stderr}`);
        }
        logger.info(`[Audio Service] Successfully downloaded audio to ${localPath}`);
        return true;
    } catch (error) {
        logger.error(`[Audio Service] Error downloading M3U8 to MP3 (${localPath}):`, error);
        return false;
    }
}

/**
 * Gets the duration of a local audio/video file using ffprobe.
 * @param localPath Path to the local media file.
 * @returns Duration in seconds, or null if an error occurs.
 */
async function getMediaDuration(localPath: string): Promise<number | null> {
    try {
        logger.info(`[Audio Service] Getting duration for: ${localPath}`);
        const { stdout, stderr } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${localPath}"`);
        if (stderr) {
            logger.warn(`[Audio Service] ffprobe stderr during duration check: ${stderr}`);
        }
        const duration = parseFloat(stdout);
        if (isNaN(duration) || duration <= 0) {
            logger.error(`[Audio Service] ffprobe output was not a valid positive number for duration: ${stdout}`);
            return null;
        }
        logger.info(`[Audio Service] Extracted duration: ${duration} seconds for ${localPath}`);
        return duration;
    } catch (error) {
        logger.error(`[Audio Service] Error getting media duration for ${localPath}:`, error);
        return null;
    }
}

/**
 * Uploads a local file to S3.
 * @param localPath Path to the local file.
 * @param s3Key The S3 key (path) for the uploaded file.
 * @param contentType The content type of the file.
 * @returns The public S3 URL of the uploaded file, or null if an error occurs.
 */
async function uploadFileToS3(localPath: string, s3Key: string, contentType: string = 'audio/mpeg'): Promise<string | null> {
    if (!s3Client) {
        logger.error('[Audio Service] S3 client not initialized. Cannot upload file. AWS configuration might be missing.');
        return null;
    }
    if (!config.AWS_S3_BUCKET) {
        logger.error('[Audio Service] AWS_S3_BUCKET not configured. Cannot upload file.');
        return null;
    }
    try {
        logger.info(`[Audio Service] Uploading ${localPath} to S3 as ${s3Key}`);
        const fileContent = await fsPromises.readFile(localPath);
        const params = {
            Bucket: config.AWS_S3_BUCKET,
            Key: s3Key,
            Body: fileContent,
            ContentType: contentType,
        };
        await s3Client.send(new PutObjectCommand(params));
        const publicUrl = `https://${config.AWS_S3_BUCKET}.s3.${config.AWS_REGION}.amazonaws.com/${s3Key}`;
        logger.info(`[Audio Service] Successfully uploaded to S3: ${publicUrl}`);
        return publicUrl;
    } catch (error) {
        logger.error(`[Audio Service] Error uploading ${localPath} to S3 as ${s3Key}:`, error);
        return null;
    }
}

export interface PreparedAudioInfo {
    fileUuid: string;
    fileKey: string; // S3 Key
    duration: number;
    s3Url: string;
    localPath: string; // Keep local path for potential direct use or cleanup
}

/**
 * Downloads audio from M3U8, gets duration, uploads to S3 for transcription.
 * @param m3u8Url The M3U8 URL of the Twitter Space audio.
 * @param nameHint A hint for naming, e.g., spaceId or a generated unique part for S3 key.
 * @returns An object with fileUuid, fileKey (S3), duration, and s3Url, or null on failure.
 */
export async function prepareAudioForTranscription(
    m3u8Url: string,
    nameHint: string = 'space-audio'
): Promise<PreparedAudioInfo | null> {
    await ensureTempDirExists();

    const fileUuid = uuidv4();
    const s3FileName = `${fileUuid}.mp3`;
    // Standardized S3 key structure for transcription inputs
    const fileKey = `transcription-input/${nameHint}/${s3FileName}`;
    const localAudioPath = path.join(TEMP_AUDIO_DIR, s3FileName);

    logger.info(`[Audio Service - Transcribe Prep] Preparing audio. UUID: ${fileUuid}, M3U8: ${m3u8Url}`);

    const downloadSuccess = await downloadM3u8ToMp3(m3u8Url, localAudioPath);
    if (!downloadSuccess) {
        logger.error('[Audio Service - Transcribe Prep] Download failed.');
        return null;
    }

    const duration = await getMediaDuration(localAudioPath);
    if (duration === null) {
        logger.error('[Audio Service - Transcribe Prep] Failed to get media duration.');
        try {
            await fsPromises.unlink(localAudioPath);
            logger.debug(`[Audio Service - Transcribe Prep] Temp file ${localAudioPath} deleted after duration error.`);
        } catch (err) {
            logger.warn(`[Audio Service - Transcribe Prep] Failed to delete temp audio file ${localAudioPath} after duration error:`, err);
        }
        return null;
    }

    const s3Url = await uploadFileToS3(localAudioPath, fileKey, 'audio/mpeg');
    if (!s3Url) {
        logger.error('[Audio Service - Transcribe Prep] S3 upload failed.');
        // Not deleting local file on S3 upload failure, might be useful for manual retry or inspection
        return null;
    }

    logger.info(`[Audio Service - Transcribe Prep] Successfully prepared audio: ${s3Url}, Duration: ${duration}s`);
    
    return {
        fileUuid,
        fileKey,
        duration,
        s3Url,
        localPath: localAudioPath
    };
}

/**
 * Uploads a locally stored file to the configured S3 public bucket.
 * @param localFilePath Path to the local file to upload.
 * @param s3Key The desired key (filename including any prefixes) for the object in S3.
 * @returns Promise resolving with the public URL of the uploaded object, or null on failure.
 */
export async function uploadLocalFileToS3(localFilePath: string, s3Key: string): Promise<string | null> {
    try {
        await fsPromises.access(localFilePath); // Check if file is accessible
    } catch (error) {
        logger.error(`[Audio Service] Local file not accessible for S3 upload: ${localFilePath}`, error);
        return null;
    }
    return uploadFileToS3(localFilePath, s3Key, 'audio/mpeg');
}

/**
 * Downloads audio from an M3U8 URL, converts to MP3, and uploads to S3 for DUBBING.
 */
export async function downloadAndUploadAudio(m3u8Url: string, spaceId: string): Promise<string | null> {
    await ensureTempDirExists();
    const filename = `${spaceId}.mp3`;
    const localAudioPath = path.join(TEMP_AUDIO_DIR, filename);
    const s3Key = `spaces/${filename}`;

    const downloadSuccess = await downloadM3u8ToMp3(m3u8Url, localAudioPath);
    if (!downloadSuccess) return null;

    const s3Url = await uploadFileToS3(localAudioPath, s3Key, 'audio/mpeg');
    
    try {
        await fsPromises.unlink(localAudioPath);
        logger.debug(`[Audio Service] Temp file ${localAudioPath} deleted after dubbing upload.`);
    } catch (err) {
        logger.warn(`[Audio Service] Failed to delete temp audio file ${localAudioPath} after dubbing upload:`, err);
    }
    
    return s3Url;
} 