#!/bin/bash
# deploy.sh - Git pull & restart all services (generic)
# Called by webhook server on push to main
#
# Usage:
#   deploy.sh --config <path>

set -euo pipefail

# --- Parse options ---
CONFIG_FILE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        *)
            echo "Usage: deploy.sh --config <path>" >&2
            exit 1
            ;;
    esac
done

if [ -z "$CONFIG_FILE" ]; then
    echo "Error: --config is required" >&2
    echo "Usage: deploy.sh --config <path>" >&2
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE" >&2
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required" >&2
    exit 1
fi

# --- Read config ---
expand_home() {
    eval echo "$1"
}

REPO_DIR=$(expand_home "$(jq -r '.repoDir' "$CONFIG_FILE")")
AUTH_TYPE=$(jq -r '.auth.type // "gh-cli"' "$CONFIG_FILE")

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/logs/deploy.log"

# Unset TMUX env var (may be inherited from server.js running inside tmux)
unset TMUX
TMUX_CMD="/opt/homebrew/bin/tmux -S /tmp/tmux-$(id -u)/default"
INIT='eval "$(/opt/homebrew/bin/brew shellenv)" && eval "$(mise activate bash)"'

mkdir -p "$(dirname "$LOG")"

# Redirect all output to log
exec >> "$LOG" 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "=== Deploy started ==="

# 0. Setup env & GH token
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
eval "$(mise activate bash 2>/dev/null)" || true

if [ "$AUTH_TYPE" = "github-app" ]; then
    if [ -z "${GH_TOKEN:-}" ]; then
        eval "$("${BIN_DIR}/gh-app-token.sh" 2>/dev/null)" || true
    fi
fi

# 1. Git pull
cd "$REPO_DIR"
git fetch origin || { log "ERROR: git fetch failed"; exit 1; }
git reset --hard origin/main
log "Git updated to $(git rev-parse --short HEAD)"

# 2. Restart tmux sessions from config
SESSIONS=$(jq -r '.deploy.tmuxSessions // {} | to_entries[] | @base64' "$CONFIG_FILE")

for entry in $SESSIONS; do
    session_name=$(echo "$entry" | base64 --decode | jq -r '.key')
    session_cmd=$(echo "$entry" | base64 --decode | jq -r '.value')

    # Expand $REPO_DIR in session command
    session_cmd=$(echo "$session_cmd" | sed "s|\\\$REPO_DIR|${REPO_DIR}|g; s|\${REPO_DIR}|${REPO_DIR}|g")

    log "Restarting ${session_name}..."
    $TMUX_CMD send-keys -t "$session_name" C-c 2>/dev/null || true
    sleep 2
    $TMUX_CMD kill-session -t "$session_name" 2>/dev/null || true
    sleep 1
    $TMUX_CMD new-session -d -s "$session_name" "$INIT && $session_cmd"
    log "${session_name} restarted"
done

log "=== Deploy complete ==="
