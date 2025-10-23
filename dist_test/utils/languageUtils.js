"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectLanguages = detectLanguages;
exports.detectLanguage = detectLanguage;
exports.getLanguageName = getLanguageName;
var logger_1 = __importDefault(require("./logger"));
// Supported languages based on user input
var SUPPORTED_LANGUAGES = [
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
var DEFAULT_LANGUAGE_CODE = 'en';
/**
 * Detects both source and target languages from mention text
 * Supports formats like "dub from English to Spanish" or just "dub in Spanish"
 * @param text The text of the Twitter mention
 * @returns Object containing both source and target language codes and names
 */
function detectLanguages(text) {
    var lowerText = text.toLowerCase();
    logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang] Detecting source and target languages from text: \"".concat(lowerText.substring(0, 100), "...\""));
    // Initialize with defaults (source: English, target: determine from text)
    var sourceLanguageCode = DEFAULT_LANGUAGE_CODE;
    var targetLanguageCode = detectLanguage(text); // Use existing function to get target language
    // Check for "from [language] to [language]" pattern
    var fromToPattern = /from\s+([a-zA-Z\u00C0-\u017F]+)\s+to\s+([a-zA-Z\u00C0-\u017F]+)/i;
    var fromToMatch = lowerText.match(fromToPattern);
    if (fromToMatch) {
        var potentialSourceLang = fromToMatch[1].toLowerCase();
        var potentialTargetLang = fromToMatch[2].toLowerCase();
        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang] Found \"from/to\" pattern. Source candidate: \"".concat(potentialSourceLang, "\", Target candidate: \"").concat(potentialTargetLang, "\""));
        // Look up source language
        for (var _i = 0, SUPPORTED_LANGUAGES_1 = SUPPORTED_LANGUAGES; _i < SUPPORTED_LANGUAGES_1.length; _i++) {
            var lang = SUPPORTED_LANGUAGES_1[_i];
            if (lang.aliases.map(function (a) { return a.toLowerCase(); }).includes(potentialSourceLang)) {
                sourceLanguageCode = lang.code;
                logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] Detected source language: ".concat(lang.label, " (").concat(lang.code, ")"));
                break;
            }
        }
        // Look up target language
        for (var _a = 0, SUPPORTED_LANGUAGES_2 = SUPPORTED_LANGUAGES; _a < SUPPORTED_LANGUAGES_2.length; _a++) {
            var lang = SUPPORTED_LANGUAGES_2[_a];
            if (lang.aliases.map(function (a) { return a.toLowerCase(); }).includes(potentialTargetLang)) {
                targetLanguageCode = lang.code;
                logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] Detected target language: ".concat(lang.label, " (").concat(lang.code, ")"));
                break;
            }
        }
    }
    else {
        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang] No \"from/to\" pattern found. Using default source (".concat(sourceLanguageCode, ") and detected target (").concat(targetLanguageCode, ")"));
    }
    // Handle Spanish special case mapping for target language
    if (targetLanguageCode === 'es') {
        logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] Mapping detected target language 'es' to 'es_LA' for SpeechLab compatibility.");
        targetLanguageCode = 'es_la';
    }
    return {
        sourceLanguageCode: sourceLanguageCode,
        targetLanguageCode: targetLanguageCode,
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
function detectLanguage(text) {
    var lowerText = text.toLowerCase();
    logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang] Detecting language from text: \"".concat(lowerText.substring(0, 100), "...\""));
    var detectedCode = DEFAULT_LANGUAGE_CODE; // Start with default
    var found = false;
    // --- Strategy 1: Look for patterns like "in spanish", "to french", "dub german" --- 
    var patternRegex = /(?:in|to|dub)\s+([a-zA-Z\u00C0-\u017F]+)/g; // Added global flag 'g'
    var matches;
    logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] Checking for pattern: ".concat(patternRegex));
    while ((matches = patternRegex.exec(lowerText)) !== null && !found) { // Stop if found
        var potentialLangName = matches[1];
        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] Found pattern match, potential language: ".concat(potentialLangName));
        for (var _i = 0, SUPPORTED_LANGUAGES_3 = SUPPORTED_LANGUAGES; _i < SUPPORTED_LANGUAGES_3.length; _i++) {
            var lang = SUPPORTED_LANGUAGES_3[_i];
            if (lang.aliases.map(function (a) { return a.toLowerCase(); }).includes(potentialLangName)) {
                logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] Detected language via pattern: ".concat(lang.label, " (").concat(lang.code, ")"));
                detectedCode = lang.code;
                found = true;
                break; // Exit inner loop
            }
        }
    }
    if (!found)
        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] No valid language found using pattern regex.");
    // --- Strategy 2: Check all words against aliases (Looser Match) --- 
    if (!found) { // Only run if not found by pattern
        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] No pattern match. Checking all words against aliases...");
        var words = lowerText.split(/\s+|\p{P}/u).filter(Boolean); // Split by space or punctuation
        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] Words extracted: ".concat(words.join(', ')));
        wordLoop: // Label for breaking outer loop
         for (var _a = 0, words_1 = words; _a < words_1.length; _a++) {
            var word = words_1[_a];
            for (var _b = 0, SUPPORTED_LANGUAGES_4 = SUPPORTED_LANGUAGES; _b < SUPPORTED_LANGUAGES_4.length; _b++) {
                var lang = SUPPORTED_LANGUAGES_4[_b];
                for (var _c = 0, _d = lang.aliases; _c < _d.length; _c++) {
                    var alias = _d[_c];
                    // Check if the current word *exactly* matches an alias
                    if (word === alias.toLowerCase()) {
                        logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] Found direct alias match: word=\"".concat(word, "\", alias=\"").concat(alias, "\", lang=").concat(lang.code));
                        logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] Detected language via alias match: ".concat(lang.label, " (").concat(lang.code, ")"));
                        detectedCode = lang.code;
                        found = true;
                        break wordLoop; // Exit both inner loops
                    }
                }
            }
        }
        if (!found)
            logger_1.default.debug("[\uD83D\uDDE3\uFE0F Lang DEBUG] No word matched any alias.");
    }
    // --- Default --- 
    if (!found) {
        logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] No specific language detected via pattern or alias, using default ".concat(DEFAULT_LANGUAGE_CODE));
        // detectedCode is already DEFAULT_LANGUAGE_CODE
    }
    // --- ADDED: Map 'es' to 'es_LA' --- 
    if (detectedCode === 'es') {
        logger_1.default.info("[\uD83D\uDDE3\uFE0F Lang] Mapping detected language 'es' to 'es_LA' for SpeechLab compatibility.");
        return 'es_la';
    }
    // --- END ADDED MAPPING --- 
    return detectedCode;
}
/**
 * Gets the display name (label) for a given language code.
 * @param code The language code (e.g., 'es', 'es_la').
 * @returns The display name (e.g., 'Spanish') or the code itself if not found.
 */
function getLanguageName(code) {
    // Handle special case for es_la - map it to Spanish
    if (code === 'es_la') {
        return 'Spanish';
    }
    var lang = SUPPORTED_LANGUAGES.find(function (l) { return l.code === code; });
    return lang ? lang.label : code; // Return label or code if label not found
}
