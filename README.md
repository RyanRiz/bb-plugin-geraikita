# bb-plugin-geraikita

Settings page for the **Geraikita AI** provider in BB (`acp-geraikita`, OpenCode over ACP).
Claude Code and the normal opencode provider are not touched.

Settings → Plugins → Geraikita AI:
- **Configuration**: API key (`gk-...`, secret) and the provider name shown in BB.
- **Geraikita models**: default-model dropdown (grouped Per Request / Token), last sync + **Sync now**,
  and a searchable model table (filter All / Per Request / Token). Open a row to set its context size
  (K tokens), reset it to the docs value, or make it the default.
- **Usage**: the live balance and key usage from `GET /v1/balance` — GP left, used today/this month/total,
  request counts, minimum cost per request and key status, with a **Refresh** button.

The same balance also appears as a **Geraikita usage** disclosure in the sidebar footer, next to BB's
built-in *Provider usage* card (which cannot show a gateway like Geraikita: it only renders provider
bridges that implement `provider/usage`, and the built-in `provider-acp` answers that from OpenCode's
own credentials).

`GET /v1/balance` is free (no GeraiPoints). The plugin reads it on load, on every sync, every
**60 s** while the Usage card is open, and every **5 minutes** through the `balance-refresh` schedule.
A failure keeps the last figure and shows the reason as *Last error*. A personal key reports an account
balance and no cap; a customer key reports its GP limit instead and never the owner's balance.

Context sizes come from https://ai.geraikita.com/en/docs/model because `/v1/models` does not return them;
models missing there use 128K until you set one.

Syncing writes `~/.config/geraikita/opencode.json` and the 0600 `api-key` file, and reloads `provider-acp`
only when the model list changed. BB's own model catalog for ACP agents can lag up to ~10 minutes
(its picker default may show the previous default meanwhile); OpenCode reads the new config on its next session.

```bash
bb plugin install .
node --experimental-strip-types --test server.test.ts
```
