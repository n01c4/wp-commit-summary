# whatsapp-commit-summary

A WhatsApp bot that sends daily AI-generated commit summaries to a group chat. It fetches commits from your GitHub repos (last 24h), generates a narrative report via Hugging Face Inference API, and delivers it on a cron schedule.

## How it works

1. **GitHub API** fetches commits from configured repos (with file-level diffs)
2. **Hugging Face** (Qwen3-235B-A22B) generates a categorized narrative summary
3. **whatsapp-web.js** delivers the report to your WhatsApp group
4. **node-cron** triggers the report daily (default: 06:30)

If the LLM is unavailable, a structured fallback report is sent instead.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token |
| `HF_API_TOKEN` | Hugging Face API token |
| `WHATSAPP_GROUP_NAME` | Exact name of the target WhatsApp group |
| `REPOS` | Comma-separated repos (`owner/repo1,owner/repo2`) |
| `CRON_SCHEDULE` | Cron expression (default: `30 6 * * *`) |
| `SUMMARY_LANGUAGE` | `tr` or `en` (default: `tr`) |

## Usage

```bash
# Start with cron schedule
node index.js

# Send a report immediately (test mode)
node index.js --test
```

On first run, a QR code appears in the terminal — scan it with WhatsApp. Sessions persist in `.wwebjs_auth/`.

## Docker

```bash
docker build -t whatsapp-commit-bot .

docker run -d --name whatsapp-commit-bot \
  --restart unless-stopped \
  -v $(pwd)/.wwebjs_auth:/app/.wwebjs_auth \
  -v $(pwd)/.env:/app/.env \
  whatsapp-commit-bot
```

For the first run, use `docker logs -f whatsapp-commit-bot` to see the QR code.

## Notes

- Merge commits are excluded to avoid double-counting (child commits already contain the changes)
- The LLM prompt instructs categorized narrative output, not raw file lists
- If the HF model is cold (503), the bot retries automatically after 30s
- Desktop notifications alert on QR code needed, auth failure, and disconnection
- whatsapp-web.js is an unofficial library — be mindful of WhatsApp's terms of service
