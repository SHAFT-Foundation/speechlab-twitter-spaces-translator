import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger';

/**
 * Merges dubbed audio with original video using FFmpeg.
 * Replaces the video's audio track with the dubbed audio while keeping video unchanged.
 * @param videoPath Path to the original video file
 * @param audioPath Path to the dubbed audio file
 * @param outputPath Path where the merged video should be saved
 * @returns Promise resolving to true on success, false on failure
 */
export async function mergeVideoDubbedAudio(
    videoPath: string,
    audioPath: string,
    outputPath: string
): Promise<boolean> {
    logger.info(`[🎬 Merge] Starting video + dubbed audio merge...`);
    logger.info(`[🎬 Merge]   Video: ${videoPath}`);
    logger.info(`[🎬 Merge]   Audio: ${audioPath}`);
    logger.info(`[🎬 Merge]   Output: ${outputPath}`);

    // Validate input files exist
    if (!fs.existsSync(videoPath)) {
        logger.error(`[🎬 Merge] ❌ Video file does not exist: ${videoPath}`);
        return false;
    }
    if (!fs.existsSync(audioPath)) {
        logger.error(`[🎬 Merge] ❌ Audio file does not exist: ${audioPath}`);
        return false;
    }

    const videoStats = fs.statSync(videoPath);
    const audioStats = fs.statSync(audioPath);
    logger.info(`[🎬 Merge] Video size: ${(videoStats.size / (1024 * 1024)).toFixed(2)} MB`);
    logger.info(`[🎬 Merge] Audio size: ${(audioStats.size / (1024 * 1024)).toFixed(2)} MB`);

    return new Promise((resolve, reject) => {
        const ffmpegArgs = [
            '-i', videoPath,          // Input video
            '-i', audioPath,          // Input dubbed audio
            '-c:v', 'copy',           // Copy video codec (no re-encoding)
            '-c:a', 'aac',            // Encode audio as AAC
            '-map', '0:v:0',          // Map video from first input
            '-map', '1:a:0',          // Map audio from second input
            '-shortest',              // Match shortest stream duration
            '-movflags', '+faststart', // Optimize for web streaming
            '-y',                     // Overwrite output file
            outputPath
        ];

        const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;
        logger.info('-------------------------------------------');
        logger.info(`[🎬 Merge] EXECUTING FFMPEG COMMAND:`);
        logger.info(ffmpegCommand);
        logger.info('-------------------------------------------');

        const startTime = Date.now();
        logger.info(`[🎬 Merge] 🕒 Merge started at ${new Date().toISOString()}`);

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        let ffmpegOutput = '';
        let lastProgressUpdate = startTime;
        let progressLogCounter = 0;

        // Parse progress from stdout
        ffmpegProcess.stdout.on('data', (data) => {
            const output = data.toString();
            ffmpegOutput += output;

            const time = /time=(\d+:\d+:\d+\.\d+)/g.exec(output);
            const currentTime = Date.now();

            if (time && (currentTime - lastProgressUpdate >= 5000 || progressLogCounter % 10 === 0)) {
                logger.info(`[🎬 Merge] 📥 Progress - Time: ${time[1]}`);
                lastProgressUpdate = currentTime;
            }

            progressLogCounter++;
        });

        // Parse progress from stderr (FFmpeg writes progress here)
        ffmpegProcess.stderr.on('data', (data) => {
            const output = data.toString();
            ffmpegOutput += output;

            const time = /time=(\d+:\d+:\d+\.\d+)/g.exec(output);
            const currentTime = Date.now();

            if (time && (currentTime - lastProgressUpdate >= 5000 || progressLogCounter % 10 === 0)) {
                logger.info(`[🎬 Merge] 📥 Progress - Time: ${time[1]}`);
                lastProgressUpdate = currentTime;
            }

            progressLogCounter++;
        });

        ffmpegProcess.on('close', (code) => {
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            logger.info(`[🎬 Merge] ⏱️ FFmpeg process finished in ${elapsedTime}s with code ${code}`);

            if (code === 0) {
                // Verify output file was created
                if (fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                    logger.info(`[🎬 Merge] ✅ Video merge successful! Output size: ${fileSizeMB} MB`);
                    resolve(true);
                } else {
                    logger.error('[🎬 Merge] ❌ FFmpeg exited with code 0 but output file does not exist.');
                    logger.error(`[🎬 Merge] FFmpeg output (last 500 chars): ${ffmpegOutput.slice(-500)}`);
                    resolve(false);
                }
            } else {
                logger.error(`[🎬 Merge] ❌ FFmpeg exited with non-zero code: ${code}`);
                logger.error(`[🎬 Merge] FFmpeg output (last 500 chars): ${ffmpegOutput.slice(-500)}`);
                resolve(false);
            }
        });

        ffmpegProcess.on('error', (err) => {
            logger.error('[🎬 Merge] ❌ FFmpeg process error:', err);
            resolve(false);
        });
    });
}

/**
 * Extracts audio from a video file using FFmpeg.
 * @param videoPath Path to the video file
 * @param audioOutputPath Path where the extracted audio should be saved
 * @returns Promise resolving to true on success, false on failure
 */
export async function extractAudioFromVideo(
    videoPath: string,
    audioOutputPath: string
): Promise<boolean> {
    logger.info(`[🎧 Extract] Extracting audio from video...`);
    logger.info(`[🎧 Extract]   Video: ${videoPath}`);
    logger.info(`[🎧 Extract]   Audio Output: ${audioOutputPath}`);

    if (!fs.existsSync(videoPath)) {
        logger.error(`[🎧 Extract] ❌ Video file does not exist: ${videoPath}`);
        return false;
    }

    return new Promise((resolve) => {
        const ffmpegArgs = [
            '-i', videoPath,
            '-vn',                    // No video
            '-acodec', 'libmp3lame',  // MP3 codec
            '-q:a', '2',              // Quality (0-9, lower is better)
            '-y',                     // Overwrite output
            audioOutputPath
        ];

        const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;
        logger.info('-------------------------------------------');
        logger.info(`[🎧 Extract] EXECUTING FFMPEG COMMAND:`);
        logger.info(ffmpegCommand);
        logger.info('-------------------------------------------');

        const startTime = Date.now();
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        let ffmpegOutput = '';

        ffmpegProcess.stdout.on('data', (data) => {
            ffmpegOutput += data.toString();
        });

        ffmpegProcess.stderr.on('data', (data) => {
            ffmpegOutput += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
            const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
            logger.info(`[🎧 Extract] ⏱️ FFmpeg process finished in ${elapsedTime}s with code ${code}`);

            if (code === 0 && fs.existsSync(audioOutputPath)) {
                const stats = fs.statSync(audioOutputPath);
                const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                logger.info(`[🎧 Extract] ✅ Audio extraction successful! Size: ${fileSizeMB} MB`);
                resolve(true);
            } else {
                logger.error(`[🎧 Extract] ❌ Audio extraction failed with code: ${code}`);
                logger.error(`[🎧 Extract] FFmpeg output (last 500 chars): ${ffmpegOutput.slice(-500)}`);
                resolve(false);
            }
        });

        ffmpegProcess.on('error', (err) => {
            logger.error('[🎧 Extract] ❌ FFmpeg process error:', err);
            resolve(false);
        });
    });
}
