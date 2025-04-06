import logger from './utils/logger';
import { downloadAndUploadAudio } from './services/audioService';
import * as fs from 'fs';
import * as path from 'path';

// Ensure debug screenshots directory exists
const debugDir = path.join(process.cwd(), 'debug-screenshots');
if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
}

// Ensure temp audio directory exists
const tempDir = path.join(process.cwd(), 'temp_audio');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

async function testM3u8Download(m3u8Url: string): Promise<void> {
    logger.info(`M3U8 Test - Starting download test for URL: ${m3u8Url}`);
    
    try {
        const result = await downloadAndUploadAudio(m3u8Url, "Test Space Download");
        
        if (result) {
            logger.info(`M3U8 Test - SUCCESS: File downloaded and uploaded to S3: ${result}`);
        } else {
            logger.error(`M3U8 Test - FAILED: Unable to download/upload the M3U8 stream`);
            process.exit(1);
        }
    } catch (error) {
        logger.error(`M3U8 Test - FAILED with error:`, error);
        process.exit(1);
    }
}

async function main() {
    // Get M3U8 URL from command line argument
    const m3u8Url = process.argv[2];
    
    if (!m3u8Url) {
        logger.error(`Usage: node dist/test-download-m3u8.js <m3u8_url>`);
        process.exit(1);
    }
    
    logger.info(`M3U8 Test - Starting download test with URL from command line`);
    await testM3u8Download(m3u8Url);
}

// Run the test
main().catch(err => {
    logger.error('Unhandled error in main:', err);
    process.exit(1);
}); 