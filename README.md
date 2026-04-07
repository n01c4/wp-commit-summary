# telegram-commit-summary

A Telegram bot that sends daily AI-generated commit summaries to a group chat. It fetches commits from your GitHub repos (last 24h), generates a narrative report via Hugging Face Inference API, and delivers it on a cron schedule.

## How it works

1. **GitHub API** fetches commits from configured repos (with file-level diffs)
2. **Hugging Face** (Qwen3-235B-A22B) generates a categorized narrative summary
3. **Telegram Bot API** delivers the report to your group chat
4. **node-cron** triggers the report daily (default: 06:30 Europe/Istanbul)

If the LLM is unavailable, a structured fallback report is sent instead. Messages longer than 4096 characters are split on paragraph/line boundaries.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token (needs `repo` scope for private repos) |
| `HF_API_TOKEN` | Hugging Face API token |
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Target chat ID (negative for groups, e.g. `-1001234567890`) |
| `REPOS` | Comma-separated repos (`owner/repo1,owner/repo2`) |
| `CRON_SCHEDULE` | Cron expression (default: `30 6 * * *`) |
| `SUMMARY_LANGUAGE` | `tr` or `en` (default: `tr`) |

### Finding your chat ID

1. Add the bot to the target group
2. Send any message in the group (privacy mode must be off, or mention the bot)
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` — find `chat.id` in the JSON

## Usage

```bash
# Start with cron schedule
node index.js

# Send a report immediately (test mode)
node index.js --test
```

## Docker

```bash
docker compose up -d --build
docker compose logs -f
```

## Notes

- Merge commits are excluded to avoid double-counting (child commits already contain the changes)
- The LLM prompt instructs categorized narrative output, not raw file lists
- If the HF model is cold (503), the bot retries automatically after 30s
- Messages are sent with `parse_mode=HTML`; the LLM is instructed to emit only `<b>`, `<i>`, `<code>` tags. On parse errors, the bot strips tags and re-sends as plain text so the report still arrives
