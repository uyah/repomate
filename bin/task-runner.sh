#!/bin/bash
# task-runner.sh - Repomate 自動タスクランナー
#
# JSON設定ファイルで複数リポジトリに対応。
#
# フロー:
#   Phase 1: ラベル付きIssueを検出 → 分析 & 計画をコメント
#   Phase 2: 👍 リアクションで承認 → worktreeで隔離実装 → PR作成
#   Phase 3: PRレビューコメントを検出 → 自動修正 → push
#   Phase 4: mainとのコンフリクトを検出 → 自動rebase/解消
#
# Usage:
#   ./bin/task-runner.sh --config repomate.config.json              # 連続ポーリング
#   ./bin/task-runner.sh --config repomate.config.json --once       # 1回だけ実行
#   ./bin/task-runner.sh --config repomate.config.json --dry-run    # 対象表示のみ

set -euo pipefail

# --- Parse args ---
MODE="loop"
CONFIG_FILE=""
for arg in "$@"; do
  case "$arg" in
    --once) MODE="once" ;;
    --dry-run) MODE="dry-run" ;;
    --config)
      # next arg will be consumed below
      ;;
    *)
      # If previous arg was --config, this is the config path
      if [ "${PREV_ARG:-}" = "--config" ]; then
        CONFIG_FILE="$arg"
      fi
      ;;
  esac
  PREV_ARG="$arg"
done

if [ -z "$CONFIG_FILE" ]; then
  echo "ERROR: --config <path> is required" >&2
  echo "Usage: $0 --config <config.json> [--once|--dry-run]" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

# --- Load configuration from JSON ---
cfg() {
  jq -r "$1 // empty" "$CONFIG_FILE"
}

cfg_default() {
  local val
  val=$(jq -r "$1 // empty" "$CONFIG_FILE")
  echo "${val:-$2}"
}

cfg_array() {
  jq -r "$1 // [] | .[]" "$CONFIG_FILE"
}

REPO=$(cfg '.repo')
LABEL=$(cfg '.label')
REPO_DIR=$(cfg '.repoDir' | sed "s|\\\$HOME|$HOME|g; s|~|$HOME|g")
WORKTREE_BASE=$(cfg '.worktreeBase' | sed "s|\\\$HOME|$HOME|g; s|~|$HOME|g")
POLL_INTERVAL=$(cfg_default '.pollInterval' '180')
MAX_TURNS_ANALYZE=$(cfg_default '.phases.analyze.maxTurns' '10')
MAX_TURNS_IMPLEMENT=$(cfg_default '.phases.implement.maxTurns' '30')
MAX_TURNS_REVIEW=$(cfg_default '.phases.review.maxTurns' '15')
ANALYZE_USE_WORKTREE=$(cfg_default '.phases.analyze.useWorktree' 'false')
AUTH_TYPE=$(cfg_default '.auth.type' 'none')
IMPLEMENT_PROMPT_SUFFIX=$(cfg '.phases.implement.promptSuffix')

LOG_DIR="$HOME/logs/task-runner/$(echo "$REPO" | tr '/' '-')"
STATE_DIR="$LOG_DIR/state"

# --- Validate required config ---
for var_name in REPO LABEL REPO_DIR WORKTREE_BASE; do
  if [ -z "${!var_name}" ]; then
    echo "ERROR: Config missing required field for $var_name" >&2
    exit 1
  fi
done

# --- Init ---
mkdir -p "$LOG_DIR" "$STATE_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/runner.log"
}

# --- Run commands from config array ---
run_commands() {
  local jq_path="$1"
  local work_dir="$2"
  local cmds
  cmds=$(jq -r "$jq_path // [] | .[]" "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$cmds" ]; then
    while IFS= read -r cmd; do
      log "Running: $cmd"
      (cd "$work_dir" && eval "$cmd") 2>&1 | tail -5
    done <<< "$cmds"
  fi
}

# --- Build validation prompt suffix from config array ---
build_validation_prompt() {
  local jq_path="$1"
  local items
  items=$(jq -r "$jq_path // [] | to_entries | .[] | \"\(.key + 1). \(.value)\"" "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$items" ]; then
    echo "$items"
  fi
}

# --- Ensure PATH ---
eval "$($HOME/.local/bin/mise activate bash 2>/dev/null || true)"

# --- GitHub App Token (conditional) ---
refresh_gh_token() {
  if [ "$AUTH_TYPE" = "github-app" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    eval "$("${script_dir}/gh-app-token.sh")"
    log "GitHub App token refreshed"
  fi
}
refresh_gh_token

# --- Verify tools ---
for cmd in gh claude git; do
  if ! command -v "$cmd" &>/dev/null; then
    log "ERROR: $cmd not found in PATH"
    exit 1
  fi
done

# --- Phase 1: Analyze & Plan ---
analyze_issue() {
  local issue_num="$1"
  local issue_title="$2"
  local issue_body="$3"
  local log_file="$LOG_DIR/analyze-${issue_num}-$(date +%s).log"

  log "Analyzing #${issue_num}: ${issue_title}"

  gh issue edit "$issue_num" --repo "$REPO" --add-label "analyzing" --remove-label "$LABEL" 2>/dev/null || true

  cd "$REPO_DIR"
  git fetch origin main --quiet

  local work_dir="$REPO_DIR"
  local worktree_path=""

  if [ "$ANALYZE_USE_WORKTREE" = "true" ]; then
    worktree_path="${WORKTREE_BASE}/analyze-${issue_num}"
    if [ -d "$worktree_path" ]; then
      git worktree remove "$worktree_path" --force 2>/dev/null || true
    fi
    git worktree add "$worktree_path" origin/main --detach
    work_dir="$worktree_path"
  fi

  cd "$work_dir"

  local issue_comments
  issue_comments=$(gh api "repos/${REPO}/issues/${issue_num}/comments" \
    --jq '[.[] | select(.body | contains("task-runner:") | not) | "**@\(.user.login)**:\n\(.body)"] | join("\n\n---\n\n")' 2>/dev/null || echo "")

  local prompt="あなたはシニアエンジニアです。以下のGitHub Issueを分析してください。

## Issue #${issue_num}: ${issue_title}

${issue_body}

## Issueコメント（追加のコンテキスト・指示）

${issue_comments:-（コメントなし）}

## 分析タスク

以下を判断し、**1つのMarkdown**で回答してください:

1. **必要性**: このIssueは対応が必要か？不要なら理由を説明
2. **真の課題**: 表面的な要求の裏にある本質的な課題は何か？別のIssueを立てるべきか？
3. **対応方針**: どのファイルをどう変更するか、具体的なステップを列挙
4. **リスク**: 変更の影響範囲、破壊的変更の有無
5. **見積もり**: 変更ファイル数と複雑度（低/中/高）

## 出力フォーマット

\`\`\`
## 分析結果

### 必要性
(対応要否と理由)

### 真の課題
(本質的な問題。別Issueが必要なら提案)

### 対応方針
1. (ステップ1)
2. (ステップ2)
...

### 影響範囲
- 変更ファイル: (概算)
- リスク: (低/中/高)
- 破壊的変更: (あり/なし)

### 判定
(対応可能 / 要確認 / 手動対応推奨)
\`\`\`

コードベースを読んで正確に分析してください。推測ではなくファイルを実際に確認すること。"

  local result
  result=$(claude -p "$prompt" \
    --max-turns "$MAX_TURNS_ANALYZE" \
    --dangerously-skip-permissions \
    --output-format json \
    2>&1 | tee "$log_file")

  local analysis
  analysis=$(echo "$result" | jq -r '.result // empty' 2>/dev/null || echo "")

  if [ -z "$analysis" ]; then
    log "ERROR: Analysis failed for #${issue_num}"
    gh issue comment "$issue_num" --repo "$REPO" \
      --body "task-runner: 分析に失敗しました。ログ: \`$log_file\`" 2>/dev/null || true
    if [ -n "$worktree_path" ]; then
      cd "$REPO_DIR"
      git worktree remove "$worktree_path" --force 2>/dev/null || true
    fi
    return 1
  fi

  gh issue comment "$issue_num" --repo "$REPO" --body "$(cat <<EOF
## Mac Mini task-runner: 分析 & 計画

${analysis}

---

**👍 リアクションで実装を承認してください。**
却下する場合はコメントで指示してください。
EOF
)" 2>/dev/null

  gh issue edit "$issue_num" --repo "$REPO" --add-label "awaiting-approval" --remove-label "analyzing" 2>/dev/null || true

  if [ -n "$worktree_path" ]; then
    cd "$REPO_DIR"
    git worktree remove "$worktree_path" --force 2>/dev/null || true
  fi

  log "Analysis posted for #${issue_num}, awaiting approval"
}

# --- Phase 2: Check approval & Implement ---
implement_issue() {
  local issue_num="$1"
  local issue_title="$2"
  local issue_body="$3"
  local branch="fix/${issue_num}"
  local worktree_path="${WORKTREE_BASE}/${branch//\//-}"
  local log_file="$LOG_DIR/implement-${issue_num}-$(date +%s).log"

  log "Implementing #${issue_num}: ${issue_title}"

  gh issue edit "$issue_num" --repo "$REPO" --add-label "implementing" --remove-label "awaiting-approval" 2>/dev/null || true

  local plan_comment
  plan_comment=$(gh api "repos/${REPO}/issues/${issue_num}/comments" --jq '[.[] | select(.body | contains("task-runner: 分析"))] | last | .body // ""' 2>/dev/null || echo "")

  local issue_comments
  issue_comments=$(gh api "repos/${REPO}/issues/${issue_num}/comments" \
    --jq '[.[] | select((.body | contains("task-runner:") | not) and (.body | contains("task-runner: 分析") | not)) | "**@\(.user.login)**:\n\(.body)"] | join("\n\n---\n\n")' 2>/dev/null || echo "")

  cd "$REPO_DIR"
  git fetch origin main --quiet
  if [ -d "$worktree_path" ]; then
    git worktree remove "$worktree_path" --force 2>/dev/null || true
    git branch -D "$branch" 2>/dev/null || true
  fi
  git worktree add -b "$branch" "$worktree_path" origin/main

  [ -f "$REPO_DIR/.env" ] && cp "$REPO_DIR/.env" "$worktree_path/.env"

  cd "$worktree_path"

  # Run pre-commands (e.g., npm ci)
  run_commands '.phases.implement.preCommands' "$worktree_path"

  # Build validation steps for prompt
  local validation_steps
  validation_steps=$(build_validation_prompt '.phases.implement.postValidation')

  log "Running Claude on #${issue_num} (max-turns: $MAX_TURNS_IMPLEMENT)"
  local prompt="GitHub Issue #${issue_num} を実装してください。

## Issue: ${issue_title}

${issue_body}

## Issueコメント（追加のコンテキスト・指示）

${issue_comments:-（コメントなし）}

## 承認済み計画

${plan_comment}

## 実装手順

1. 計画に沿って修正を実装
${validation_steps:+${validation_steps}
}$([ -n "$validation_steps" ] && echo "$(( $(echo "$validation_steps" | wc -l | tr -d ' ') + 2 ))" || echo "2"). 変更をコミット（Conventional Commits形式、日本語OK）
$([ -n "$validation_steps" ] && echo "$(( $(echo "$validation_steps" | wc -l | tr -d ' ') + 3 ))" || echo "3"). 計画から逸脱しないこと。計画にない変更はしない。${IMPLEMENT_PROMPT_SUFFIX:+

${IMPLEMENT_PROMPT_SUFFIX}}"

  claude -p "$prompt" \
    --max-turns "$MAX_TURNS_IMPLEMENT" \
    --dangerously-skip-permissions \
    --output-format json \
    2>&1 | tee "$log_file"

  local commit_count
  commit_count=$(git log origin/main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')

  if [ "$commit_count" -eq 0 ]; then
    log "No commits made for #${issue_num}, skipping PR"
    gh issue comment "$issue_num" --repo "$REPO" \
      --body "task-runner: 実装しましたが、コード変更なしでした。手動確認が必要かもしれません。" 2>/dev/null || true
    gh issue edit "$issue_num" --repo "$REPO" --remove-label "implementing" 2>/dev/null || true
  else
    git push -u origin "$branch"

    gh pr create \
      --repo "$REPO" \
      --title "fix: #${issue_num} ${issue_title}" \
      --label "task-runner" \
      --body "$(cat <<EOF
## Summary

Closes #${issue_num}

Mac Mini task-runner による自動実装。

## Changes

$(git log origin/main..HEAD --oneline | sed 's/^/- /')

## Test plan

- [ ] auto-review パス
- [ ] 動作確認

Generated by Mac Mini task-runner + Claude Code
EOF
)" \
      --head "$branch" \
      --base main 2>&1

    log "PR created for #${issue_num}"
    gh issue edit "$issue_num" --repo "$REPO" --remove-label "implementing" 2>/dev/null || true
  fi

  cd "$REPO_DIR"
  git worktree remove "$worktree_path" --force 2>/dev/null || true

  log "Done with #${issue_num}"
}

# --- Phase 3: Address review comments ---
address_review() {
  local pr_num="$1"
  local pr_branch="$2"
  local log_file="$LOG_DIR/review-pr${pr_num}-$(date +%s).log"
  local worktree_path="${WORKTREE_BASE}/review-${pr_num}"

  log "Addressing review comments on PR #${pr_num} (branch: ${pr_branch})"

  local last_count=0
  if [ -f "${STATE_DIR}/pr-${pr_num}-comment-count" ]; then
    last_count=$(cat "${STATE_DIR}/pr-${pr_num}-comment-count")
  fi

  local formal_reviews
  formal_reviews=$(gh api "repos/${REPO}/pulls/${pr_num}/reviews" \
    --jq '[.[] | select(.state == "CHANGES_REQUESTED") | {user: .user.login, state: .state, body: .body}]' 2>/dev/null || echo "[]")

  local inline_comments
  inline_comments=$(gh api "repos/${REPO}/pulls/${pr_num}/comments" \
    --jq '[.[] | {user: .user.login, path: .path, line: .line, body: .body}]' 2>/dev/null || echo "[]")

  local pr_comments
  pr_comments=$(gh api "repos/${REPO}/issues/${pr_num}/comments" \
    --jq "[.[] | select(.body | contains(\"task-runner:\") | not)] | .[-3:]  | [.[] | {user: .user.login, body: .body}]" 2>/dev/null || echo "[]")

  cd "$REPO_DIR"
  git fetch origin "$pr_branch" main --quiet
  if [ -d "$worktree_path" ]; then
    git worktree remove "$worktree_path" --force 2>/dev/null || true
  fi
  git worktree add "$worktree_path" "origin/${pr_branch}"

  [ -f "$REPO_DIR/.env" ] && cp "$REPO_DIR/.env" "$worktree_path/.env"

  cd "$worktree_path"

  if ! git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
    log "Rebasing ${pr_branch} onto main"
    if git rebase origin/main 2>/dev/null; then
      log "Rebase successful"
    else
      git rebase --abort 2>/dev/null || true
      log "Rebase failed, will let Claude handle conflicts"
    fi
  fi

  # Run pre-commands (e.g., npm ci)
  run_commands '.phases.review.preCommands' "$worktree_path"

  # Build validation steps for prompt
  local validation_steps
  validation_steps=$(build_validation_prompt '.phases.review.postValidation')

  local pr_diff
  pr_diff=$(gh pr diff "$pr_num" --repo "$REPO" 2>/dev/null | head -500 || echo "")

  local prompt="PR #${pr_num} のレビューで修正を求められています。対応してください。

IMPORTANT: LGTMやApproveのコメントは無視すること。修正依頼・改善提案のみに対応すること。

## CHANGES_REQUESTED レビュー

${formal_reviews}

## インラインコメント（ファイル行指定）

${inline_comments}

## 最新のPRコメント（直近3件）

${pr_comments}

## 現在のPR差分（先頭500行）

\`\`\`diff
${pr_diff}
\`\`\`

## 対応手順

1. 修正を求めるコメントを特定する（LGTMやApproveは無視）
2. 指摘に対応する修正を実装
${validation_steps:+${validation_steps}
}$([ -n "$validation_steps" ] && echo "$(( $(echo "$validation_steps" | wc -l | tr -d ' ') + 3 ))" || echo "3"). 変更をコミット（fix: review対応 のようなメッセージ）
$([ -n "$validation_steps" ] && echo "$(( $(echo "$validation_steps" | wc -l | tr -d ' ') + 4 ))" || echo "4"). レビュー指摘以外の変更はしない

修正すべき指摘が1つもなければ、何もしなくてよい。"

  claude -p "$prompt" \
    --max-turns "$MAX_TURNS_REVIEW" \
    --dangerously-skip-permissions \
    --output-format json \
    2>&1 | tee "$log_file"

  local commit_count
  commit_count=$(git log "origin/${pr_branch}..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')

  if [ "$commit_count" -gt 0 ]; then
    git push origin HEAD:"${pr_branch}" --force-with-lease
    log "Pushed review fixes for PR #${pr_num} ($commit_count commits)"

    gh pr comment "$pr_num" --repo "$REPO" --body "$(cat <<EOF
**task-runner: レビュー対応完了**

$(git log "origin/${pr_branch}..HEAD" --oneline | sed 's/^/- /')

再レビューをお願いします。
EOF
)" 2>/dev/null || true
  else
    log "No changes made for review on PR #${pr_num}"
  fi

  local total_comments=0
  local cr_count ic_count pc_count
  cr_count=$(gh api "repos/${REPO}/pulls/${pr_num}/reviews" \
    --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "0")
  ic_count=$(gh api "repos/${REPO}/pulls/${pr_num}/comments" \
    --jq 'length' 2>/dev/null || echo "0")
  pc_count=$(gh api "repos/${REPO}/issues/${pr_num}/comments" \
    --jq '[.[] | select(.body | contains("task-runner:") | not)] | length' 2>/dev/null || echo "0")
  total_comments=$((cr_count + ic_count + pc_count))
  echo "$total_comments" > "${STATE_DIR}/pr-${pr_num}-comment-count"

  cd "$REPO_DIR"
  git worktree remove "$worktree_path" --force 2>/dev/null || true

  log "Review response done for PR #${pr_num}"
}

# --- Phase 4: Resolve conflicts with main ---
resolve_conflicts() {
  local pr_num="$1"
  local pr_branch="$2"
  local log_file="$LOG_DIR/conflict-pr${pr_num}-$(date +%s).log"
  local worktree_path="${WORKTREE_BASE}/conflict-${pr_num}"

  log "Resolving conflicts on PR #${pr_num} (branch: ${pr_branch})"

  cd "$REPO_DIR"
  git fetch origin "$pr_branch" main --quiet
  if [ -d "$worktree_path" ]; then
    git worktree remove "$worktree_path" --force 2>/dev/null || true
  fi
  git worktree add "$worktree_path" "origin/${pr_branch}"

  [ -f "$REPO_DIR/.env" ] && cp "$REPO_DIR/.env" "$worktree_path/.env"

  cd "$worktree_path"

  # Run pre-commands (e.g., npm ci)
  run_commands '.phases.conflict.preCommands' "$worktree_path"

  # Build validation steps for prompt
  local validation_steps
  validation_steps=$(build_validation_prompt '.phases.conflict.postValidation')

  if git rebase origin/main 2>/dev/null; then
    log "Rebase successful (auto-resolved)"
  else
    git rebase --abort 2>/dev/null || true

    local prompt="このブランチ (${pr_branch}) は main とコンフリクトしています。
コンフリクトを解消してください。

手順:
1. git merge origin/main を実行（コンフリクト発生）
2. コンフリクトファイルを確認し、適切に解決
3. 元のPRの意図を維持しつつ、mainの変更も取り込む
${validation_steps:+${validation_steps}
}$([ -n "$validation_steps" ] && echo "$(( $(echo "$validation_steps" | wc -l | tr -d ' ') + 4 ))" || echo "4"). マージコミットを作成"

    claude -p "$prompt" \
      --max-turns "$MAX_TURNS_REVIEW" \
      --dangerously-skip-permissions \
      --output-format json \
      2>&1 | tee "$log_file"
  fi

  if git push origin HEAD:"${pr_branch}" --force-with-lease 2>/dev/null; then
    log "Pushed conflict resolution for PR #${pr_num}"
    gh pr comment "$pr_num" --repo "$REPO" \
      --body "**task-runner: mainとのコンフリクトを解消しました。**" 2>/dev/null || true
  else
    log "Failed to push conflict resolution for PR #${pr_num}"
  fi

  cd "$REPO_DIR"
  git worktree remove "$worktree_path" --force 2>/dev/null || true

  log "Conflict resolution done for PR #${pr_num}"
}

# --- Check for unaddressed review comments ---
get_prs_needing_review_response() {
  local prs
  prs=$(gh pr list --repo "$REPO" --label "task-runner" --state open \
    --json number,headRefName 2>/dev/null || echo "[]")

  local count
  count=$(echo "$prs" | jq 'length')

  if [ "$count" -eq 0 ]; then
    return
  fi

  for i in $(seq 0 $((count - 1))); do
    local pr_num pr_branch
    pr_num=$(echo "$prs" | jq -r ".[$i].number")
    pr_branch=$(echo "$prs" | jq -r ".[$i].headRefName")

    local last_comment_count=0
    if [ -f "${STATE_DIR}/pr-${pr_num}-comment-count" ]; then
      last_comment_count=$(cat "${STATE_DIR}/pr-${pr_num}-comment-count")
    fi

    local current_comment_count=0
    local changes_requested inline_count pr_comment_count
    changes_requested=$(gh api "repos/${REPO}/pulls/${pr_num}/reviews" \
      --jq '[.[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "0")
    current_comment_count=$((current_comment_count + changes_requested))

    inline_count=$(gh api "repos/${REPO}/pulls/${pr_num}/comments" \
      --jq 'length' 2>/dev/null || echo "0")
    current_comment_count=$((current_comment_count + inline_count))

    pr_comment_count=$(gh api "repos/${REPO}/issues/${pr_num}/comments" \
      --jq '[.[] | select(.body | contains("task-runner:") | not)] | length' 2>/dev/null || echo "0")
    current_comment_count=$((current_comment_count + pr_comment_count))

    if [ "$current_comment_count" -gt "$last_comment_count" ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] PR #${pr_num}: new feedback detected ($last_comment_count -> $current_comment_count)" >> "$LOG_DIR/runner.log"
      echo "${pr_num}:${pr_branch}"
    fi
  done
}

# --- Check for PRs with merge conflicts ---
get_prs_with_conflicts() {
  local prs
  prs=$(gh pr list --repo "$REPO" --label "task-runner" --state open \
    --json number,headRefName,mergeable 2>/dev/null || echo "[]")

  local count
  count=$(echo "$prs" | jq 'length')

  if [ "$count" -eq 0 ]; then
    return
  fi

  for i in $(seq 0 $((count - 1))); do
    local pr_num pr_branch mergeable
    pr_num=$(echo "$prs" | jq -r ".[$i].number")
    pr_branch=$(echo "$prs" | jq -r ".[$i].headRefName")
    mergeable=$(echo "$prs" | jq -r ".[$i].mergeable")

    if [ "$mergeable" = "CONFLICTING" ]; then
      echo "${pr_num}:${pr_branch}"
    fi
  done
}

# --- Check if a comment has 👍 reaction ---
has_approval() {
  local issue_num="$1"

  local comment_id
  comment_id=$(gh api "repos/${REPO}/issues/${issue_num}/comments" \
    --jq '[.[] | select(.body | contains("task-runner: 分析"))] | last | .id // 0' 2>/dev/null || echo "0")

  if [ "$comment_id" = "0" ] || [ -z "$comment_id" ]; then
    return 1
  fi

  local thumbsup_count
  thumbsup_count=$(gh api "repos/${REPO}/issues/comments/${comment_id}/reactions" \
    --jq '[.[] | select(.content == "+1")] | length' 2>/dev/null || echo "0")

  [ "$thumbsup_count" -gt 0 ]
}

# --- Main loop ---
run_once() {
  # Phase 1: 新しいIssue（指定ラベル）を分析
  log "Checking for new issues (label: $LABEL)"
  local new_issues
  new_issues=$(gh issue list --repo "$REPO" --label "$LABEL" --state open --json number,title,body --limit 5 2>/dev/null || echo "[]")
  local new_count
  new_count=$(echo "$new_issues" | jq 'length')

  if [ "$new_count" -gt 0 ]; then
    log "Found $new_count new issue(s) to analyze"
    local issue_num issue_title issue_body
    issue_num=$(echo "$new_issues" | jq -r '.[0].number')
    issue_title=$(echo "$new_issues" | jq -r '.[0].title')
    issue_body=$(echo "$new_issues" | jq -r '.[0].body')

    if [ "$MODE" = "dry-run" ]; then
      log "[DRY-RUN] Would analyze #${issue_num}: ${issue_title}"
    else
      analyze_issue "$issue_num" "$issue_title" "$issue_body"
    fi
  fi

  # Phase 2: 承認済みIssue（awaiting-approval + 👍）を実装
  log "Checking for approved issues (label: awaiting-approval)"
  local approved_issues
  approved_issues=$(gh issue list --repo "$REPO" --label "awaiting-approval" --state open --json number,title,body --limit 5 2>/dev/null || echo "[]")
  local approved_count
  approved_count=$(echo "$approved_issues" | jq 'length')

  if [ "$approved_count" -gt 0 ]; then
    log "Found $approved_count issue(s) awaiting approval"
    for i in $(seq 0 $((approved_count - 1))); do
      local issue_num issue_title issue_body
      issue_num=$(echo "$approved_issues" | jq -r ".[$i].number")
      issue_title=$(echo "$approved_issues" | jq -r ".[$i].title")
      issue_body=$(echo "$approved_issues" | jq -r ".[$i].body")

      if has_approval "$issue_num"; then
        log "Issue #${issue_num} approved!"
        if [ "$MODE" = "dry-run" ]; then
          log "[DRY-RUN] Would implement #${issue_num}: ${issue_title}"
        else
          implement_issue "$issue_num" "$issue_title" "$issue_body"
        fi
      else
        log "Issue #${issue_num} not yet approved, skipping"
      fi
    done
  fi

  # Phase 3: レビューコメント対応
  log "Checking for PRs needing review response"
  local prs_to_review
  prs_to_review=$(get_prs_needing_review_response)

  if [ -n "$prs_to_review" ]; then
    while IFS= read -r entry; do
      local pr_num pr_branch
      pr_num="${entry%%:*}"
      pr_branch="${entry#*:}"

      if [ "$MODE" = "dry-run" ]; then
        log "[DRY-RUN] Would address review on PR #${pr_num} (${pr_branch})"
      else
        address_review "$pr_num" "$pr_branch"
      fi
    done <<< "$prs_to_review"
  fi

  # Phase 4: コンフリクト解消
  log "Checking for PRs with merge conflicts"
  local prs_with_conflicts
  prs_with_conflicts=$(get_prs_with_conflicts)

  if [ -n "$prs_with_conflicts" ]; then
    while IFS= read -r entry; do
      local pr_num pr_branch
      pr_num="${entry%%:*}"
      pr_branch="${entry#*:}"

      if [ "$MODE" = "dry-run" ]; then
        log "[DRY-RUN] Would resolve conflicts on PR #${pr_num} (${pr_branch})"
      else
        resolve_conflicts "$pr_num" "$pr_branch"
      fi
    done <<< "$prs_with_conflicts"
  fi
}

# --- Main ---
log "Task runner started (mode: $MODE, repo: $REPO, config: $CONFIG_FILE)"

if [ "$MODE" = "once" ] || [ "$MODE" = "dry-run" ]; then
  run_once
else
  while true; do
    refresh_gh_token
    run_once || log "ERROR in run_once, continuing..."
    log "Sleeping ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
  done
fi
