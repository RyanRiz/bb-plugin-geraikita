---
name: geraikita
description: Configure or troubleshoot the Geraikita AI provider (acp-geraikita) and its settings page.
---

# Geraikita AI plugin

Provider `acp-geraikita` = OpenCode over ACP with `OPENCODE_CONFIG=~/.config/geraikita/opencode.json`,
registered as an entry in `provider-acp`'s `customAgents`. Claude Code is never changed.

Settings page: Settings → Plugins → Geraikita AI.
- Built-in fields: `apiKey` (secret), `displayName` (`bb plugin config geraikita set <key> <value>`). Saving re-syncs.
- "Geraikita models" section: default model dropdown, last sync + Sync now, model table with per-model
  context override (stored in plugin kv `state.contextOverridesK`, K tokens).
- Usage card + sidebar-footer disclosure "Geraikita usage": `GET /v1/balance` mirrored into
  `state.balance` / `state.balanceAt` / `state.balanceError`. RPC `refreshBalance` forces a read.
  Read on load, on sync, every 60 s while the card is open, and every 5 min via the `balance-refresh`
  schedule. `/v1/balance` is free and allows 30 calls/min per key. A personal key has `akun.saldo_gp`
  and `batas: null`; a customer key has `batas` (limit/used/left/reset) and `akun: null`. Check
  `bisa_dipakai` before blaming the model; top-up link is https://ai.geraikita.com/en/dashboard.

Context priority: your override > Geraikita docs table in server.ts > 128K fallback.
Model names in the picker start with `[Per Request]` (tier `standard`) or `[Token]` (tier `token`).
BB's ACP model catalog can lag ~10 minutes behind the config. Files live on the BB server's machine only.
Never print the API key while debugging.
