#!/bin/bash
# Quick script to view recent errors from error_log.json

echo "==================================="
echo "Recent Errors (Last 10)"
echo "==================================="

if [ -f error_log.json ]; then
    # Show last 10 errors sorted by timestamp
    cat error_log.json | jq -r 'to_entries | sort_by(.value.timestamp) | reverse | .[:10] | .[] | "Tweet ID: \(.key)\nPhase: \(.value.phase)\nError: \(.value.error)\nCount: \(.value.count)\nTimestamp: \(.value.timestamp)\n---"'

    echo ""
    echo "==================================="
    echo "Error Summary by Type"
    echo "==================================="

    # Group errors by type and count
    cat error_log.json | jq -r 'group_by(.error) | .[] | "\(.length) occurrences: \(.[0].error)"' | sort -rn

else
    echo "No error_log.json file found"
fi
