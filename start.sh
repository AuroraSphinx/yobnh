#!/bin/bash
cd "$(dirname "$0")"
MODE="${1:-1}"
if [ -f dist/index.js ]; then
  exec node dist/index.js --mode=$MODE
else
  exec npx ts-node index.ts --mode=$MODE
fi
