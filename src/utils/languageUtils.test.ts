import { detectLanguage } from './languageUtils';
import assert from 'assert';

// Simple Test Suite
console.log('🧪 Running languageUtils Tests...');

// Test Case 1: Basic pattern
let text1 = "@speechlabai dub this in spanish";
let lang1 = detectLanguage(text1);
assert.strictEqual(lang1, 'es', 'Test Case 1 Failed: Basic Spanish');
console.log('✅ Test Case 1 Passed');

// Test Case 2: Direct alias match (case-insensitive)
let text2 = "@speechlabai German please";
let lang2 = detectLanguage(text2);
assert.strictEqual(lang2, 'de', 'Test Case 2 Failed: Direct German');
console.log('✅ Test Case 2 Passed');

// Test Case 3: Pattern later in string
let text3 = "@speechlabai can you process to French?";
let lang3 = detectLanguage(text3);
assert.strictEqual(lang3, 'fr', 'Test Case 3 Failed: Pattern later');
console.log('✅ Test Case 3 Passed');

// Test Case 4: No language mentioned - Default
let text4 = "@speechlabai dub this";
let lang4 = detectLanguage(text4);
assert.strictEqual(lang4, 'en', 'Test Case 4 Failed: Default English');
console.log('✅ Test Case 4 Passed');

// Test Case 5: Alias with accent
let text5 = "@speechlabai dub this in Español";
let lang5 = detectLanguage(text5);
assert.strictEqual(lang5, 'es', 'Test Case 5 Failed: Alias with accent');
console.log('✅ Test Case 5 Passed');

// Test Case 6: Non-English alias
let text6 = "@speechlabai dub this in 日本語";
let lang6 = detectLanguage(text6);
assert.strictEqual(lang6, 'ja', 'Test Case 6 Failed: Japanese alias');
console.log('✅ Test Case 6 Passed');

// Test Case 7: Direct alias match without pattern
let text7 = "@speechlabai Korean";
let lang7 = detectLanguage(text7);
assert.strictEqual(lang7, 'ko', 'Test Case 7 Failed: Korean direct alias');
console.log('✅ Test Case 7 Passed');

// Test Case 8: Language mentioned with punctuation
let text8 = "@speechlabai, can you dub this to italian.";
let lang8 = detectLanguage(text8);
assert.strictEqual(lang8, 'it', 'Test Case 8 Failed: Italian with punctuation');
console.log('✅ Test Case 8 Passed');

// Test Case 9: Multiple potential languages (should pick first match based on order/pattern)
let text9 = "@speechlabai dub this in spanish, not german";
let lang9 = detectLanguage(text9);
assert.strictEqual(lang9, 'es', 'Test Case 9 Failed: Multiple languages (pattern priority)');
console.log('✅ Test Case 9 Passed');

// Test Case 10: Your specific example
let text10 = "@speechlabai dub this in german";
let lang10 = detectLanguage(text10);
assert.strictEqual(lang10, 'de', 'Test Case 10 Failed: User example German');
console.log('✅ Test Case 10 Passed');

// Test Case 11: Chinese alias direct
let text11 = "@speechlabai Chinese";
let lang11 = detectLanguage(text11);
assert.strictEqual(lang11, 'zh', 'Test Case 11 Failed: Chinese alias direct');
console.log('✅ Test Case 11 Passed');

console.log('🎉 All languageUtils Tests Passed!'); 