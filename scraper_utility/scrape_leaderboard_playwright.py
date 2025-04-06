import os
import json
import time
import re
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from playwright_stealth import stealth_sync # Import stealth
import fire  # type: ignore

# --- Configuration ---
LEADERBOARD_URL = 'https://spacesdashboard.com/leaderboard'
OUTPUT_FILE = '../leaderboard_data_playwright.json' # Save in the project root relative to script dir
SCROLL_ATTEMPTS = 5 # How many times to scroll down
SCROLL_DELAY = 5 # Seconds to wait after each scroll for content to load
PAGE_LOAD_TIMEOUT = 60000 # Max time for page navigation (milliseconds)
LOCATOR_TIMEOUT = 20000 # Max time for finding elements (milliseconds)
INITIAL_WAIT_TIME = 5 # Seconds to wait after initial page load before interacting
MIN_ENTRIES_TARGET = 50 # Aim for at least this many entries (adjust as needed)
DEBUG_MODE = True # Take screenshots and log more details

def clean_text(text):
    """Utility function to clean whitespace from text."""
    return text.strip() if text else None

def extract_numeric(text):
    """Extracts the first number from a string."""
    if not text:
        return None
    match = re.search(r'\d[\d,]*', text.replace(',', ''))
    return int(match.group(0)) if match else None

def extract_data_from_row(row):
    """Extracts structured data from a single table row locator."""
    entry = {}
    try:
        # --- Host Info ---
        host_cell = row.locator('td:nth-child(1)')
        entry['host_name'] = clean_text(host_cell.locator('div >> div.ml-4 >> div.text-sm.font-medium >> a').first.text_content(timeout=LOCATOR_TIMEOUT / 5)) # Faster timeout for less critical items
        entry['host_handle'] = clean_text(host_cell.locator('div >> div.ml-4 >> div.text-sm.text-gray-500 >> a').first.text_content(timeout=LOCATOR_TIMEOUT / 5))
        entry['host_profile_url'] = host_cell.locator('div >> div.ml-4 >> div.text-sm.text-gray-500 >> a').first.get_attribute('href', timeout=LOCATOR_TIMEOUT / 5)
        entry['host_image_url'] = host_cell.locator('div >> div >> div >> a >> img').first.get_attribute('src', timeout=LOCATOR_TIMEOUT / 5)
        follower_count_str = clean_text(host_cell.locator('div >> div.ml-4 >> div.text-sm.text-gray-500 >> span.bg-blue-100').first.text_content(timeout=LOCATOR_TIMEOUT / 5))
        entry['host_follower_count'] = extract_numeric(follower_count_str.replace('k', '000')) if follower_count_str else None # Handle 'k'

        # --- Space Info ---
        space_cell = row.locator('td:nth-child(2)')
        space_link_element = space_cell.locator('div.text-md >> a').first
        entry['space_title'] = clean_text(space_link_element.text_content(timeout=LOCATOR_TIMEOUT)) # Important: Longer timeout
        entry['space_details_url'] = space_link_element.get_attribute('href', timeout=LOCATOR_TIMEOUT)

        details_text_elements = space_cell.locator('div.text-sm.text-gray-400 >> span')
        details_text_list = details_text_elements.all_text_contents()

        entry['space_language_flag_url'] = None
        flag_img = space_cell.locator('div.text-sm.text-gray-400 >> span:nth-child(1) >> img').first
        if flag_img.is_visible(timeout=100): # Quick check if flag exists
             entry['space_language_flag_url'] = flag_img.get_attribute('src')

        entry['space_ended_time_str'] = None
        entry['space_speakers_count'] = None
        entry['space_speaker_followers'] = None
        entry['space_duration_str'] = None

        for text in details_text_list:
            clean_t = clean_text(text)
            if not clean_t: continue
            if "Ended:" in clean_t:
                entry['space_ended_time_str'] = clean_t.replace('Ended:', '').strip()
            elif "Speakers:" in clean_t:
                entry['space_speakers_count'] = extract_numeric(clean_t)
            elif "Speaker followers:" in clean_t:
                entry['space_speaker_followers'] = extract_numeric(clean_t)
            elif "Duration:" in clean_t:
                entry['space_duration_str'] = clean_t.replace('Duration:', '').strip()
            # Handle case where 'Ended:' prefix might be missing (based on mobile view)
            elif entry['space_ended_time_str'] is None and any(month in clean_t for month in ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]):
                 entry['space_ended_time_str'] = clean_t # Assume it's the date if 'Ended:' not found yet

        # --- Listener Count ---
        listener_cell = row.locator('td:nth-child(3)')
        listener_count_str = clean_text(listener_cell.locator('span').first.text_content(timeout=LOCATOR_TIMEOUT / 2))
        entry['listener_count'] = extract_numeric(listener_count_str)

        # --- Direct Play URL ---
        action_cell = row.locator('td:nth-child(5)')
        play_link = action_cell.locator('div >> a[href*="x.com/i/spaces/"]').first
        entry['direct_play_url'] = play_link.get_attribute('href', timeout=LOCATOR_TIMEOUT / 2) if play_link.is_visible(timeout=100) else None

        # --- Topics ---
        topic_elements = space_cell.locator('div.flex.items-center.flex-wrap >> a')
        entry['topics'] = [clean_text(topic.text_content()) for topic in topic_elements.all()]

        # --- Speaker Avatars (Optional) ---
        avatar_elements = space_cell.locator('div.hidden.lg\\:block >> div.flex >> a >> img')
        entry['speaker_avatar_urls'] = [avatar.get_attribute('src') for avatar in avatar_elements.all()]

        # --- Generate unique key ---
        entry['id'] = entry['space_details_url'] or entry['direct_play_url'] or f"{entry.get('host_handle', 'unknown')}-{entry.get('space_title', 'unknown')}"

        return entry

    except PlaywrightTimeoutError as pe:
        print(f"Timeout error processing row: {pe}")
        # Try to get at least the main link if possible
        fallback_id = None
        try:
            fallback_id = row.locator('td:nth-child(2) >> div.text-md >> a').first.get_attribute('href', timeout=500)
        except Exception:
            pass
        print(f"Row likely incomplete. Fallback ID attempt: {fallback_id}")
        return {"id": fallback_id or f"error_row_{time.time()}", "error": str(pe)} # Return partial data with error flag
    except Exception as e:
        print(f"Unexpected error processing row: {e}")
        import traceback
        traceback.print_exc()
        return {"id": f"error_row_{time.time()}", "error": str(e)} # Return partial data with error flag


def scrape_leaderboard_playwright(
    headless: bool = True,
    limit: int = MIN_ENTRIES_TARGET,
    scrolls: int = SCROLL_ATTEMPTS,
    debug: bool = DEBUG_MODE
):
    print(f"--- Starting Playwright Scraper ---")
    print(f"Target URL: {LEADERBOARD_URL}")
    print(f"Headless mode: {headless}")
    print(f"Target entries: ~{limit} (will stop scrolling if reached)")
    print(f"Max scroll attempts: {scrolls}")
    print(f"Debug mode: {debug}")

    all_entries = {} # Use dict for easy deduplication by key

    with sync_playwright() as p:
        browser = None
        try:
            browser = p.chromium.launch(headless=headless)
            page = browser.new_page()
            stealth_sync(page) # Apply stealth

            print(f"Navigating to {LEADERBOARD_URL}...")
            page.goto(LEADERBOARD_URL, timeout=PAGE_LOAD_TIMEOUT, wait_until='networkidle')
            print(f"Page loaded. Waiting {INITIAL_WAIT_TIME} seconds for content to render...")
            time.sleep(INITIAL_WAIT_TIME)
            
            if debug:
                print("Taking initial screenshot...")
                page.screenshot(path="debug_initial_load.png")
                print("Screenshot saved as debug_initial_load.png")
                
                # Log page information
                print("Page title:", page.title())
                print("Current URL:", page.url)
                
                # Check for any visible tables
                table_count = page.locator('table').count()
                print(f"Found {table_count} tables on page")
                
                # Check for tbody elements
                tbody_count = page.locator('tbody').count()
                print(f"Found {tbody_count} tbody elements on page")
                
                # Check for tr elements (regardless of parent)
                tr_count = page.locator('tr').count()
                print(f"Found {tr_count} tr elements on page")
                
                # Log the HTML structure to help debug
                print("HTML structure around table (if any):")
                table_html = page.locator('table').first.inner_html() if table_count > 0 else "No table found"
                print(table_html[:1000] + "..." if len(table_html) > 1000 else table_html)

            # Try different selectors to find the table and rows
            print("Attempting to find table data using multiple selector strategies...")
            
            # Strategy 1: Original selectors
            table_body1 = page.locator('tbody.bg-white.divide-y.divide-gray-20').first
            rows1 = page.locator('tbody.bg-white.divide-y.divide-gray-20 >> tr.hidden.md\\:table-row')
            count1 = rows1.count()
            print(f"Strategy 1 (original selectors): Found {count1} rows")
            
            # Strategy 2: Simplified selectors
            rows2 = page.locator('tbody >> tr').all()
            count2 = len(rows2) if rows2 else 0
            print(f"Strategy 2 (simplified selectors): Found {count2} rows")
            
            # Strategy 3: Even more general
            rows3 = page.locator('table tr').all()
            count3 = len(rows3) if rows3 else 0
            print(f"Strategy 3 (general selector): Found {count3} rows")
            
            # Decide which strategy to use
            if count1 > 0:
                print("Using original selectors for data extraction")
                table_body = table_body1
                rows = rows1
                row_count = count1
            elif count2 > 0:
                print("Using simplified selectors for data extraction")
                table_body = page.locator('tbody').first
                rows = page.locator('tbody >> tr')
                row_count = count2
            elif count3 > 0:
                print("Using general selectors for data extraction")
                table_body = page.locator('table').first
                rows = page.locator('table tr')
                row_count = count3
            else:
                if debug:
                    print("No table rows found with any strategy. Taking debug screenshot...")
                    page.screenshot(path="debug_no_rows_found.png")
                    
                    # Try to find any element with text content to see what's on the page
                    text_elements = page.locator('body *:not(script):not(style)').all()
                    print(f"Found {len(text_elements)} text elements on page. First 10 elements:")
                    for i, elem in enumerate(text_elements[:10]):
                        try:
                            text = elem.text_content().strip()
                            if text:
                                print(f"Element {i+1}: {text[:100]}")
                        except Exception as e:
                            print(f"Error getting text content: {e}")
                
                print("ERROR: No table rows found with any selector strategy")
                return
            
            print(f"Found {row_count} rows to process")
            
            # --- Data Extraction ---
            print("--- Starting Data Extraction ---")
            processed_count = 0
            error_count = 0
            
            for i in range(row_count):
                if len(all_entries) >= limit:
                    print(f"Reached target limit of {limit} unique entries. Stopping extraction.")
                    break

                print(f"Processing row {i+1}/{row_count}...")
                row = rows.nth(i)
                
                # Try to debug the row structure before extraction
                if debug and i == 0:
                    try:
                        print(f"First row HTML structure:")
                        row_html = row.inner_html()
                        print(row_html[:1000] + "..." if len(row_html) > 1000 else row_html)
                        
                        # Check column count
                        columns = row.locator('td').all()
                        print(f"First row has {len(columns)} columns")
                        for j, col in enumerate(columns):
                            try:
                                col_text = col.text_content().strip()
                                print(f"Column {j+1}: {col_text[:50]}")
                            except Exception as e:
                                print(f"Error getting column text: {e}")
                    except Exception as e:
                        print(f"Error debugging row: {e}")
                
                try:
                    entry_data = extract_data_from_row(row)
                    
                    if entry_data and entry_data.get('id'):
                        if entry_data['id'] not in all_entries:
                            if 'error' not in entry_data:
                                all_entries[entry_data['id']] = entry_data
                                processed_count += 1
                                print(f"-> Added entry: {entry_data.get('space_title', 'N/A')} by {entry_data.get('host_handle', 'N/A')} (Total: {len(all_entries)})")
                            else:
                                error_count += 1
                                print(f"-> Skipped row {i+1} due to processing error: {entry_data['error']}")
                        else:
                            print(f"-> Skipped duplicate entry: {entry_data.get('space_title', 'N/A')} by {entry_data.get('host_handle', 'N/A')}")
                    else:
                        error_count += 1
                        print(f"-> Failed to process or get ID for row {i+1}.")
                except Exception as e:
                    print(f"Exception processing row {i+1}: {e}")
                    import traceback
                    traceback.print_exc()
                    error_count += 1

            print(f"--- Extraction finished ---")
            print(f"Successfully processed: {processed_count} new entries.")
            print(f"Encountered errors/skipped: {error_count} rows.")
            print(f"Total unique entries collected: {len(all_entries)}")

            browser.close()

        except PlaywrightTimeoutError as e:
            print(f"Playwright Timeout Error: {e}")
        except Exception as e:
            print(f"An unexpected error occurred during Playwright session: {e}")
            import traceback
            traceback.print_exc()
        finally:
            if browser: # Check if browser was successfully initialized
                print("Closing browser...")
                browser.close()

    # --- Save Data ---
    entries_list = list(all_entries.values())
    if entries_list:
        try:
            # Construct the output path relative to this script's directory
            script_dir = os.path.dirname(__file__)
            output_path = os.path.abspath(os.path.join(script_dir, OUTPUT_FILE))
            print(f"Saving data to {output_path}...")
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(entries_list, f, indent=2, ensure_ascii=False)
            print("Data saved successfully.")
        except Exception as e:
            print(f"Error saving data to file: {e}")
    else:
        print("No entries collected or processed successfully.")

if __name__ == "__main__":
    # Before running playwright install, ensure the user has installed it
    print("Make sure you have run 'playwright install' in your terminal.")
    fire.Fire(scrape_leaderboard_playwright) 