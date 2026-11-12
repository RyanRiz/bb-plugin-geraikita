// bb-plugin-geraikita — Settings page for the Geraikita AI provider.
//
// The provider itself is OpenCode over ACP (provider id `acp-geraikita`), registered in the
// provider-acp plugin's customAgents. Claude Code and the normal opencode provider are untouched.
// On load, on settings saves and from the settings section (RPC) this plugin: writes the key file,
// pulls /v1/models, writes an OpenCode config with every model labelled [Per Request] / [Token]
// and its context size, and refreshes provider-acp so BB lists the result.
// It also mirrors GET /v1/balance (GeraiPoints balance, key usage, key limit) into state and
// publishes it to the settings section and the sidebar footer, with a scheduled refresh.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// shortcut: files live on the BB server's machine, so the provider only works on that host;
// move this into a bb.host entry if threads must run on other enrolled machines.
const DIR = join(homedir(), ".config", "geraikita");
const KEY_FILE = join(DIR, "api-key");
const CONFIG_FILE = join(DIR, "opencode.json");
const AGENT_ID = "geraikita";
const ACP_PLUGIN = "provider-acp";
const FALLBACK_MODEL = "glm-5.3";
const FALLBACK_CONTEXT_K = 128;
const TIER_LABEL: Record<string, string> = { standard: "[Per Request]", token: "[Token]" };

// Context sizes (K tokens) from https://ai.geraikita.com/en/docs/model; the API omits them.
// "-token" variants share their base model's size. Users override any of these in the settings table.
const DOCS_CTX_K: Record<string, number> = {};
const ctx = (k: number, ids: string) => ids.split(/\s+/).filter(Boolean).forEach((id) => (DOCS_CTX_K[id] = k));
ctx(1000, `claude-opus-5 claude-opus-4-8 claude-opus-4-6 claude-opus-4-7 claude-sonnet-5 claude-sonnet-4-6
  claude-fable-5 claude-opus-5-thinking claude-sonnet-5-thinking glm-5.3 glm-5.2 qwen-max claude-opus-5-5
  claude-fable-5-1 claude-fable-5.1 claude-sonnet-5-5 claude-haiku-5-5 gpt-6-astra gpt-6-sol gpt-6-luna
  gpt-6-1-sol gemini-4-argon gemini-3.8-flash glm-5-3-flash glm-5.3-flash qwen-3-8-flash qwen-3-8-max
  deepseek-v4-1-flash-1017 deepseek-v4.1-flash-uncensored`);
ctx(512, `deepseek-v4-pro deepseek-v4-pro-0813 deepseek-v4.1-flash deepseek-v4-flash deepseek-v4-flash-0731
  gpt-5.6-luna gpt-5.6-sol gpt-5.6-terra`);
ctx(256, `kimi-k3 devstral-2-123b mistral-large-3 moonshot-kimi-k2-thinking moonshot-kimi-k2.5
  qwen3-coder-480b-a35b qwen3-coder-30b-a3b qwen3-next-80b-a3b qwen3-vl-235b-a22b qwen3-235b-a22b-2507
  qwen3-coder-next`);
ctx(200, "minimaxai-m2.5 minimaxai-m2.1 minimaxai-m2 zai-glm-4.7-flash zai-glm-4.7 zai-glm-5");
export const docsContextK = (id: string): number | null => DOCS_CTX_K[id.replace(/-token$/, "")] ?? null;

const gkModel = z.object({ id: z.string(), tier: z.string().optional(), owned_by: z.string().optional() });
type GkModel = z.infer<typeof gkModel>;

// Shape of GET /v1/balance (https://ai.geraikita.com/en/docs/saldo). Everything optional: the
// gateway may add or drop fields, and a failure keeps the last figure we cached.
export const balanceSchema = z.object({  satuan: z.string().optional(),
  key: z
    .object({
      nama: z.string().optional(),
      prefix: z.string().optional(),
      jenis: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
  // Present only for customer keys: the GP limit, what it used, and when it resets.
  batas: z
    .object({
      periode: z.string().optional(),
      batas_gp: z.number().optional(),
      terpakai_gp: z.number().optional(),
      sisa_gp: z.number().optional(),
      reset_at: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  pemakaian_key: z
    .object({
      hari_ini_gp: z.number().optional(),
      bulan_ini_gp: z.number().optional(),
      total_gp: z.number().optional(),
      request_hari_ini: z.number().optional(),
      request_total: z.number().optional(),
    })
    .optional(),
  // null for customer keys, whose owner's balance is never exposed.
  akun: z
    .object({
      saldo_gp: z.number().optional(),
      gp_hadiah: z.number().optional(),
      pemakaian_hari_ini_gp: z.number().optional(),
      pemakaian_bulan_ini_gp: z.number().optional(),
      request_hari_ini: z.number().optional(),
    })
    .nullable()
    .optional(),
  bisa_dipakai: z.boolean().optional(),
  biaya_minimum_gp: z.number().optional(),
  diperbarui_at: z.string().optional(),
});
type Balance = z.infer<typeof balanceSchema>;

const stateSchema = z.object({
  models: z.array(gkModel).default([]),
  defaultModel: z.string().default(FALLBACK_MODEL),
  contextOverridesK: z.record(z.string(), z.number()).default({}),
  lastSync: z.object({ ok: z.boolean(), at: z.string(), message: z.string() }).nullable().default(null),
  balance: balanceSchema.nullable().default(null),
  balanceAt: z.string().nullable().default(null), // when we last read /v1/balance (attempt, ok or not)
  balanceError: z.string().nullable().default(null),
});
type State = z.infer<typeof stateSchema>;

export function resolveContext(id: string, overrides: Record<string, number>) {
  if (overrides[id] !== undefined) return { contextK: overrides[id], source: "custom" as const };
  const docs = docsContextK(id);
  if (docs !== null) return { contextK: docs, source: "docs" as const };
  return { contextK: FALLBACK_CONTEXT_K, source: "fallback" as const };
}

export function buildOpencodeConfig(state: Pick<State, "models" | "defaultModel" | "contextOverridesK">) {
  const entries = state.models.map((m) => [
    m.id,
    {
      name: `${TIER_LABEL[m.tier ?? ""] ?? `[${m.tier ?? "?"}]`} ${m.id}`,
      limit: { context: resolveContext(m.id, state.contextOverridesK).contextK * 1000, output: 32_000 },
    },
  ]);
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["geraikita"],
    model: `geraikita/${state.defaultModel}`,
    provider: {
      geraikita: {
        npm: "@ai-sdk/openai-compatible",
        name: "Geraikita AI",
        options: {
          baseURL: "https://ai.geraikita.com/v1",
          apiKey: `{file:${KEY_FILE}}`, // key stays in a 0600 file, never in BB settings JSON or env
          timeout: 300_000,
        },
        models: Object.fromEntries(entries),
      },
    },
  };
}

const modelRow = z.object({
  id: z.string(),
  tier: z.string(),
  ownedBy: z.string(),
  contextK: z.number(),
  contextSource: z.enum(["custom", "docs", "fallback"]),
});
const viewSchema = z.object({
  hasKey: z.boolean(),
  defaultModel: z.string(),
  lastSync: stateSchema.shape.lastSync,
  models: z.array(modelRow),
  balance: balanceSchema.nullable(),
  balanceAt: z.string().nullable(),
  balanceError: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  view: { input: z.null(), output: viewSchema },
  sync: { input: z.null(), output: viewSchema },
  refreshBalance: { input: z.null(), output: viewSchema },
  setDefaultModel: { input: z.object({ id: z.string().min(1).max(200) }), output: viewSchema },
  // contextK null = drop the override and go back to the docs / fallback size.
  setContext: {
    input: z.object({ id: z.string().min(1).max(200), contextK: z.number().int().min(1).max(10_000).nullable() }),
    output: viewSchema,
  },
});

async function readOr(path: string, fallback: string) {
  return readFile(path, "utf8").catch(() => fallback);
}

export default function geraikita(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: { type: "string", label: "Geraikita API key (gk-...)", secret: true },
    displayName: { type: "string", label: "Provider name in BB", default: "Geraikita AI" },
  });

  const loadState = async (): Promise<State> => stateSchema.parse((await bb.storage.kv.get("state")) ?? {});
  const saveState = (s: State) => bb.storage.kv.set("state", s);

  async function apiKey() {
    const { apiKey } = await settings.get();
    return typeof apiKey === "string" ? apiKey.trim() : "";
  }

  async function view() {
    const s = await loadState();
    return {
      hasKey: (await apiKey()) !== "",
      defaultModel: s.defaultModel,
      lastSync: s.lastSync,
      models: s.models.map((m) => {
        const c = resolveContext(m.id, s.contextOverridesK);
        return { id: m.id, tier: m.tier ?? "?", ownedBy: m.owned_by ?? "", contextK: c.contextK, contextSource: c.source };
      }),
      balance: s.balance,
      balanceAt: s.balanceAt,
      balanceError: s.balanceError,
    };
  }

  // Writes config files from state and refreshes provider-acp when anything changed.
  async function apply(s: State) {
    const key = await apiKey();
    await mkdir(DIR, { recursive: true, mode: 0o700 });
    await writeFile(KEY_FILE, key, { mode: 0o600 });
    await chmod(KEY_FILE, 0o600);
    const nextCfg = buildOpencodeConfig(s);
    const prevRaw = await readOr(CONFIG_FILE, "");
    const prevNames = prevRaw ? JSON.stringify(Object.keys(JSON.parse(prevRaw).provider?.geraikita?.models ?? {})) : "";
    const next = JSON.stringify(nextCfg, null, 2) + "\n";
    if (next !== prevRaw) await writeFile(CONFIG_FILE, next, { mode: 0o600 });
    const agentsChanged = await upsertAcpAgent((await settings.get()).displayName.trim() || "Geraikita AI");
    // Reload provider-acp only when the model list itself changed: a reload can interrupt running
    // ACP threads, and context/default edits reach OpenCode on its next session without it.
    const listChanged = prevNames !== JSON.stringify(Object.keys(nextCfg.provider.geraikita.models));
    if (listChanged && !agentsChanged) await bb.sdk.plugins.reload({ pluginId: ACP_PLUGIN });
    bb.realtime.publish("state-changed", null);
  }

  let queue: Promise<unknown> = Promise.resolve();
  // Serialise every state change so a sync and a table edit never overwrite each other.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const sync = () =>
    serial(async () => {
      const key = await apiKey();
      const s = await loadState();
      if (!key) {
        bb.status.needsConfiguration("Set your Geraikita API key in this plugin's settings.");
        return;
      }
      try {
        const res = await fetch("https://ai.geraikita.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Geraikita /v1/models returned HTTP ${res.status}${res.status === 401 ? " (bad API key?)" : ""}`);
        const models = z.object({ data: z.array(gkModel) }).parse(await res.json()).data;
        if (models.length === 0) throw new Error("Geraikita returned no models");
        s.models = models;
        if (!models.some((m) => m.id === s.defaultModel)) {
          s.defaultModel = models.some((m) => m.id === FALLBACK_MODEL) ? FALLBACK_MODEL : models[0].id;
        }
        const perRequest = models.filter((m) => m.tier === "standard").length;
        s.lastSync = {
          ok: true,
          at: new Date().toISOString(),
          message: `${models.length} models (${perRequest} per-request, ${models.length - perRequest} token)`,
        };
        await fetchBalanceInto(s);
        await saveState(s);
        await apply(s);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bb.log.error(`geraikita sync failed: ${msg}`);
        s.lastSync = { ok: false, at: new Date().toISOString(), message: msg };
        await saveState(s);
        bb.realtime.publish("state-changed", null);
      }
    });

  // Reads GET /v1/balance into `s`. Never throws: a failure keeps the previous figure and records
  // why. Call inside an existing serial block (from sync or refreshBalance), never on its own.
  async function fetchBalanceInto(s: State) {
    const key = await apiKey();
    if (!key) return;
    try {
      const res = await fetch("https://ai.geraikita.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Geraikita /v1/balance returned HTTP ${res.status}${res.status === 401 ? " (bad API key?)" : ""}`);
      s.balance = balanceSchema.parse(await res.json());
      s.balanceError = null;
    } catch (err) {
      s.balanceError = err instanceof Error ? err.message : String(err);
      bb.log.warn(`geraikita balance refresh failed: ${s.balanceError}`);
    }
    s.balanceAt = new Date().toISOString();
  }

  const refreshBalance = () =>
    serial(async () => {
      if (!(await apiKey())) return;
      const s = await loadState();
      await fetchBalanceInto(s);
      await saveState(s);
      bb.realtime.publish("state-changed", null);
    });

  const edit = (change: (s: State) => void) =>
    serial(async () => {
      const s = await loadState();
      change(s);
      await saveState(s);
      if (s.models.length > 0 && (await apiKey())) await apply(s);
    });

  // Adds or updates our entry in provider-acp's customAgents, keeping everyone else's entries.
  async function upsertAcpAgent(displayName: string): Promise<boolean> {
    const current = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN });
    const raw = current.values.customAgents;
    let agents: Array<Record<string, unknown>> = [];
    if (typeof raw === "string" && raw.trim()) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("provider-acp customAgents is not a JSON array");
      agents = parsed;
    }
    const entry = {
      id: AGENT_ID,
      displayName,
      command: "opencode",
      args: ["acp"],
      env: { OPENCODE_CONFIG: CONFIG_FILE },
      dialect: "opencode",
    };
    const existing = agents.find((a) => a.id === AGENT_ID);
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) return false;
    await bb.sdk.plugins.updateSettings({
      pluginId: ACP_PLUGIN,
      values: { customAgents: JSON.stringify([...agents.filter((a) => a.id !== AGENT_ID), entry]) },
    });
    return true;
  }

  bb.rpc.register(rpcContract, {
    view: () => view(),
    sync: async () => (await sync(), view()),
    refreshBalance: async () => (await refreshBalance(), view()),
    setDefaultModel: async ({ id }) => {
      await edit((s) => {
        if (!s.models.some((m) => m.id === id)) throw new Error(`Unknown model ${id}`);
        s.defaultModel = id;
      });
      return view();
    },
    setContext: async ({ id, contextK }) => {
      await edit((s) => {
        if (!s.models.some((m) => m.id === id)) throw new Error(`Unknown model ${id}`);
        if (contextK === null) delete s.contextOverridesK[id];
        else s.contextOverridesK[id] = contextK;
      });
      return view();
    },
  });

  settings.onChange((next, prev) => {
    if (next.apiKey !== prev.apiKey || next.displayName !== prev.displayName) void sync();
  });
  // Keep the balance figure warm between visits; /v1/balance is free (no GeraiPoints).
  bb.background.schedule("balance-refresh", "*/5 * * * *", () => refreshBalance());
  void sync();
}
