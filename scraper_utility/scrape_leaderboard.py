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
from pydantic import BaseModel, Field
import fire  # type: ignore
from nova_act import NovaAct

# --- Configuration ---
LEADERBOARD_URL = 'https://spacesdashboard.com/leaderboard?lang=en&mode=7d'
OUTPUT_FILE = '../leaderboard_data.json' # Save in the project root
SCROLL_ATTEMPTS = 5 # How many times to scroll down
MIN_ENTRIES_TARGET = 50 # Aim for at least this many entries (adjust as needed)

# --- Pydantic Model for Expected Data Structure ---
class LeaderboardEntry(BaseModel):
    # Use Field descriptions matching the desired data
    spaceTitle: str | None = Field(None)
    hostProfileUrl: str | None = Field(None)
    directSpaceUrl: str | None = Field(None)

class LeaderboardList(BaseModel):
    entries: list[LeaderboardEntry]

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

    all_entries: list[LeaderboardEntry] = []
    processed_keys = set() # Keep track of processed items (URL or title/host combo)

    try:
        with NovaAct(
            starting_page=LEADERBOARD_URL,
            headless=headless,
        ) as nova:

            print("NovaAct initialized. Attempting initial data extraction...")

            for i in range(scrolls + 1): # Initial load + number of scrolls
                print(f"--- Extraction attempt {i+1}/{scrolls+1} ---")
                prompt = (
                    "Examine the list of Twitter Spaces on the leaderboard. For each distinct entry, extract the following: "
                    "1. The main title or topic of the space (map to 'spaceTitle'). "
                    "2. The URL link to the host's profile (map to 'hostProfileUrl'). "
                    "3. The URL associated with the 'Play' button or icon for that specific space entry (map to 'directSpaceUrl'). "
                    "Return the results as a list of objects matching the provided schema."
                )
                result = nova.act(
                    prompt,
                    schema=LeaderboardList.model_json_schema(),
                    # Add timeout? Check nova-act docs if needed
                )

                # --- Check for errors (Modified) ---
                # Check if the 'error' attribute exists AND if it has a value
                if hasattr(result, 'error') and result.error:
                    print(f"NovaAct Error on attempt {i+1}: {result.error}")
                    if i < scrolls:
                         print("Attempting to scroll down and retry...")
                         nova.act("Scroll down the page once.")
                    continue # Try next scroll/attempt
                # --- End Check for errors ---
                
                # Now check schema match separately
                if not result.matches_schema:
                    print(f"Schema mismatch on attempt {i+1}. Raw response snippet: {str(result.parsed_response)[:200]}...")
                    # Optionally log full result.parsed_response if debugging schema issues
                    if i < scrolls:
                         print("Attempting to scroll down and retry...")
                         nova.act("Scroll down the page once.")
                    continue # Try next scroll/attempt
                else:
                    # --- Process successful schema match ---
                    print(f"Schema matched on attempt {i+1}.")
                    try:
                        extracted_data = LeaderboardList.model_validate(result.parsed_response)
                        new_entries_count = 0
                        if extracted_data.entries:
                            for entry in extracted_data.entries:
                                # Use directSpaceUrl if available, otherwise use (title, host) tuple
                                key = entry.directSpaceUrl if entry.directSpaceUrl else (entry.spaceTitle, entry.hostProfileUrl)
                                
                                # Add entry if the key is not None/empty and not already processed
                                if key and key not in processed_keys:
                                     all_entries.append(entry)
                                     processed_keys.add(key)
                                     new_entries_count += 1
                                elif not key:
                                     print(f"Skipping entry with empty key: {entry}") # Log skipped entries
                        print(f"Added {new_entries_count} new unique entries in this attempt.")
                    except Exception as e:
                        print(f"Error validating/processing response data on attempt {i+1}: {e}")

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
                json.dump([entry.dict() for entry in all_entries], f, indent=2, ensure_ascii=False)
            print("Data saved successfully.")
        except Exception as e:
            print(f"Error saving data to file: {e}")
    else:
        print("No entries found or extracted.")

if __name__ == "__main__":
    fire.Fire(scrape_leaderboard) 