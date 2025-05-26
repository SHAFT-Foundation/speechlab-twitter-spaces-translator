import OpenAI from 'openai';
import { config } from '../utils/config';
import logger from '../utils/logger';

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
});

/**
 * Summarizes transcription text using OpenAI GPT
 * @param transcriptionText The transcription text to summarize
 * @returns {Promise<string | null>} The summary text or null on failure
 */
export async function summarizeTwitterSpace(transcriptionText: string): Promise<string | null> {
    logger.info('[🤖 OpenAI] Attempting to summarize Twitter Space transcription...');
    
    if (!transcriptionText || transcriptionText.trim().length === 0) {
        logger.error('[🤖 OpenAI] ❌ Empty transcription text provided for summarization.');
        return null;
    }

    const prompt = `Given this text <transcriptiontext>${transcriptionText}</transcriptiontext> I'd like to give a detailed summary of this twitter space... we can leave out the speakers though and just summarize the entire space...`;

    try {
        logger.debug(`[🤖 OpenAI] Sending summarization request with ${transcriptionText.length} characters of text...`);
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Using cost-effective model for summarization
            messages: [
                {
                    role: 'system',
                    content: 'You are a helpful assistant that creates detailed summaries of Twitter Spaces. Focus on the main topics, key insights, and important discussions while omitting specific speaker names and identities.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 1000, // Reasonable limit for summary
            temperature: 0.3, // Lower temperature for more focused summaries
        });

        const summary = response.choices[0]?.message?.content;
        
        if (summary) {
            logger.info('[🤖 OpenAI] ✅ Successfully generated summary.');
            logger.debug(`[🤖 OpenAI] Summary length: ${summary.length} characters`);
            return summary.trim();
        } else {
            logger.error('[🤖 OpenAI] ❌ No summary content returned from OpenAI API.');
            return null;
        }

    } catch (error) {
        logger.error('[🤖 OpenAI] ❌ Error during summarization:', error);
        
        if (error instanceof Error) {
            logger.error(`[🤖 OpenAI] Error message: ${error.message}`);
        }
        
        return null;
    }
}