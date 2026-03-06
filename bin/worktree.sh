#!/bin/sh
# worktree.sh - Git worktree management helper (generic)
# POSIX-compatible shell script
#
# Usage:
#   worktree.sh [--config <path>] <command> [options]
#   worktree.sh [--repo-root <path> --worktree-base <path>] <command> [options]

set -e

# Colors (POSIX-compatible)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_color() {
    color="$1"
    shift
    printf "%b%s%b\n" "$color" "$*" "$NC"
}

print_error() { print_color "$RED" "Error: $*" >&2; }
print_success() { print_color "$GREEN" "$*"; }
print_warning() { print_color "$YELLOW" "Warning: $*"; }
print_info() { print_color "$BLUE" "$*"; }

# Expand $HOME in a string
expand_home() {
    eval echo "$1"
}

# Parse options
CONFIG_FILE=""
REPO_ROOT=""
WORKTREE_BASE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --repo-root)
            REPO_ROOT="$2"
            shift 2
            ;;
        --worktree-base)
            WORKTREE_BASE="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

# Resolve paths from config or defaults
if [ -n "$CONFIG_FILE" ]; then
    if [ ! -f "$CONFIG_FILE" ]; then
        print_error "Config file not found: $CONFIG_FILE"
        exit 1
    fi
    if ! command -v jq >/dev/null 2>&1; then
        print_error "jq is required to parse config file"
        exit 1
    fi
    [ -z "$REPO_ROOT" ] && REPO_ROOT=$(expand_home "$(jq -r '.repoDir' "$CONFIG_FILE")")
    [ -z "$WORKTREE_BASE" ] && WORKTREE_BASE=$(expand_home "$(jq -r '.worktreeBase' "$CONFIG_FILE")")
fi

# Fallback: auto-detect from script location
if [ -z "$REPO_ROOT" ] || [ -z "$WORKTREE_BASE" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if [ -z "$REPO_ROOT" ]; then
        REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    fi
    if [ -z "$WORKTREE_BASE" ]; then
        WORKTREE_BASE="$(dirname "$REPO_ROOT")/worktrees"
    fi
fi

# Show help message
show_help() {
    cat << 'EOF'
Usage: worktree.sh [options] <command> [args]

Options:
  --config <path>           Read repoDir/worktreeBase from JSON config
  --repo-root <path>        Repository root directory
  --worktree-base <path>    Base directory for worktrees

Commands:
  create <branch-name>    Create a new worktree for the specified branch
  list                    List all worktrees
  remove <branch-name>    Remove a worktree (with confirmation)
  status                  Show git status for all worktrees
  help, --help, -h        Show this help message

Examples:
  worktree.sh --config mac-mini.config.json create feature/new-feature
  worktree.sh --repo-root ~/myrepo --worktree-base ~/worktrees create fix/42
  worktree.sh list

Notes:
  - npm install is NOT run automatically. Run it manually if needed.
  - Branch is created automatically if it doesn't exist.
  - .env / .env.local are automatically copied to the new worktree.
EOF
}

# Sanitize branch name for directory path (replace / with -)
sanitize_branch_name() {
    echo "$1" | sed 's|/|-|g'
}

# Get worktree path from branch name
get_worktree_path() {
    branch="$1"
    sanitized=$(sanitize_branch_name "$branch")
    echo "${WORKTREE_BASE}/${sanitized}"
}

# Check if we're in the right repository
check_repo() {
    if [ ! -d "${REPO_ROOT}/.git" ]; then
        print_error "Not a git repository: ${REPO_ROOT}"
        exit 1
    fi
}

# Create worktree
cmd_create() {
    if [ -z "$1" ]; then
        print_error "Branch name required"
        echo "Usage: worktree.sh create <branch-name>"
        exit 1
    fi

    branch="$1"
    worktree_path=$(get_worktree_path "$branch")

    check_repo
    cd "$REPO_ROOT"

    if [ -d "$worktree_path" ]; then
        print_error "Worktree already exists at: $worktree_path"
        exit 1
    fi

    if [ ! -d "$WORKTREE_BASE" ]; then
        mkdir -p "$WORKTREE_BASE"
        print_info "Created worktree base directory: $WORKTREE_BASE"
    fi

    if git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then
        print_info "Branch '$branch' exists, creating worktree..."
        git worktree add "$worktree_path" "$branch"
    elif git show-ref --verify --quiet "refs/remotes/origin/${branch}" 2>/dev/null; then
        print_info "Branch '$branch' exists on remote, creating worktree with tracking..."
        git worktree add "$worktree_path" "$branch"
    else
        print_info "Branch '$branch' does not exist, creating new branch..."
        git worktree add -b "$branch" "$worktree_path"
    fi

    # Copy .env files
    for envfile in .env .env.local; do
        if [ -f "$REPO_ROOT/$envfile" ]; then
            cp "$REPO_ROOT/$envfile" "$worktree_path/$envfile"
            print_info "Copied $envfile"
        fi
    done

    print_success "Worktree created successfully!"
    echo ""
    echo "Location: $worktree_path"
    echo ""
    echo "Next: cd $worktree_path"
}

# List worktrees
cmd_list() {
    check_repo
    cd "$REPO_ROOT"

    print_info "Git Worktrees:"
    echo ""
    git worktree list
}

# Remove worktree
cmd_remove() {
    if [ -z "$1" ]; then
        print_error "Branch name required"
        echo "Usage: worktree.sh remove <branch-name>"
        exit 1
    fi

    branch="$1"
    worktree_path=$(get_worktree_path "$branch")

    check_repo
    cd "$REPO_ROOT"

    if [ ! -d "$worktree_path" ]; then
        print_error "Worktree not found at: $worktree_path"
        exit 1
    fi

    if [ -n "$(cd "$worktree_path" && git status --porcelain 2>/dev/null)" ]; then
        print_warning "Worktree has uncommitted changes!"
        cd "$worktree_path" && git status --short
        echo ""
    fi

    printf "Are you sure you want to remove worktree at %s? [y/N] " "$worktree_path"
    read -r confirm
    case "$confirm" in
        [yY]|[yY][eE][sS])
            git worktree remove "$worktree_path" --force
            print_success "Worktree removed successfully!"
            ;;
        *)
            print_info "Cancelled."
            exit 0
            ;;
    esac
}

# Show status of all worktrees
cmd_status() {
    check_repo
    cd "$REPO_ROOT"

    print_info "Worktree Status:"
    echo ""

    git worktree list --porcelain | grep '^worktree ' | cut -d' ' -f2 | while read -r wt_path; do
        if [ -d "$wt_path" ]; then
            echo "----------------------------------------"
            print_info "Worktree: $wt_path"

            branch=$(cd "$wt_path" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")
            echo "Branch: $branch"

            changes=$(cd "$wt_path" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
            if [ "$changes" -gt 0 ]; then
                print_warning "Uncommitted changes: $changes file(s)"
                cd "$wt_path" && git status --short
            else
                print_success "Clean (no uncommitted changes)"
            fi
            echo ""
        fi
    done
}

# Main entry point
main() {
    case "${1:-}" in
        create)
            shift
            cmd_create "$@"
            ;;
        list)
            cmd_list
            ;;
        remove)
            shift
            cmd_remove "$@"
            ;;
        status)
            cmd_status
            ;;
        help|--help|-h|"")
            show_help
            ;;
        *)
            print_error "Unknown command: $1"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
