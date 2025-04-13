import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import logger from './logger'; // Assuming logger is set up

/**
 * Downloads a file from a URL to a specified destination path.
 * 
 * @param url The URL of the file to download.
 * @param destinationPath The full path (including filename) where the file should be saved.
 * @returns {Promise<boolean>} True if download and save were successful, false otherwise.
 */
export async function downloadFile(url: string, destinationPath: string): Promise<boolean> {
    logger.info(`[📥 File] Attempting to download file from ${url} to ${destinationPath}`);

    try {
        // Ensure the destination directory exists
        const dir = path.dirname(destinationPath);
        if (!fs.existsSync(dir)) {
            logger.info(`[📥 File] Creating directory: ${dir}`);
            fs.mkdirSync(dir, { recursive: true });
        }

        // Make the request with responseType 'stream'
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 180000 // 3 minute timeout for download start
        });

        // Create a write stream
        const writer = fs.createWriteStream(destinationPath);

        // Pipe the response data to the file
        response.data.pipe(writer);

        // Return a promise that resolves when the download finishes or rejects on error
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                logger.info(`[📥 File] ✅ Successfully downloaded and saved file to ${destinationPath}`);
                resolve(true);
            });
            writer.on('error', (error) => {
                logger.error(`[📥 File] ❌ Error writing file to ${destinationPath}:`, error);
                // Clean up partially downloaded file on error
                try { 
                    if (fs.existsSync(destinationPath)) {
                        fs.unlinkSync(destinationPath);
                    }
                } catch (cleanupError) {
                    logger.warn(`[📥 File] Failed to clean up partial file ${destinationPath}:`, cleanupError);
                }
                reject(false); 
            });
            response.data.on('error', (error: Error) => {
                logger.error(`[📥 File] ❌ Error during download stream from ${url}:`, error);
                 // Clean up partially downloaded file on error
                try { 
                     if (fs.existsSync(destinationPath)) {
                         fs.unlinkSync(destinationPath);
                    }
                } catch (cleanupError) {
                     logger.warn(`[📥 File] Failed to clean up partial file ${destinationPath} after stream error:`, cleanupError);
                 }
                reject(false); 
            });
        });

    } catch (error) {
        logger.error(`[📥 File] ❌ Failed to initiate download from ${url}:`, error);
        return false;
    }
} 