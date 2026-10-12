#!/bin/bash
# Quick test script for SC-Agent CLI

set -e

echo "Building project..."
npm run build

echo ""
echo "Starting test chat session..."
echo "You can test with:"
echo "  - 'list files in this directory'"
echo "  - 'read the package.json file'"
echo "  - 'search for the word Agent in all TypeScript files'"
echo ""

node bin/sc.js chat "$@"
