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
    new winston.transports.Console()
  ]
});

async function testTwitterApiTextReply() {
  logger.info('========================================');
  logger.info('Twitter API Text Reply Test (No Media)');
  logger.info('========================================');

  // Test configuration
  const TEST_TWEET_ID = '1980770274782945627'; // Tweet ID to reply to
  const REPLY_TEXT = `Test API text reply (no video) - ${new Date().toLocaleTimeString()}`;

  try {
    logger.info(`Tweet to reply to: ${TEST_TWEET_ID}`);
    logger.info(`Reply text: ${REPLY_TEXT}`);

    logger.info('--- Posting text-only reply via Twitter API ---');
    const success = await postTweetReplyWithMediaApi(
      REPLY_TEXT,
      TEST_TWEET_ID
      // No media path - testing text-only
    );

    if (success) {
      logger.info('========================================');
      logger.info('✅✅✅ SUCCESS: Text reply posted via API!');
      logger.info('========================================');
    } else {
      logger.error('========================================');
      logger.error('❌❌❌ FAILED: Could not post text reply');
      logger.error('========================================');
    }

  } catch (error) {
    logger.error('========================================');
    logger.error('❌ Test error:', error);
    logger.error('========================================');
  }
}

// Run test
testTwitterApiTextReply().catch(error => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});
