# telegram-commit-summary

A Telegram bot that sends daily AI-generated commit summaries to a group chat. It fetches commits from your GitHub repos (last 24h), generates a narrative report via the Groq API (free tier), and delivers it on a cron schedule.

## How it works

1. **GitHub API** fetches commits from configured repos (with file-level diffs)
2. **Groq** generates a categorized narrative summary — primary model **Kimi K2** (`moonshotai/kimi-k2-instruct`), automatic fallback to **Llama 3.3 70B** (`llama-3.3-70b-versatile`) if the primary fails
3. **Telegram Bot API** delivers the report to your group chat
4. **node-cron** triggers the report daily (default: 06:30 Europe/Istanbul)

If both Groq models fail, a structured raw fallback report is sent instead. Messages longer than 4096 characters are split on paragraph/line boundaries.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token (needs `repo` scope for private repos) |
| `GROQ_API_KEY` | Groq API key from [console.groq.com/keys](https://console.groq.com/keys) — free, sustainable, no monthly credit cap |
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
- On Groq 429 (rate limit) the bot waits 60s and retries; on 503 it waits 10s. If the primary model still fails, the fallback model is tried automatically with the same API key
- Groq's free tier has daily request/token limits that reset each day — there is no monthly credit cap, so the bot can run indefinitely on a single key
- Messages are sent with `parse_mode=HTML`; the LLM is instructed to emit only `<b>`, `<i>`, `<code>` tags. On parse errors, the bot strips tags and re-sends as plain text so the report still arrives
