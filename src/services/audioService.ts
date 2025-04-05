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
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', // Necessary for HLS sources
            '-i', m3u8Url,       // Input URL
            '-c', 'copy',        // Copy codec (no re-encoding)
            '-bsf:a', 'aac_adtstoasc', // Bitstream filter often needed for raw AAC streams from HLS
            '-y',                // Overwrite output file if it exists
            outputFilePath       // Output file path
        ];

        logger.info(`[🎧 Audio] Starting ffmpeg download for: ${m3u8Url}`);
        logger.debug(`[🎧 Audio] ffmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        let ffmpegOutput = '';
        ffmpegProcess.stdout.on('data', (data) => {
            ffmpegOutput += data.toString();
            // logger.debug(`[ffmpeg stdout]: ${data}`); // Optional: very verbose
        });

        ffmpegProcess.stderr.on('data', (data) => {
            ffmpegOutput += data.toString(); // Capture stderr as well, ffmpeg often logs progress here
            logger.debug(`[ffmpeg stderr]: ${data.toString().trim()}`);
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                logger.info(`[🎧 Audio] ✅ ffmpeg download completed successfully for: ${outputFilePath}`);
                resolve();
            } else {
                logger.error(`[🎧 Audio] ❌ ffmpeg process exited with code ${code} for URL: ${m3u8Url}`);
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
    logger.info(`[🎧 Audio] Starting S3 upload for: ${localFilePath} to key: ${s3Key}`);
    try {
        const fileStream = fs.createReadStream(localFilePath);

        // Use the correct type for ACL
        const uploadParams: PutObjectCommandInput = {
            Bucket: config.AWS_S3_BUCKET,
            Key: s3Key,
            Body: fileStream,
            ACL: 'public-read', // SDK v3 often accepts string literals for enums
            // If the above string literal doesn't work, import and use ObjectCannedACL.public_read
            // ContentType: 'audio/aac', // Optional: Set content type if known (e.g., audio/aac, audio/mpeg for mp3)
        };

        const command = new PutObjectCommand(uploadParams);
        await s3Client.send(command);

        // Construct the public URL (consider different S3 URL formats if needed, e.g., virtual hosted-style)
        // Determine region for URL construction
        const region = config.AWS_REGION || await s3Client.config.region() || 'us-east-1';
        const publicUrl = `https://${config.AWS_S3_BUCKET}.s3.${region}.amazonaws.com/${s3Key}`;

        logger.info(`[🎧 Audio] ✅ S3 upload successful. Public URL: ${publicUrl}`);
        return publicUrl;
    } catch (error) {
        logger.error(`[🎧 Audio] ❌ S3 upload failed for key: ${s3Key}`, error);
        throw new Error(`S3 upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const outputFilename = `${sanitizedNamePart}_${uniqueId}.aac`; // Using AAC as likely format from HLS
    const localFilePath = path.join(TEMP_DIR, outputFilename);
    const s3Key = `twitter-space-audio/${outputFilename}`; // Store in a specific "folder" in S3

    try {
        // Step 1: Download using ffmpeg
        await runFfmpegDownload(m3u8Url, localFilePath);

        // Step 2: Upload the downloaded file to S3
        const publicUrl = await uploadToS3(localFilePath, s3Key);

        // Step 3: Clean up the local temporary file
        logger.debug(`[🎧 Audio] Cleaning up temporary file: ${localFilePath}`);
        fs.unlink(localFilePath, (err) => {
            if (err) {
                logger.warn(`[🎧 Audio] Failed to delete temporary file ${localFilePath}:`, err);
            } else {
                 logger.debug(`[🎧 Audio] Successfully deleted temporary file: ${localFilePath}`);
            }
        });

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