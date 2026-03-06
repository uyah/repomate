# Mac Mini Automation

GitHub Issue → Claude Code → PR 自動化パッケージ。Mac Mini 上で動作する task-runner と webhook-server を提供。

## Overview

4フェーズの自動化ループ:

1. **Analyze**: ラベル付き Issue を検出 → Claude Code で分析 → 計画をコメント
2. **Implement**: 👍 承認 → worktree で隔離実装 → PR 作成
3. **Review**: PR レビューコメント検出 → 自動修正 → push
4. **Conflict**: main とのコンフリクト検出 → 自動 rebase/解消

## Quick Start

```bash
# 1. パッケージをインストール
npm install github:uyah/mac-mini-automation

# 2. 設定ファイルを作成
cp node_modules/@uyah/mac-mini-automation/config.example.json mac-mini.config.json
# mac-mini.config.json を編集

# 3. task-runner を起動
npx mac-mini-task-runner --config mac-mini.config.json
```

## Components

### bin/task-runner.sh

メインの自動化ループ。`--config` で JSON 設定ファイルを指定。

```bash
npx mac-mini-task-runner --config mac-mini.config.json           # 連続ポーリング
npx mac-mini-task-runner --config mac-mini.config.json --once    # 1回実行
npx mac-mini-task-runner --config mac-mini.config.json --dry-run # 対象表示のみ
```

### bin/worktree.sh

Git worktree 管理ヘルパー。

```bash
npx mac-mini-worktree --config mac-mini.config.json create fix/42
npx mac-mini-worktree --config mac-mini.config.json list
npx mac-mini-worktree --config mac-mini.config.json remove fix/42
```

### bin/deploy.sh

Git pull + tmux セッション再起動。

```bash
npx mac-mini-deploy --config mac-mini.config.json
```

### server/ (webhook-server)

REST API + SQLite タスクキュー + オプショナル Slack Bot。

```javascript
import { createApp } from '@uyah/mac-mini-automation/server';
import config from './mac-mini.config.json' with { type: 'json' };

const { app, cleanup } = await createApp(config);
```

#### Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | ヘルスチェック |
| POST | /task | タスク作成 (async) |
| POST | /task/sync | タスク作成 (sync) |
| GET | /task/:id | タスク取得 |
| GET | /tasks | タスク一覧 |
| POST | /task/:id/reply | 会話継続 |
| GET | /task/:id/stream | SSE ストリーム |
| DELETE | /task/:id | タスクキャンセル |
| POST | /task/:id/retry | リトライ |
| POST | /task/:id/merge | worktree → main マージ |
| POST | /task/:id/pr | PR 作成 |
| POST | /task/:id/discard | 変更破棄 |
| GET | /status | システムステータス |
| POST | /deploy | デプロイ実行 |

#### Adapters

- **slack**: Slack Socket Mode Bot (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` 必須)
- **cloudflare-auth**: CF Access ヘッダーからユーザー識別

## Configuration

`mac-mini.config.json`:

```jsonc
{
  "repo": "owner/repo-name",           // GitHub owner/repo
  "label": "mac-mini",                  // トリガーラベル
  "repoDir": "$HOME/Workspace/project", // ローカルリポジトリ
  "worktreeBase": "$HOME/Workspace/project-worktrees",

  "auth": {
    "type": "gh-cli"                    // or "github-app"
  },

  "pollInterval": 180,                  // ポーリング間隔 (秒)

  "phases": {
    "analyze":   { "maxTurns": 10, "useWorktree": true },
    "implement": {
      "maxTurns": 30,
      "preCommands": ["npm ci --silent"],
      "postValidation": ["npm run test:run", "npm run lint"],
      "promptSuffix": ""
    },
    "review":    { "maxTurns": 15 },
    "conflict":  { "maxTurns": 15 }
  },

  "webhookServer": {                    // optional
    "port": 8080,
    "adapters": ["slack"],
    "deployScript": "./scripts/deploy.sh"
  },

  "deploy": {
    "tmuxSessions": {
      "task-runner": "cd $REPO_DIR && exec ./scripts/task-runner.sh"
    }
  }
}
```

### GitHub App Auth

`auth.type: "github-app"` の場合、環境変数が必要:

```bash
export MAC_MINI_APP_ID="..."
export MAC_MINI_INSTALLATION_ID="..."
export MAC_MINI_PEM_FILE="$HOME/.config/bot/private-key.pem"
```

## GitHub Actions Templates

`templates/workflows/` にテンプレートあり:

- `claude.yml.template` — @claude PR レビュー
- `deploy.yml.template` — push → deploy

## Setup

新しい Mac Mini をゼロからセットアップ:

```bash
npx mac-mini-setup --repo owner/repo --dir ~/Workspace/project --user bot-name --email bot@example.com
```

## Dependencies

- `jq` (task-runner.sh の JSON パースに必須)
- `gh` (GitHub CLI)
- `claude` (Claude Code CLI)
- `git`, `tmux`
