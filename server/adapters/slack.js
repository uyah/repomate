import { randomUUID } from "crypto";
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";
import pkg from "@slack/bolt";
const { App: SlackApp, LogLevel } = pkg;

/**
 * Register the Slack bot adapter.
 * @param {import('hono').Hono} app - Hono app (unused for Slack Socket Mode, but available for future HTTP webhooks)
 * @param {object} ctx - { db, stmts, userStmts, taskToJson, runner, worktrees, config }
 */
export function registerSlack(app, ctx) {
  const { stmts, userStmts, runner, worktrees, config } = ctx;
  const { runClaudeSync, runningPids } = runner;
  const { createWorktree, removeWorktree, getWorktreeChanges, commitAndMergeToMain, createPullRequest, closeThread } = worktrees;
  const UPLOADS_DIR = config.uploadsDir;
  const REPO_DIR = config.repoDir;
  const MAX_TURNS = config.maxTurns;

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    console.log("[slack] SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set, skipping Slack bot");
    return;
  }

  const slack = new SlackApp({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const slackRunningTasks = new Map();

  async function downloadSlackFiles(files) {
    const token = process.env.SLACK_BOT_TOKEN;
    const paths = [];
    for (const file of files) {
      const url = file.url_private_download || file.url_private;
      if (!url) continue;
      try {
        let res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
        });
        for (let i = 0; i < 5 && [301, 302, 303, 307, 308].includes(res.status); i++) {
          const location = res.headers.get("location");
          if (!location) break;
          res = await fetch(location, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "manual",
          });
        }
        if (!res.ok) {
          console.error(`[slack] File download failed: ${file.name} status=${res.status}`);
          continue;
        }
        const ext = extname(file.name || ".bin") || ".bin";
        const name = randomUUID().slice(0, 8) + ext;
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(join(UPLOADS_DIR, name), buf);
        paths.push(join(UPLOADS_DIR, name));
        console.log(`[slack] Downloaded file: ${file.name} (${buf.length} bytes)`);
      } catch (e) {
        console.error(`[slack] Failed to download file ${file.name}: ${e.message}`);
      }
    }
    return paths;
  }

  const slackUserCache = new Map();
  async function getSlackUserEmail(userId) {
    if (slackUserCache.has(userId)) return slackUserCache.get(userId);
    try {
      const res = await slack.client.users.info({ user: userId });
      const profile = res.user?.profile || {};
      const email = profile.email || null;
      const name = profile.display_name || res.user?.real_name || res.user?.name || userId;
      const avatar = profile.image_72 || profile.image_48 || null;
      if (email) {
        userStmts.upsert.run(email, name, userId, avatar, new Date().toISOString());
        slackUserCache.set(userId, email);
        return email;
      }
      const existing = userStmts.getBySlackId.get(userId);
      if (existing) {
        slackUserCache.set(userId, existing.email);
        return existing.email;
      }
      const fallback = `slack:${name}`;
      slackUserCache.set(userId, fallback);
      return fallback;
    } catch { return null; }
  }

  async function handleSlackTask(prompt, event, say) {
    const threadTs = event.thread_ts || event.ts;
    const taskKey = `${event.channel}-${threadTs}`;

    // Handle worktree merge/PR/discard/done commands
    const isMergeCmd = /^(マージ(して|する|お願い)?|merge)$/i.test(prompt.trim());
    const isPrCmd = /^(pr(作|を)?[っ作]?[てる]|pr作成|create pr)$/i.test(prompt.trim());
    const isDiscardCmd = /^(破棄(して|する)?|discard)$/i.test(prompt.trim());
    const isDoneCmd = /^(done|完了|閉じ(て|る))$/i.test(prompt.trim());

    if (isDoneCmd) {
      const prevTask = stmts.lastBySlackThread.get(taskKey);
      if (prevTask) {
        const rootId = prevTask.root_id || prevTask.id;
        closeThread(rootId);
        await say({ text: "スレッドを完了しました。", thread_ts: threadTs });
      } else {
        await say({ text: "対象のタスクが見つかりません。", thread_ts: threadTs });
      }
      return;
    }

    if (isMergeCmd || isPrCmd || isDiscardCmd) {
      const prevTask = stmts.lastBySlackThread.get(taskKey);
      if (prevTask?.cwd) {
        const rootId = prevTask.root_id || prevTask.id;
        const changes = getWorktreeChanges(prevTask.cwd);
        if (!changes) {
          closeThread(rootId);
          await say({ text: "変更はありません。スレッドを完了しました。", thread_ts: threadTs });
          return;
        }
        if (isDiscardCmd) {
          closeThread(rootId);
          await say({ text: "変更を破棄しました。", thread_ts: threadTs });
          return;
        }
        if (isMergeCmd) {
          const message = `task(${rootId}): ${prevTask.prompt.slice(0, 60)}`;
          const result = commitAndMergeToMain(prevTask.cwd, rootId, message);
          if (result.ok) {
            closeThread(rootId);
            await say({ text: `mainにマージしました (${result.commit.slice(0, 7)})`, thread_ts: threadTs });
          } else {
            await say({ text: `マージに失敗しました:\n\`\`\`${result.error.slice(0, 500)}\`\`\``, thread_ts: threadTs });
          }
          return;
        }
        if (isPrCmd) {
          const title = `task(${rootId}): ${prevTask.prompt.slice(0, 60)}`;
          const body = `## Changes\n${changes.files.map(f => '- ' + f).join('\n')}`;
          const result = createPullRequest(prevTask.cwd, rootId, title, body);
          if (result.ok) {
            closeThread(rootId);
            await say({ text: `PRを作成しました: ${result.prUrl}`, thread_ts: threadTs });
          } else {
            await say({ text: `PR作成に失敗しました:\n\`\`\`${result.error.slice(0, 500)}\`\`\``, thread_ts: threadTs });
          }
          return;
        }
      }
    }

    if (slackRunningTasks.has(taskKey)) {
      await say({ text: "前のタスクがまだ実行中です。完了をお待ちください。", thread_ts: threadTs });
      return;
    }

    try {
      await slack.client.reactions.add({
        channel: event.channel, name: "hourglass_flowing_sand", timestamp: event.ts,
      });
    } catch {}

    slackRunningTasks.set(taskKey, true);

    const prevTask = stmts.lastBySlackThread.get(taskKey);
    const sessionId = prevTask?.session_id || null;
    const rootTaskId = prevTask ? (prevTask.root_id || prevTask.id) : null;

    let id = randomUUID().slice(0, 8);
    const worktreeRootId = rootTaskId || id;
    const worktreeCwd = prevTask?.cwd || createWorktree(worktreeRootId);
    const taskTmpDir = join(REPO_DIR, "tmp", `slack-${id}`);
    mkdirSync(taskTmpDir, { recursive: true });

    let displayPrompt = prompt;
    let fullPrompt = prompt;
    if (event.files?.length > 0) {
      const filePaths = await downloadSlackFiles(event.files);
      if (filePaths.length > 0) {
        const fileNames = event.files.map(f => f.name).filter(Boolean);
        displayPrompt += "\n" + fileNames.map(n => `[${n}]`).join(" ");
        fullPrompt += "\n\n添付ファイル:\n" + filePaths.join("\n");
      }
    }
    fullPrompt += `\n\nファイルを生成する場合は ${taskTmpDir} に保存してください。`;

    const slackUser = event.user ? await getSlackUserEmail(event.user) : null;
    stmts.insert.run(id, displayPrompt, new Date().toISOString(), null, worktreeCwd, sessionId, prevTask?.id || null, rootTaskId || id, taskKey, slackUser);
    console.log(`[slack] Task ${id} started${sessionId ? ` (resume ${sessionId})` : ""} by ${slackUser}: ${displayPrompt.slice(0, 80)}`);

    try {
      const task = await runClaudeSync(id, fullPrompt, MAX_TURNS, sessionId, worktreeCwd);
      const result = task.result || "";

      // Auto-continue if max turns reached (up to 3 times)
      let continuations = 0;
      while (task.status === "max_turns" && continuations < 3) {
        continuations++;
        console.log(`[slack] Task ${id} hit max turns, auto-continuing (${continuations}/3)...`);
        const continueId = randomUUID().slice(0, 8);
        stmts.insert.run(continueId, "[auto-continue] max turns reached", new Date().toISOString(), null, task.cwd, task.sessionId, id, rootTaskId || id, taskKey, slackUser);
        const continueTask = await runClaudeSync(continueId, "続けてください", MAX_TURNS, task.sessionId, task.cwd || null);
        Object.assign(task, continueTask);
        id = continueId;
      }

      if (task.status === "completed") {
        if (result.length > 3500) {
          await slack.client.filesUploadV2({
            channel_id: event.channel, thread_ts: threadTs,
            content: result, filename: "result.md", title: "Claude Response",
            initial_comment: "結果が長いためファイルで送信します。",
          });
        } else {
          await say({ text: result || "(空の結果)", thread_ts: threadTs });
        }

        // Upload output files from task-scoped tmp dir
        try {
          if (existsSync(taskTmpDir)) {
            const outputFiles = readdirSync(taskTmpDir)
              .map(f => join(taskTmpDir, f))
              .filter(f => { try { return statSync(f).isFile(); } catch { return false; } });
            for (const filePath of outputFiles) {
              await slack.client.filesUploadV2({
                channel_id: event.channel,
                thread_ts: threadTs,
                file: filePath,
                filename: basename(filePath),
              });
            }
          }
        } catch (e) {
          console.error(`[slack] Failed to upload output files: ${e.message}`);
        }

        // Notify about worktree changes
        const wtChanges = getWorktreeChanges(worktreeCwd);
        if (wtChanges) {
          const fileList = wtChanges.files.slice(0, 10).map(f => `  ${f}`).join("\n");
          const more = wtChanges.files.length > 10 ? `\n  ...他${wtChanges.files.length - 10}件` : "";
          await say({
            text: `ワークツリーに変更があります (${wtChanges.files.length}ファイル):\n\`\`\`\n${fileList}${more}\n\`\`\`\n変更をどうしますか？\n• *mainにマージ* → \`マージして\` と返信\n• *PRを作成* → \`PR作って\` と返信\n• *破棄* → \`破棄して\` と返信`,
            thread_ts: threadTs,
          });
        }

        try {
          await slack.client.reactions.remove({ channel: event.channel, name: "hourglass_flowing_sand", timestamp: event.ts });
          await slack.client.reactions.add({ channel: event.channel, name: "white_check_mark", timestamp: event.ts });
        } catch {}
        console.log(`[slack] Task ${id} completed: ${prompt.slice(0, 80)}`);
      } else {
        const errMsg = task.error || "不明なエラー";
        await say({ text: `エラーが発生しました:\n\`\`\`${errMsg.slice(0, 2000)}\`\`\``, thread_ts: threadTs });
        try {
          await slack.client.reactions.remove({ channel: event.channel, name: "hourglass_flowing_sand", timestamp: event.ts });
          await slack.client.reactions.add({ channel: event.channel, name: "x", timestamp: event.ts });
        } catch {}
        console.error(`[slack] Task ${id} failed: ${errMsg.slice(0, 200)}`);
      }

    } catch (err) {
      await say({ text: `エラーが発生しました:\n\`\`\`${err.message.slice(0, 2000)}\`\`\``, thread_ts: threadTs });
      try {
        await slack.client.reactions.remove({ channel: event.channel, name: "hourglass_flowing_sand", timestamp: event.ts });
        await slack.client.reactions.add({ channel: event.channel, name: "x", timestamp: event.ts });
      } catch {}
      console.error(`[slack] Task ${id} error: ${err.message}`);
    } finally {
      slackRunningTasks.delete(taskKey);
    }
  }

  slack.event("app_mention", async ({ event, say }) => {
    const prompt = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const hasFiles = event.files?.length > 0;
    if (!prompt && !hasFiles) { await say({ text: "指示内容を入力してください", thread_ts: event.ts }); return; }
    await handleSlackTask(prompt || "添付ファイルを確認してください", event, say);
  });

  slack.event("message", async ({ event, say }) => {
    if (event.subtype && event.subtype !== "file_share") return;
    if (event.bot_id) return;
    const prompt = (event.text || "").trim();
    const hasFiles = event.files?.length > 0;
    if (!prompt && !hasFiles) return;

    console.log(`[slack] message event: channel=${event.channel} thread_ts=${event.thread_ts || "none"} channel_type=${event.channel_type || "unknown"} files=${event.files?.length || 0} text=${(prompt || "(none)").slice(0, 50)}`);

    const effectivePrompt = prompt || (hasFiles ? "添付ファイルを確認してください" : "");

    if (event.channel_type === "im") {
      await handleSlackTask(effectivePrompt, event, say);
      return;
    }

    if (event.thread_ts) {
      const taskKey = `${event.channel}-${event.thread_ts}`;
      const prevTask = stmts.lastBySlackThread.get(taskKey);
      if (prevTask) {
        const cleanPrompt = effectivePrompt.replace(/<@[A-Z0-9]+>/g, "").trim();
        if (cleanPrompt) await handleSlackTask(cleanPrompt, event, say);
        return;
      }
    }
  });

  slack.start()
    .then(() => console.log("[slack] Slack bot running (Socket Mode)"))
    .catch((err) => console.error("[slack] Failed to start:", err.message));
}
