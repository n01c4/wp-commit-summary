# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A WhatsApp bot that sends daily commit summary reports. It fetches commits from GitHub repos (last 24h), generates a narrative report via Hugging Face Inference API (Qwen3-235B-A22B), and delivers it to a WhatsApp group on a cron schedule (default: 06:30 daily).

## Running

```bash
npm install              # install dependencies
node index.js            # normal mode — starts cron, waits for schedule
node index.js --test     # test mode — sends report immediately after WhatsApp connects
```

First run shows a QR code in terminal for WhatsApp Web authentication. Sessions persist in `.wwebjs_auth/`.

## Architecture

Single-file app (`index.js`, ~460 lines) with this flow:

1. **WhatsApp init** → QR auth via `whatsapp-web.js` with Puppeteer (headless Chrome)
2. **Cron trigger** → `node-cron` fires `runDailyReport()`
3. **GitHub fetch** → `getCommits()` pulls commits since last 06:30, `enrichCommits()` fetches per-commit file diffs (skips merge commits since child commits already contain the details)
4. **LLM summary** → `buildCommitText()` formats structured data, `generateSummary()` sends to HF chat completions endpoint (`/v1/chat/completions`). System prompt instructs categorized narrative output in Turkish. On 503 (model loading), retries after 30s.
5. **Fallback** → `buildFallbackReport()` produces a raw structured report if LLM fails
6. **Send** → finds WhatsApp group by exact name match, sends message

Key design decisions:
- Merge commits are detected (>1 parent) and excluded from detail fetching/final output to avoid double-counting
- The LLM system prompt explicitly forbids listing every file — it must narrate and categorize changes
- Desktop notifications (`node-notifier`) alert on QR code needed, auth failure, and disconnection

## Environment Variables

Configured via `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub API auth (PAT) |
| `HF_API_TOKEN` | Hugging Face Inference API auth |
| `WHATSAPP_GROUP_NAME` | Exact WhatsApp group name to send to |
| `REPOS` | Comma-separated `owner/repo` list |
| `CRON_SCHEDULE` | Cron expression (default: `30 6 * * *`) |
| `SUMMARY_LANGUAGE` | `tr` or `en` (default: `tr`) |

## Dependencies

`whatsapp-web.js`, `qrcode-terminal`, `node-cron`, `axios`, `node-notifier`, `dotenv` — no package.json exists yet, install manually.

## Language

Code comments, log messages, and the LLM system prompt are in Turkish. The bot defaults to Turkish output (`SUMMARY_LANGUAGE=tr`).
