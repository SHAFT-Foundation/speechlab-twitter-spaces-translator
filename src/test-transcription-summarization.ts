import logger from './utils/logger';
import { config } from './utils/config';
import { exampleTranscriptionWorkflow, transcribeAndSummarize, TranscriptionRequest } from './services/transcriptionSummarizationService';

/**
 * Test script for transcription and summarization workflow
 */
async function main() {
    logger.info('[🧪 Test] Starting transcription and summarization test...');
    
    try {
        // Run the example workflow with the data from the user's curl request
        await exampleTranscriptionWorkflow();
        
        logger.info('[🧪 Test] ✅ Test completed successfully!');
    } catch (error) {
        logger.error('[🧪 Test] ❌ Test failed:', error);
        process.exit(1);
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    main().catch((error) => {
        logger.error('[🧪 Test] ❌ Unhandled error:', error);
        process.exit(1);
    });
}

export { main as testTranscriptionSummarization };