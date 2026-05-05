#!/bin/bash

API_KEY="${GEMINI_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "Error: Set GEMINI_API_KEY env var or pass as first argument"
  exit 1
fi

if [ -n "$1" ]; then
  API_KEY="$1"
fi

echo "Fetching models from Google Generative Language API..."
echo ""

curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$API_KEY&pageSize=100" | jq -r '.models[] | "\(.name) - \(.version) - \(.displayName)"' 2>/dev/null || \
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$API_KEY&pageSize=100" | jq -r '.models[].name' 2>/dev/null