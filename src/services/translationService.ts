import OpenAI from 'openai';
import { config } from '../utils/config';
import logger from '../utils/logger';

const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
});

const LANGUAGE_MAP: Record<string, string> = {
    'es': 'Spanish',
    'es_la': 'Spanish (Latin America)',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'pt_br': 'Portuguese (Brazil)',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese (Simplified)',
    'zh_tw': 'Chinese (Traditional)',
    'ar': 'Arabic',
    'hi': 'Hindi',
    'ru': 'Russian',
    'id': 'Indonesian',
    'tr': 'Turkish',
    'nl': 'Dutch',
    'pl': 'Polish',
    'sv': 'Swedish',
    'da': 'Danish',
    'no': 'Norwegian',
    'fi': 'Finnish'
};

/**
 * Translate text to target language using OpenAI
 */
export async function translateText(text: string, targetLanguage: string): Promise<string> {
    try {
        const languageName = LANGUAGE_MAP[targetLanguage] || targetLanguage;

        logger.debug(`[🌐 Translation] Translating to ${languageName}: "${text.substring(0, 50)}..."`);

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Fast and cost-effective for translations
            messages: [{
                role: 'user',
                content: `Translate the following tweet text to ${languageName}. Only return the translation, no explanations or additional text:\n\n${text}`
            }],
            max_tokens: 500,
            temperature: 0.3 // Low temperature for consistent translations
        });

        const translated = completion.choices[0]?.message?.content?.trim();
        if (translated) {
            logger.debug(`[🌐 Translation] Translated: "${translated.substring(0, 50)}..."`);
            return translated;
        }

        logger.warn('[🌐 Translation] Failed to get text from OpenAI response');
        return text; // Fallback to original
    } catch (error) {
        logger.error('[🌐 Translation] Translation error:', error);
        return text; // Fallback to original on error
    }
}
