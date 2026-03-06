#!/bin/bash
# setup-mac-mini.sh - Mac Mini setup script (generic)
#
# Usage:
#   setup-mac-mini.sh [--repo owner/name] [--dir path] [--user git-username] [--email git-email]
#
# All options are optional; missing values will be prompted interactively.

set -euo pipefail

# --- Parse options ---
REPO=""
REPO_DIR=""
GIT_USER=""
GIT_EMAIL=""

while [ $# -gt 0 ]; do
    case "$1" in
        --repo)   REPO="$2";      shift 2 ;;
        --dir)    REPO_DIR="$2";   shift 2 ;;
        --user)   GIT_USER="$2";   shift 2 ;;
        --email)  GIT_EMAIL="$2";  shift 2 ;;
        --help|-h)
            echo "Usage: setup-mac-mini.sh [--repo owner/name] [--dir path] [--user git-username] [--email git-email]"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# --- Prompt for missing values ---
prompt_if_empty() {
    var_name="$1"
    prompt_msg="$2"
    default_val="${3:-}"

    eval "val=\$$var_name"
    if [ -z "$val" ]; then
        if [ -n "$default_val" ]; then
            printf "%s [%s]: " "$prompt_msg" "$default_val"
        else
            printf "%s: " "$prompt_msg"
        fi
        read -r val
        val="${val:-$default_val}"
        eval "$var_name=\"\$val\""
    fi
}

echo "=== Mac Mini Setup ==="
echo ""

prompt_if_empty REPO      "GitHub repo (owner/name)"
prompt_if_empty REPO_DIR  "Local clone directory" "$HOME/$(echo "$REPO" | tr '/' '/')"
prompt_if_empty GIT_USER  "Git username for bot"
prompt_if_empty GIT_EMAIL "Git email for bot"

echo ""
echo "Config: repo=$REPO dir=$REPO_DIR user=$GIT_USER email=$GIT_EMAIL"
echo ""

# --- 1. Homebrew ---
if ! command -v brew &>/dev/null; then
    echo "[1/7] Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
    eval "$(/opt/homebrew/bin/brew shellenv)"
else
    echo "[1/7] Homebrew already installed"
fi

# --- 2. Essential tools ---
echo "[2/7] Installing essential tools..."
brew install gh jq git tmux mise 2>/dev/null || true

# --- 3. mise (Node.js, Python) ---
echo "[3/7] Setting up mise..."
mkdir -p "$HOME/.local/bin"
eval "$(mise activate bash)"
mise use --global node@22 python@3.12 2>/dev/null || true

# --- 4. Claude Code ---
echo "[4/7] Installing Claude Code..."
if ! command -v claude &>/dev/null; then
    npm install -g @anthropic-ai/claude-code
else
    echo "  Claude Code already installed: $(claude --version 2>/dev/null || echo 'unknown')"
fi

# --- 5. GitHub CLI auth ---
echo "[5/7] GitHub CLI authentication..."
echo ""
echo "  Bot user login:"
echo "  1. Log into the bot GitHub account in browser"
echo "  2. Run: gh auth login --web"
echo ""
echo "  Or with PAT: echo 'ghp_xxxxx' | gh auth login --with-token"
echo ""

if gh auth status &>/dev/null; then
    echo "  Current auth: $(gh auth status 2>&1 | head -3)"
else
    echo "  [SKIP] gh auth not configured yet. Run 'gh auth login' manually."
fi

# --- 6. Clone repo ---
echo "[6/7] Setting up repository..."
if [ -d "$REPO_DIR/.git" ]; then
    echo "  Repository already exists at $REPO_DIR"
    cd "$REPO_DIR" && git fetch origin && git pull origin main
else
    mkdir -p "$(dirname "$REPO_DIR")"
    gh repo clone "$REPO" "$REPO_DIR"
fi

# --- 7. SSH key ---
echo "[7/7] SSH key setup..."
SSH_KEY="$HOME/.ssh/id_ed25519"
if [ ! -f "$SSH_KEY" ]; then
    echo "  Generating SSH key..."
    HOSTNAME=$(hostname -s 2>/dev/null || echo "mac-mini")
    ssh-keygen -t ed25519 -C "$HOSTNAME" -f "$SSH_KEY" -N ""
    echo ""
    echo "  Add this public key to the bot GitHub account:"
    echo ""
    cat "${SSH_KEY}.pub"
    echo ""
    echo "  GitHub -> Settings -> SSH and GPG keys -> New SSH key"
else
    echo "  SSH key already exists"
fi

# --- Git config ---
echo ""
echo "=== Configuring git ==="
git config --global user.name "$GIT_USER"
git config --global user.email "$GIT_EMAIL"
echo "  Set user.name=$GIT_USER user.email=$GIT_EMAIL"

# --- Claude auth ---
echo ""
echo "=== Claude Code authentication ==="
echo ""
echo "Run on Mac Mini:"
echo "  claude auth login"
echo ""
echo "Or set environment variable:"
echo "  export ANTHROPIC_API_KEY='sk-ant-xxxxx'"
echo ""

# --- Done ---
echo "=== Setup complete ==="
echo ""
echo "Remaining manual steps:"
echo "  1. gh auth login (bot user)"
echo "  2. Add SSH public key to bot GitHub account"
echo "  3. claude auth login"
echo "  4. Place .env file if needed"
echo "  5. Start task-runner via tmux"
