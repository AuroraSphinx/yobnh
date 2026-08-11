#!/usr/bin/env bash
set -e

# ====== config ======
BOT_DIR="${BOT_DIR:-/opt/bot}"          # where the bot's package.json lives
TMUX_SESSION="${TMUX_SESSION:-bot}"     # must match tmuxSession in config.js
BUILD_CMD="${BUILD_CMD:-npm run build}" # builds the TypeScript
START_CMD="${START_CMD:-node dist/index.js}"
# ====================

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found. Install it:  sudo apt install tmux -y"
  exit 1
fi

cd "$BOT_DIR"

echo "[1/3] installing dependencies..."
npm install

echo "[2/3] building TypeScript..."
$BUILD_CMD

echo "[3/3] restarting bot in tmux session '$TMUX_SESSION'..."
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" "cd '$BOT_DIR' && $START_CMD"

echo "Done. Bot running in tmux session '$TMUX_SESSION'."
echo "Open the web terminal to see it live, or run:  tmux attach -t $TMUX_SESSION"
