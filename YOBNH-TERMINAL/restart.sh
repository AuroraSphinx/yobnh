#!/bin/bash
# Restart the YOBNH web terminal.
#  1. Kills any running server.js process (no matter how it was started).
#  2. Launches the terminal from THIS folder (fresh code from the repo),
#     installing dependencies first if needed.
#  3. Falls back to the previously-running folder if the install fails here.
# All server output goes to terminal.log next to the server.
{
  set -u

  # Collect folders the terminal was running from, then stop those processes.
  OLD_DIRS=()
  for pid in $(pgrep -f "server\.js" 2>/dev/null); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)"
    if [ -n "$cwd" ] && [ -f "$cwd/server.js" ]; then
      OLD_DIRS+=("$cwd")
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  sleep 1

  # Prefer the folder that holds this script (fresh code from the repo).
  SELF="$(cd "$(dirname "$0")" && pwd)"
  TARGET="$SELF"

  if [ ! -d "$TARGET/node_modules" ]; then
    (cd "$TARGET" && npm install --no-audit --no-fund >/dev/null 2>&1)
  fi

  if [ ! -d "$TARGET/node_modules" ]; then
    # Dependency install failed here; reuse the previously-running folder.
    for d in "${OLD_DIRS[@]}"; do
      if [ -f "$d/server.js" ]; then
        TARGET="$d"
        break
      fi
    done
  fi

  cd "$TARGET"
  nohup node server.js >> terminal.log 2>&1 &
  sleep 2

  if curl -s -o /dev/null "http://localhost:8080/ws-config"; then
    echo "terminal restarted in $TARGET (OK)"
  else
    echo "terminal FAILED to start in $TARGET -- see terminal.log"
  fi
}
