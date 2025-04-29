import logger from './logger';

interface LanguageInfo {
    code: string;
    label: string;
    aliases: string[]; // Common variations
}

// Supported languages based on user input
const SUPPORTED_LANGUAGES: LanguageInfo[] = [
    { code: "en", label: "English", aliases: ["english", "en"] },
    { code: "es", label: "Spanish", aliases: ["spanish", "español", "es"] },
    { code: "nl", label: "Dutch", aliases: ["dutch", "nl"] },
    { code: "fr", label: "French", aliases: ["french", "français", "fr"] },
    { code: "it", label: "Italian", aliases: ["italian", "italiano", "it"] },
    { code: "de", label: "German", aliases: ["german", "deutsch", "de"] },
    { code: "ar", label: "Arabic", aliases: ["arabic", "العربية", "ar"] },
    { code: "ko", label: "Korean", aliases: ["korean", "한국어", "ko"] },
    { code: "ja", label: "Japanese", aliases: ["japanese", "日本語", "ja"] },
    { code: "hi", label: "Hindi", aliases: ["hindi", "हिन्दी", "hi"] },
    { code: "zh", label: "Chinese", aliases: ["chinese", "中文", "zh"] }, // Assuming Mandarin default
    { code: "pt", label: "Portuguese", aliases: ["portuguese", "português", "pt"] },
    { code: "pl", label: "Polish", aliases: ["polish", "polski", "pl"] },
    { code: "tr", label: "Turkish", aliases: ["turkish", "türkçe", "tr"] },
    { code: "sv", label: "Swedish", aliases: ["swedish", "svenska", "sv"] },
    { code: "ru", label: "Russian", aliases: ["russian", "русский", "ru"] },
    { code: "uk", label: "Ukrainian", aliases: ["ukrainian", "українська", "uk"] },
    { code: "id", label: "Indonesian", aliases: ["indonesian", "bahasa indonesia", "id"] },
    { code: "vi", label: "Vietnamese", aliases: ["vietnamese", "tiếng việt", "vi"] },
    { code: "th", label: "Thai", aliases: ["thai", "ภาษาไทย", "th"] },
    { code: "da", label: "Danish", aliases: ["danish", "dansk", "da"] },
    { code: "ga", label: "Irish", aliases: ["irish", "gaelic", "gaeilge", "ga"] },
    { code: "ms", label: "Malay", aliases: ["malay", "bahasa melayu", "ms"] },
    { code: "yue", label: "Cantonese", aliases: ["cantonese", "粵語", "yue"] },
];

const DEFAULT_LANGUAGE_CODE = 'en';

/**
 * Interface for language detection result
 */
export interface LanguageDetectionResult {
    sourceLanguageCode: string;
    targetLanguageCode: string;
    sourceLanguageName: string;
    targetLanguageName: string;
}

/**
 * Detects both source and target languages from mention text
 * Supports formats like "dub from English to Spanish" or just "dub in Spanish"
 * @param text The text of the Twitter mention
 * @returns Object containing both source and target language codes and names
 */
export function detectLanguages(text: string): LanguageDetectionResult {
    const lowerText = text.toLowerCase();
    logger.debug(`[🗣️ Lang] Detecting source and target languages from text: \"${lowerText.substring(0, 100)}...\"`);

    // Initialize with defaults (source: English, target: determine from text)
    let sourceLanguageCode = DEFAULT_LANGUAGE_CODE;
    let targetLanguageCode = detectLanguage(text); // Use existing function to get target language
    
    // Check for "from [language] to [language]" pattern
    const fromToPattern = /from\s+([a-zA-Z\u00C0-\u017F]+)\s+to\s+([a-zA-Z\u00C0-\u017F]+)/i;
    const fromToMatch = lowerText.match(fromToPattern);
    
    if (fromToMatch) {
        const potentialSourceLang = fromToMatch[1].toLowerCase();
        const potentialTargetLang = fromToMatch[2].toLowerCase();
        
        logger.debug(`[🗣️ Lang] Found "from/to" pattern. Source candidate: "${potentialSourceLang}", Target candidate: "${potentialTargetLang}"`);
        
        // Look up source language
        for (const lang of SUPPORTED_LANGUAGES) {
            if (lang.aliases.map(a => a.toLowerCase()).includes(potentialSourceLang)) {
                sourceLanguageCode = lang.code;
                logger.info(`[🗣️ Lang] Detected source language: ${lang.label} (${lang.code})`);
                break;
            }
        }
        
        // Look up target language
        for (const lang of SUPPORTED_LANGUAGES) {
            if (lang.aliases.map(a => a.toLowerCase()).includes(potentialTargetLang)) {
                targetLanguageCode = lang.code;
                logger.info(`[🗣️ Lang] Detected target language: ${lang.label} (${lang.code})`);
                break;
            }
        }
    } else {
        logger.debug(`[🗣️ Lang] No "from/to" pattern found. Using default source (${sourceLanguageCode}) and detected target (${targetLanguageCode})`);
    }

    // Handle Spanish special case mapping for target language
    if (targetLanguageCode === 'es') {
        logger.info(`[🗣️ Lang] Mapping detected target language 'es' to 'es_LA' for SpeechLab compatibility.`);
        targetLanguageCode = 'es_la';
    }

    return {
        sourceLanguageCode,
        targetLanguageCode,
        sourceLanguageName: getLanguageName(sourceLanguageCode),
        targetLanguageName: getLanguageName(targetLanguageCode)
    };
}

/**
 * Detects the target language requested in the mention text.
 * Uses simple keyword matching.
 * @param text The text of the Twitter mention.
 * @returns The detected language code (e.g., 'es') or the default ('en').
 */
export function detectLanguage(text: string): string {
    const lowerText = text.toLowerCase();
    logger.debug(`[🗣️ Lang] Detecting language from text: \"${lowerText.substring(0, 100)}...\"`);

    let detectedCode = DEFAULT_LANGUAGE_CODE; // Start with default
    let found = false;

    // --- Strategy 1: Look for patterns like "in spanish", "to french", "dub german" --- 
    const patternRegex = /(?:in|to|dub)\s+([a-zA-Z\u00C0-\u017F]+)/g; // Added global flag 'g'
    let matches;
    logger.debug(`[🗣️ Lang DEBUG] Checking for pattern: ${patternRegex}`);
    while ((matches = patternRegex.exec(lowerText)) !== null && !found) { // Stop if found
        const potentialLangName = matches[1];
        logger.debug(`[🗣️ Lang DEBUG] Found pattern match, potential language: ${potentialLangName}`);
        for (const lang of SUPPORTED_LANGUAGES) {
            if (lang.aliases.map(a => a.toLowerCase()).includes(potentialLangName)) {
                logger.info(`[🗣️ Lang] Detected language via pattern: ${lang.label} (${lang.code})`);
                detectedCode = lang.code;
                found = true;
                break; // Exit inner loop
            }
        }
    }
    if (!found) logger.debug(`[🗣️ Lang DEBUG] No valid language found using pattern regex.`);

    // --- Strategy 2: Check all words against aliases (Looser Match) --- 
    if (!found) { // Only run if not found by pattern
        logger.debug(`[🗣️ Lang DEBUG] No pattern match. Checking all words against aliases...`);
        const words = lowerText.split(/\s+|\p{P}/u).filter(Boolean); // Split by space or punctuation
        logger.debug(`[🗣️ Lang DEBUG] Words extracted: ${words.join(', ')}`);
        
        wordLoop: // Label for breaking outer loop
        for (const word of words) {
            for (const lang of SUPPORTED_LANGUAGES) {
                for (const alias of lang.aliases) {
                    // Check if the current word *exactly* matches an alias
                    if (word === alias.toLowerCase()) {
                        logger.debug(`[🗣️ Lang DEBUG] Found direct alias match: word="${word}", alias="${alias}", lang=${lang.code}`);
                        logger.info(`[🗣️ Lang] Detected language via alias match: ${lang.label} (${lang.code})`);
                        detectedCode = lang.code;
                        found = true;
                        break wordLoop; // Exit both inner loops
                    }
                }
            }
        }
         if (!found) logger.debug(`[🗣️ Lang DEBUG] No word matched any alias.`);
    }

    // --- Default --- 
    if (!found) {
        logger.info(`[🗣️ Lang] No specific language detected via pattern or alias, using default ${DEFAULT_LANGUAGE_CODE}`);
        // detectedCode is already DEFAULT_LANGUAGE_CODE
    }

    // --- ADDED: Map 'es' to 'es_LA' --- 
    if (detectedCode === 'es') {
        logger.info(`[🗣️ Lang] Mapping detected language 'es' to 'es_LA' for SpeechLab compatibility.`);
        return 'es_la';
    }
    // --- END ADDED MAPPING --- 

    return detectedCode;
}

/**
 * Gets the display name (label) for a given language code.
 * @param code The language code (e.g., 'es').
 * @returns The display name (e.g., 'Spanish') or the code itself if not found.
 */
export function getLanguageName(code: string): string {
    const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
    return lang ? lang.label : code; // Return label or code if label not found
} 