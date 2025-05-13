import { Configuration, OpenAIApi } from 'openai';
import { config } from '../utils/config';
import logger from '../utils/logger';

let openai: OpenAIApi | null = null;

if (config.OPENAI_API_KEY) {
    const configuration = new Configuration({
        apiKey: config.OPENAI_API_KEY,
    });
    openai = new OpenAIApi(configuration);
} else {
    logger.warn('[OpenAI Service] OpenAI API key is not configured. Summarization will not work.');
}

/**
 * Summarizes the given text using OpenAI API.
 * @param textToSummarize The text to summarize.
 * @returns The summarized text, or null if an error occurs or service is not configured.
 */
export async function summarizeText(textToSummarize: string): Promise<string | null> {
    if (!openai) {
        logger.error('[OpenAI Service] OpenAI client not initialized. Cannot summarize.');
        return null;
    }

    // Corrected prompt based on user's request, fixing typos
    const prompt = `Given this text:\n---\n${textToSummarize}\n---\nI'd like you to give a detailed summary of this Twitter Space. We can leave out the speakers though and just summarize the entire space.`;

    try {
        logger.info('[OpenAI Service] Requesting summary from OpenAI...');
        const response = await openai.createChatCompletion({
            model: 'gpt-3.5-turbo', // Or another model like gpt-4 if preferred and available
            messages: [
                { role: 'system', content: 'You are a helpful assistant that summarizes Twitter Space transcripts.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.5, // Adjust for more factual vs. creative summary
        });

        const summary = response.data.choices[0]?.message?.content?.trim();
        
        if (summary) {
            logger.info('[OpenAI Service] Successfully received summary from OpenAI.');
            return summary;
        } else {
            logger.error('[OpenAI Service] OpenAI response did not contain a summary.');
            return null;
        }
    } catch (error: any) {
        if (error.response) {
            logger.error(`[OpenAI Service] Error summarizing text: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`[OpenAI Service] Error summarizing text: ${error.message}`);
        }
        return null;
    }
} 