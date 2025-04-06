import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand, PutObjectCommandInput } from "@aws-sdk/client-s3";
import { config } from '../utils/config';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid'; // Using uuid for unique filenames

// Configure AWS S3 Client
// The SDK automatically picks up credentials from environment variables, EC2 instance profiles, etc.
// Region can be optionally specified if not default or in env variables.
const s3Client = new S3Client({ region: config.AWS_REGION }); // Use region from config if available

const TEMP_DIR = path.join(process.cwd(), 'temp_audio'); // Define a directory for temporary downloads

/**
 * Ensures the temporary directory for audio downloads exists.
 */
function ensureTempDirExists(): void {
    if (!fs.existsSync(TEMP_DIR)) {
        logger.debug(`[🎧 Audio] Creating temporary directory: ${TEMP_DIR}`);
        fs.mkdirSync(TEMP_DIR, { recursive: true });
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
            '-i', m3u8Url,     // Input URL 
            '-c', 'copy',      // Copy codec (no re-encoding)
            '-y',              // Overwrite output file if it exists
            outputFilePath     // Output file path
        ];

        // Log the full ffmpeg command prominently
        const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;
        logger.info(`[🎧 Audio] 🔧 FFMPEG COMMAND: ${ffmpegCommand}`);
        logger.info(`[🎧 Audio] Starting ffmpeg download for: ${m3u8Url}`);
        logger.info(`[🎧 Audio] Output file will be saved to: ${outputFilePath}`);
        logger.debug(`[🎧 Audio] ffmpeg command: ${ffmpegCommand}`);

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
            
            // Use the correct content type for MP4 files
            const uploadParams: PutObjectCommandInput = {
                Bucket: config.AWS_S3_BUCKET,
                Key: s3Key,
                Body: fileBuffer,
                ContentType: 'video/mp4', // Updated content type for MP4 container
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
 * Downloads audio from an M3U8 URL using ffmpeg and uploads it to S3.
 * @param m3u8Url The URL of the M3U8 playlist.
 * @param spaceName Optional name for the space, used for naming the S3 file.
 * @returns Promise resolving with the public S3 URL of the uploaded audio.
 */
export async function downloadAndUploadAudio(m3u8Url: string, spaceName?: string | null): Promise<string | null> {
    ensureTempDirExists();
    const uniqueId = uuidv4();
    // Sanitize spaceName for filename or use uuid if name is unavailable/invalid
    const sanitizedNamePart = spaceName ? spaceName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) : uniqueId;
    const outputFilename = `${sanitizedNamePart}_${uniqueId}.mp4`; // Using MP4 container instead of AAC
    const localFilePath = path.join(TEMP_DIR, outputFilename);
    const s3Key = `twitter-space-audio/${outputFilename}`; // Store in a specific "folder" in S3

    logger.info(`[🎧 Audio] 🔄 Processing Twitter Space "${spaceName || 'Unnamed Space'}"`);
    logger.info(`[🎧 Audio] Download queue initialized`);

    try {
        // Step 1: Download using ffmpeg
        logger.info(`[🎧 Audio] 🔽 Step 1/3: Downloading audio stream...`);
        const downloadStartTime = Date.now();
        await runFfmpegDownload(m3u8Url, localFilePath);
        const downloadEndTime = Date.now();
        const downloadElapsedSec = ((downloadEndTime - downloadStartTime) / 1000).toFixed(1);
        logger.info(`[🎧 Audio] ✓ Download step completed in ${downloadElapsedSec}s`);

        // Step 2: Upload the downloaded file to S3
        logger.info(`[🎧 Audio] 🔼 Step 2/3: Uploading to S3...`);
        const uploadStartTime = Date.now();
        const publicUrl = await uploadToS3(localFilePath, s3Key);
        const uploadEndTime = Date.now();
        const uploadElapsedSec = ((uploadEndTime - uploadStartTime) / 1000).toFixed(1);
        logger.info(`[🎧 Audio] ✓ Upload step completed in ${uploadElapsedSec}s`);

        // Step 3: Clean up the local temporary file
        logger.info(`[🎧 Audio] 🗑️ Step 3/3: Cleaning up temporary file...`);
        fs.unlink(localFilePath, (err) => {
            if (err) {
                logger.warn(`[🎧 Audio] ⚠️ Failed to delete temporary file ${localFilePath}:`, err);
            } else {
                 logger.info(`[🎧 Audio] ✓ Successfully deleted temporary file`);
            }
        });

        const totalElapsedSec = ((Date.now() - downloadStartTime) / 1000).toFixed(1);
        logger.info(`[🎧 Audio] ✅ Audio processing completed in ${totalElapsedSec}s`);
        return publicUrl;

    } catch (error) {
        logger.error(`[🎧 Audio] ❌ Failed to process audio for ${m3u8Url}:`, error);

        // Attempt cleanup even on error
        if (fs.existsSync(localFilePath)) {
            logger.debug(`[🎧 Audio] Cleaning up temporary file after error: ${localFilePath}`);
            fs.unlink(localFilePath, (err) => {
                if (err) logger.warn(`[🎧 Audio] Failed to delete temporary file ${localFilePath} after error:`, err);
            });
        }
        return null; // Indicate failure
    }
} 