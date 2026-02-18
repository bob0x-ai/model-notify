# model-notify

OpenClaw pi extension that posts a Telegram notification whenever the embedded run switches model/provider/profile.

## What it does

- Hooks `turn_end` in the embedded pi runner.
- Resolves the active provider/model and last-good auth profile.
- Sends a Telegram message when the tuple changes.

## Install (shared, opt-in per agent)

1. Keep the repo in a shared location (example used below):
   `/home/openclaw/.openclaw/extensions-shared/model-notify`
2. For each agent you want to enable it for, add the extension path to that agent’s settings:

```json
{
  "extensions": [
    "/home/openclaw/.openclaw/extensions-shared/model-notify/extension.ts"
  ]
}
```

3. Restart the gateway.

## Notes

- Chat id is resolved from `OPENCLAW_TELEGRAM_CHAT_ID` or, if unset, from the most recent Telegram update in the OpenClaw log file.
- Bot token is read from `openclaw.json` (`channels.telegram.accounts.main.botToken` or `channels.telegram.botToken`).
