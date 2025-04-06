"""
Python utility to scrape structured data from the SpacesDashboard leaderboard using nova-act.

This script requires the following:
1. Python 3.x installed.
2. Dependencies installed: pip install -r requirements.txt
3. NOVA_ACT_API_KEY environment variable set.

It scrapes the leaderboard and saves the data to ../leaderboard_data.json (relative to this script).
"""

import os
import json
import time # Added for timing
import re # Added for manual parsing
from pydantic import BaseModel, Field
import fire  # type: ignore
from nova_act import NovaAct

# --- Configuration ---
LEADERBOARD_URL = 'https://spacesdashboard.com/leaderboard'
OUTPUT_FILE = '../leaderboard_data.json' # Save in the project root
SCROLL_ATTEMPTS = 0 # Focus on first attempt only
MIN_ENTRIES_TARGET = 10 # Keep low for debugging

# --- Main Scraping Logic ---
def scrape_leaderboard(
    headless: bool = True,
    limit: int = MIN_ENTRIES_TARGET,
    scrolls: int = SCROLL_ATTEMPTS
):
    print(f"Starting Nova Act scraper...")
    print(f"Target URL: {LEADERBOARD_URL}")
    print(f"Headless mode: {headless}")
    print(f"Target entries: {limit}")

    if 'NOVA_ACT_API_KEY' not in os.environ:
        print("Error: NOVA_ACT_API_KEY environment variable not set.")
        return

    all_entries: list[dict] = []
    processed_keys = set() # Keep track of processed items (URL or title/host combo)

    try:
        with NovaAct(
            starting_page=LEADERBOARD_URL,
            headless=headless,
        ) as nova:

            print("NovaAct initialized. Attempting initial data extraction...")

            for i in range(scrolls + 1):
                print(f"--- Extraction attempt {i+1}/{scrolls+1} --- ({time.time()})")
                prompt = (
                    "Return the list of all the twitter spaces descriptions and links currently visible on this page. "
                    "Do not scroll."
                )
                print(f"({time.time()}) - Before nova.act call...")
                result = nova.act(
                    prompt
                )
                print(f"({time.time()}) - After nova.act call.")

                # --- Check for errors (Modified) ---
                if hasattr(result, 'error') and result.error:
                    print(f"NovaAct Error on attempt {i+1}: {result.error}")
                    if i < scrolls:
                         print(f"({time.time()}) - Attempting to scroll down and retry...")
                         nova.act("Scroll down the page once.")
                    continue # Try next scroll/attempt
                # --- End Check for errors ---
                
                # --- Process raw response --- Start Modification
                print(f"Attempt {i+1} completed. Processing response...")
                print(f"Raw response snippet (parsed): {str(result.parsed_response)[:200]}...")
                # Check for raw response attribute if parsed is None
                raw_agent_response = None
                if hasattr(result, 'raw_response'): # Check standard attribute name
                    raw_agent_response = result.raw_response
                    print(f"Raw response snippet (raw attr): {str(raw_agent_response)[:200]}...")
                elif hasattr(result, 'response'): # Check alternative attribute name
                     raw_agent_response = result.response
                     print(f"Raw response snippet (alt attr): {str(raw_agent_response)[:200]}...")

                extracted_data = result.parsed_response
                current_entries = []
                processed_manually = False

                # --- Try manual parsing if parsed_response failed and raw exists ---
                if not extracted_data and isinstance(raw_agent_response, str):
                    print("Parsed response is empty/None, attempting manual parse of raw string response.")
                    try:
                        # Simple regex to find "Title" - URL pairs
                        # Adjust regex based on actual raw_agent_response format if needed
                        matches = re.findall(r'\d+\.\s*\"(.*?)\"\s*-\s*(https?:\/\/[\w\.\/\-]+)', raw_agent_response, re.IGNORECASE)
                        if matches:
                            print(f"Manual parsing found {len(matches)} potential entries.")
                            for title, url in matches:
                                # Basic structure, might need enhancement
                                entry = {
                                    'spaceTitle': title.strip(),
                                    'direct_link_guess': url.strip() # Mark as guess
                                }
                                key = url.strip()
                                if key and key not in processed_keys:
                                    all_entries.append(entry)
                                    processed_keys.add(key)
                                    current_entries.append(entry) # Track for logging
                            processed_manually = True
                        else:
                            print("Manual parsing regex found no matches in the raw response.")
                    except Exception as parse_err:
                        print(f"Error during manual parsing: {parse_err}")
                # --- End Manual Parsing Logic ---

                # --- Process normally if not manually processed ---
                if not processed_manually:
                    try:
                        # Try to find the list of entries within the response
                        if isinstance(extracted_data, list):
                            current_entries = extracted_data
                        elif isinstance(extracted_data, dict):
                            # Look for a common key like 'entries' or the first list value
                            list_values = [v for v in extracted_data.values() if isinstance(v, list)]
                            if 'entries' in extracted_data and isinstance(extracted_data['entries'], list):
                                current_entries = extracted_data['entries']
                            elif list_values:
                                current_entries = list_values[0] # Take the first list found
                            else:
                                 print(f"Could not find a list of entries within the dictionary response: {list(extracted_data.keys())}")
                        else:
                            print(f"Unexpected response type: {type(extracted_data)}")

                        new_entries_count = 0
                        if current_entries and isinstance(current_entries, list):
                            for entry in current_entries:
                                if not isinstance(entry, dict):
                                    print(f"Skipping non-dictionary item in list: {entry}")
                                    continue

                                # Use .get() for safer access
                                direct_url = entry.get('directSpaceUrl') or entry.get('direct_space_url') # Try common variations
                                title = entry.get('spaceTitle') or entry.get('title')
                                host_url = entry.get('hostProfileUrl') or entry.get('host_profile_url')

                                # Deduplication logic using .get() results
                                key = direct_url if direct_url else (title, host_url)

                                if key and key not in processed_keys:
                                    all_entries.append(entry) # Append the raw dictionary
                                    processed_keys.add(key)
                                    new_entries_count += 1
                                elif not key:
                                    print(f"Skipping entry with empty key: {entry}")
                        else:
                             print(f"No list of entries found or processed in this attempt.")

                        print(f"Added {new_entries_count} new unique entries in this attempt.")
                    except Exception as e:
                        print(f"Error processing raw response data on attempt {i+1}: {e}")
                        import traceback
                        traceback.print_exc()

                # Check if we have enough entries
                if len(all_entries) >= limit:
                    print(f"Reached target of {limit} entries.")
                    break

                # Scroll down for the next attempt (if not the last loop)
                if i < scrolls:
                    print(f"Scrolling down ({i+1}/{scrolls})...")
                    nova.act("Scroll down the page once.")
                    # Optional: add a small delay after scroll
                    # import time
                    # time.sleep(2)

    except Exception as e:
        print(f"An unexpected error occurred during NovaAct session: {e}")

    print(f"--- Scraping finished. Found {len(all_entries)} total unique entries. ---")

    # Save the data
    if all_entries:
        try:
            output_path = os.path.join(os.path.dirname(__file__), OUTPUT_FILE)
            print(f"Saving data to {output_path}...")
            with open(output_path, 'w', encoding='utf-8') as f:
                # Dump the list of dictionaries directly
                json.dump(all_entries, f, indent=2, ensure_ascii=False)
            print("Data saved successfully.")
        except Exception as e:
            print(f"Error saving data to file: {e}")
    else:
        print("No entries found or extracted.")

if __name__ == "__main__":
    fire.Fire(scrape_leaderboard) 