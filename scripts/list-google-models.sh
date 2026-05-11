#!/bin/bash
# List available Google Gemini models via gcloud or curl
# Requires GOOGLE_API_KEY environment variable

if [ -z "$GOOGLE_API_KEY" ]; then
    echo "Error: GOOGLE_API_KEY is not set."
    exit 1
fi

curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY" | \
    jq -r '.models[] | select(.name | startswith("models/gemini")) | .name' | \
    sed 's/models\///'
