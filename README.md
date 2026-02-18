# model-notify

OpenClaw pi extension that posts a Telegram notification whenever the embedded run switches model/provider/profile.

## What it does

- Hooks `turn_end` in the embedded pi runner.
- Resolves the active provider/model and last-good auth profile.
- Sends a Telegram message when the tuple changes.

## Install (local)

1. Place `extension.ts` somewhere on disk.
2. Add the path to your agent settings `extensions` array (e.g. `~/.openclaw/agents/main/agent/settings.json`).
3. Restart the gateway.

## Notes

- Chat id is resolved from `OPENCLAW_TELEGRAM_CHAT_ID` or, if unset, from the most recent Telegram update in the OpenClaw log file.
- Bot token is read from `openclaw.json` (`channels.telegram.accounts.main.botToken` or `channels.telegram.botToken`).
