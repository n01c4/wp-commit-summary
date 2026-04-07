# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Telegram bot that sends daily commit summary reports. It fetches commits from GitHub repos (last 24h), generates a narrative report via Hugging Face Inference API (Qwen3-235B-A22B), and delivers it to a Telegram group on a cron schedule (default: 06:30 Europe/Istanbul).

The project was migrated from WhatsApp (whatsapp-web.js + Puppeteer) to Telegram Bot API. The Telegram path is stateless HTTPS — no session, no headless browser, no QR code.

## Running

```bash
npm install              # install dependencies
node index.js            # normal mode — starts cron, waits for schedule
node index.js --test     # test mode — sends report immediately
```

No authentication step is needed — bot token + chat_id from `.env` are enough.

## Architecture

Single-file app (`index.js`) with this flow:

1. **Cron trigger** → `node-cron` fires `runDailyReport()` (default 06:30 Europe/Istanbul)
2. **GitHub fetch** → `getCommits()` pulls commits since last 06:30, `enrichCommits()` fetches per-commit file diffs (skips merge commits since child commits already contain the details)
3. **LLM summary** → `buildCommitText()` formats structured data, `generateSummary()` sends to HF chat completions endpoint (`/v1/chat/completions`). System prompt instructs categorized narrative output in Turkish. On 503 (model loading), retries after 30s.
4. **Fallback** → `buildFallbackReport()` produces a raw structured report if LLM fails
5. **Send** → `sendTelegramMessage()` POSTs to Telegram Bot API (`/sendMessage`). Long messages are split on paragraph/line boundaries to fit the 4096-char limit, each chunk retried up to 3 times.

Key design decisions:
- Merge commits are detected (>1 parent) and excluded from detail fetching/final output to avoid double-counting
- The LLM system prompt explicitly forbids listing every file — it must narrate and categorize changes
- Telegram messages are sent as **plain text** (no `parse_mode`). The LLM emits markdown (`**bold**`, `### headings`, tables) which appears literally in Telegram but stays readable. Switching to `parse_mode=HTML` is the next step if formatting matters.

## Environment Variables

Configured via `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub API auth (PAT, needs `repo` scope for private repos) |
| `HF_API_TOKEN` | Hugging Face Inference API auth |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Target chat (negative integer for groups) |
| `REPOS` | Comma-separated `owner/repo` list |
| `CRON_SCHEDULE` | Cron expression (default: `30 6 * * *`) |
| `SUMMARY_LANGUAGE` | `tr` or `en` (default: `tr`) |

## Dependencies

`axios`, `node-cron`, `dotenv` — that's it. No Puppeteer, no whatsapp-web.js, no notifier.

## Language

Code comments, log messages, and the LLM system prompt are in Turkish. The bot defaults to Turkish output (`SUMMARY_LANGUAGE=tr`).
