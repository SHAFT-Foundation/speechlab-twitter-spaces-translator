import { chromium, Browser, Page, Locator } from 'playwright'; // Use Playwright
import logger from '../utils/logger';
import * as fs from 'fs'; // Import fs for file operations
import * as path from 'path'; // Import path

const LEADERBOARD_URL = 'https://spacesdashboard.com/leaderboard?lang=en&mode=7d';
const TWITTER_BASE_URL = 'https://x.com';
const OUTPUT_DATA_FILE_PATH = path.join(process.cwd(), 'leaderboard_data.json');

// --- Interface for structured data ---
export interface LeaderboardEntry {
    spaceTitle: string | null;
    hostProfileUrl: string | null;
    directSpaceUrl: string | null; // Link from PLAY button
}

// --- Selectors (Hypotheses - Need Verification) ---
const ROW_SELECTOR = 'table tbody tr';
// Selectors relative to the row (tr)
const HOST_PROFILE_LINK_SELECTOR = 'td:first-child a[href^="/u/"]'; // Get href
const SPACE_TITLE_SELECTOR = 'td:first-child div[title] a';      // Get textContent
// Direct space link (PLAY button's link) - assuming it's in one of the later cells
const DIRECT_SPACE_LINK_SELECTOR = 'td a:has(i.fa-play-circle), td a[href^="https://x.com/i/spaces/"]';

/**
 * Saves the structured leaderboard data to a JSON file.
 * @param data Array of LeaderboardEntry objects.
 */
function saveLeaderboardDataToFile(data: LeaderboardEntry[]): void {
    try {
        logger.info(`[📊 Scraper] Saving ${data.length} leaderboard entries to ${OUTPUT_DATA_FILE_PATH}...`);
        fs.writeFileSync(OUTPUT_DATA_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
        logger.info(`[📊 Scraper] ✅ Successfully saved data to ${OUTPUT_DATA_FILE_PATH}`);
    } catch (error) {
        logger.error(`[📊 Scraper] ❌ Error saving leaderboard data to ${OUTPUT_DATA_FILE_PATH}:`, error);
    }
}

/**
 * Fetches structured data from the SpacesDashboard leaderboard using Playwright
 * and saves it to leaderboard_data.json.
 * @param {number} [limit=50] Limit the number of rows processed for testing/efficiency.
 * @returns {Promise<LeaderboardEntry[]>} A promise that resolves with an array of LeaderboardEntry objects.
 */
export async function fetchLeaderboardData(limit: number = 50): Promise<LeaderboardEntry[]> {
    logger.info(`[📊 Scraper] Starting Playwright fetch for structured leaderboard data (limit: ${limit})...`);
    let browser: Browser | null = null;
    const leaderboardEntries: LeaderboardEntry[] = [];

    try {
        logger.debug('[📊 Scraper] Launching Playwright browser...');
        // Keep headless: true for automation unless debugging needed
        browser = await chromium.launch({ headless: true });
        const page: Page = await browser.newPage();
        logger.debug(`[📊 Scraper] Navigating to ${LEADERBOARD_URL}...`);
        await page.goto(LEADERBOARD_URL, { waitUntil: 'networkidle', timeout: 120000 });
        logger.debug('[📊 Scraper] Page navigation complete (networkidle).');

        logger.debug(`[📊 Scraper] Waiting for table rows selector: "${ROW_SELECTOR}"...`);
        // Wait for the first row to be attached to ensure the table structure is likely there
        await page.locator(ROW_SELECTOR).first().waitFor({ state: 'attached', timeout: 30000 });
        logger.debug('[📊 Scraper] Table rows detected. Locating all rows...');

        const rowLocators: Locator[] = await page.locator(ROW_SELECTOR).all();
        logger.info(`[📊 Scraper] Found ${rowLocators.length} table rows.`);

        let processedCount = 0;
        for (const row of rowLocators) {
            if (processedCount >= limit) {
                logger.info(`[📊 Scraper] Reached processing limit of ${limit} rows.`);
                break;
            }
            processedCount++;
            logger.debug(`[📊 Scraper] Processing row ${processedCount}...`);

            let entry: LeaderboardEntry = {
                spaceTitle: null,
                hostProfileUrl: null,
                directSpaceUrl: null,
            };

            try {
                // Extract Host Profile URL
                const hostLink = row.locator(HOST_PROFILE_LINK_SELECTOR).first();
                const hostHref = await hostLink.getAttribute('href', { timeout: 2000 }); // Short timeout per element
                if (hostHref) {
                    const username = hostHref.substring(3);
                    if (username) {
                        entry.hostProfileUrl = `${TWITTER_BASE_URL}/${username}`;
                    }
                }

                // Extract Space Title
                const titleLink = row.locator(SPACE_TITLE_SELECTOR).first();
                 // Check visibility briefly before getting text
                if (await titleLink.isVisible({ timeout: 1000 })) {
                    entry.spaceTitle = await titleLink.textContent({ timeout: 2000 });
                    // Clean up whitespace
                    entry.spaceTitle = entry.spaceTitle?.trim() || null;
                } else {
                    // Fallback: try getting the 'title' attribute of the parent div if link text fails
                    const titleDiv = row.locator('td:first-child div[title]').first();
                    if(await titleDiv.isVisible({timeout: 500})) {
                        entry.spaceTitle = await titleDiv.getAttribute('title', { timeout: 1000 });
                        entry.spaceTitle = entry.spaceTitle?.trim() || null;
                    }
                }


                // Extract Direct Space URL (PLAY button link)
                const directLink = row.locator(DIRECT_SPACE_LINK_SELECTOR).first();
                entry.directSpaceUrl = await directLink.getAttribute('href', { timeout: 2000 });


                // Log extracted data for the row
                logger.debug(`[📊 Scraper] Row ${processedCount} Data: Title='${entry.spaceTitle}', Host='${entry.hostProfileUrl}', SpaceLink='${entry.directSpaceUrl}'`);
                leaderboardEntries.push(entry);

            } catch (rowError) {
                // Log error processing a specific row but continue with others
                logger.warn(`[📊 Scraper] Error processing row ${processedCount}: ${rowError instanceof Error ? rowError.message : String(rowError)}`);
            }
        } // End row loop

        if (leaderboardEntries.length === 0) {
             logger.warn('[📊 Scraper] No structured data entries were extracted. Check selectors or website behavior.');
        } else {
            logger.info(`[📊 Scraper] ✅ Successfully extracted data for ${leaderboardEntries.length} entries.`);
            saveLeaderboardDataToFile(leaderboardEntries);
        }

        return leaderboardEntries;

    } catch (error) {
        logger.error('[📊 Scraper] ❌ Error during Playwright fetch operation:', error);
         if (error instanceof Error && error.message.includes('timeout')) {
             logger.error('[📊 Scraper] Timeout occurred. The page might not have loaded correctly or selectors are wrong.');
         }
        return []; // Return empty array on failure
    } finally {
        if (browser) {
            logger.debug('[📊 Scraper] Closing Playwright browser...');
            await browser.close().catch(e => logger.warn('[📊 Scraper] Error closing browser:', e));
        }
    }
} 