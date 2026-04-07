# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Telegram bot that sends daily commit summary reports. It fetches commits from GitHub repos (last 24h), generates a narrative report via the Groq API (primary: Kimi K2 / `moonshotai/kimi-k2-instruct`, automatic fallback: Llama 3.3 70B / `llama-3.3-70b-versatile`), and delivers it to a Telegram group on a cron schedule (default: 06:30 Europe/Istanbul).

The project was migrated from WhatsApp (whatsapp-web.js + Puppeteer) to Telegram Bot API. The Telegram path is stateless HTTPS — no session, no headless browser, no QR code. The LLM provider was migrated from Hugging Face Inference Providers to Groq because Groq's free tier has daily-resetting rate limits with no monthly credit cap, making it sustainable for indefinite cron use on a single key.

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
3. **LLM summary** → `buildCommitText()` formats structured data, `generateSummary()` calls Groq's OpenAI-compatible chat completions endpoint (`https://api.groq.com/openai/v1/chat/completions`). System prompt instructs categorized narrative output in Turkish. The flow is: try `GROQ_PRIMARY_MODEL` (Kimi K2) first; on 429 wait 60s and retry, on 503 wait 10s and retry (up to `GROQ_MAX_RETRIES` per model); if it still fails, automatically fall through to `GROQ_FALLBACK_MODEL` (Llama 3.3 70B) using the same API key. The dual-model chain is implemented via `callGroq(model, messages, retryCount)` invoked twice from `generateSummary()`.
4. **Fallback** → `buildFallbackReport()` produces a raw structured report if both Groq models fail
5. **Send** → `sendTelegramMessage()` POSTs to Telegram Bot API (`/sendMessage`). Long messages are split on paragraph/line boundaries to fit the 4096-char limit, each chunk retried up to 3 times.

Key design decisions:
- Merge commits are detected (>1 parent) and excluded from detail fetching/final output to avoid double-counting
- The LLM system prompt explicitly forbids listing every file — it must narrate and categorize changes
- Telegram messages are sent with `parse_mode=HTML`. The system prompt instructs the model to emit only `<b>`, `<i>`, `<code>` tags (no markdown, no tables, no `<ul>/<li>`). If Telegram returns a 400 (parse error), `sendTelegramMessage` strips all tags via `stripHtmlTags()` and re-sends as plain text — the report still goes through, just less pretty.
- Helper `escapeHtml()` is used in the fallback report and the header to safely embed user/repo/author strings that might contain `< > &`.
- Groq was chosen over Hugging Face Inference Providers because HF's free tier uses a depleting monthly credit pool while Groq's free tier has only daily-resetting RPM/RPD/TPM limits — meaning the bot can run a single daily cron job indefinitely without ever hitting a "out of credits" wall. Kimi K2 was chosen as the primary because its Turkish narrative quality and prompt adherence are closest to the original Qwen3-235B behavior, so the existing system prompt works without retuning.

## Environment Variables

Configured via `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub API auth (PAT, needs `repo` scope for private repos) |
| `GROQ_API_KEY` | Groq API key from console.groq.com/keys (free tier) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Target chat (negative integer for groups) |
| `REPOS` | Comma-separated `owner/repo` list |
| `CRON_SCHEDULE` | Cron expression (default: `30 6 * * *`) |
| `SUMMARY_LANGUAGE` | `tr` or `en` (default: `tr`) |

## Dependencies

`axios`, `node-cron`, `dotenv` — that's it. No Puppeteer, no whatsapp-web.js, no notifier.

## Language

Code comments, log messages, and the LLM system prompt are in Turkish. The bot defaults to Turkish output (`SUMMARY_LANGUAGE=tr`).
