#!/bin/bash
# Restart the YOBNH web terminal. Kills any running server.js process (no
# matter how it was started), then relaunches it in the directory it was
# previously running from (reusing its node_modules/config), falling back to
# this script's directory.
set -u

OLD_DIRS=()
for pid in $(pgrep -f "server\.js" 2>/dev/null); do
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)"
  if [ -n "$cwd" ] && [ -f "$cwd/server.js" ]; then
    OLD_DIRS+=("$cwd")
    kill -9 "$pid" 2>/dev/null || true
  fi
done
sleep 1

TARGET=""
for d in "${OLD_DIRS[@]}"; do
  if [ -f "$d/server.js" ]; then
    TARGET="$d"
    break
  fi
done
if [ -z "$TARGET" ]; then
  TARGET="$(cd "$(dirname "$0")" && pwd)"
fi

cd "$TARGET"
npm install --no-audit --no-fund >/dev/null 2>&1
nohup node server.js > terminal.log 2>&1 &
echo "terminal restarted in $TARGET"
