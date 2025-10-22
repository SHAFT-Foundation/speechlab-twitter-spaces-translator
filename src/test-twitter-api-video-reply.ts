import dotenv from 'dotenv';
import path from 'path';
import winston from 'winston';
import { postTweetReplyWithMediaApi } from './services/twitterApiService';

// Load environment variables
dotenv.config();

// Setup logger
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] [API-TEST] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'test-twitter-api-reply.log'),
      options: { flags: 'w' }
    })
  ]
});

async function testTwitterApiVideoReply() {
  logger.info('========================================');
  logger.info('Twitter API Video Reply Test');
  logger.info('========================================');

  // Test configuration
  const TEST_TWEET_ID = '1980770274782945627'; // Tweet ID to reply to
  const VIDEO_PATH = path.join(process.cwd(), 'temp_video', 'reply_video_1980770274782945627.mp4');
  const REPLY_TEXT = `Test API reply with video - ${new Date().toLocaleTimeString()}`;

  try {
    logger.info(`Tweet to reply to: ${TEST_TWEET_ID}`);
    logger.info(`Video path: ${VIDEO_PATH}`);
    logger.info(`Reply text: ${REPLY_TEXT}`);

    logger.info('--- Posting reply via Twitter API ---');
    const success = await postTweetReplyWithMediaApi(
      REPLY_TEXT,
      TEST_TWEET_ID,
      VIDEO_PATH
    );

    if (success) {
      logger.info('========================================');
      logger.info('✅✅✅ SUCCESS: Reply posted via API!');
      logger.info('========================================');
    } else {
      logger.error('========================================');
      logger.error('❌❌❌ FAILED: Could not post reply');
      logger.error('========================================');
    }

  } catch (error) {
    logger.error('========================================');
    logger.error('❌ Test error:', error);
    logger.error('========================================');
  }
}

// Run test
testTwitterApiVideoReply().catch(error => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});
