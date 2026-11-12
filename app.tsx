// Geraikita settings section (default model, sync, model table) + full-colour provider icon.
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { MARK_PATH, SWOOSH_PATH } from "./logo-paths";
import type { rpcContract } from "./server";

type View = {
  hasKey: boolean;
  defaultModel: string;
  lastSync: { ok: boolean; at: string; message: string } | null;
  models: Array<{ id: string; tier: string; ownedBy: string; contextK: number; contextSource: "custom" | "docs" | "fallback" }>;
  balance: Balance | null;
  balanceAt: string | null;
  balanceError: string | null;
};
type Balance = {
  satuan?: string;
  key?: { nama?: string; prefix?: string; jenis?: string; status?: string };
  batas?: { periode?: string; batas_gp?: number; terpakai_gp?: number; sisa_gp?: number; reset_at?: string | null } | null;
  pemakaian_key?: {
    hari_ini_gp?: number;
    bulan_ini_gp?: number;
    total_gp?: number;
    request_hari_ini?: number;
    request_total?: number;
  };
  akun?: { saldo_gp?: number; gp_hadiah?: number; pemakaian_hari_ini_gp?: number; pemakaian_bulan_ini_gp?: number; request_hari_ini?: number } | null;
  bisa_dipakai?: boolean;
  biaya_minimum_gp?: number;
  diperbarui_at?: string;
};
type Model = View["models"][number];
type Filter = "all" | "standard" | "token";

const TIER_TEXT: Record<string, string> = { standard: "Per Request", token: "Token" };
const fmtK = (k: number) => (k >= 1000 && k % 1000 === 0 ? `${k / 1000}M` : `${k.toLocaleString()}K`);

function GeraikitaIcon({ className }: { className?: string }) {
  const id = useId(); // gradient ids must be unique when several icons render on one page
  return (
    <svg viewBox="0 0 1080 1080" className={className} aria-label="Geraikita AI" role="img">
      <defs>
        <linearGradient id={`${id}a`} x1="910.69" y1="641.57" x2="318.89" y2="251.33" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#bba6e3" />
          <stop offset="1" stopColor="#4702b2" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="180" y1="831.81" x2="896.78" y2="831.81" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4702b2" />
          <stop offset=".99" stopColor="#bba6e3" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}a)`} d={MARK_PATH} />
      <path fill={`url(#${id}b)`} d={SWOOSH_PATH} />
    </svg>
  );
}

function Pill({ children, tone }: { children: ReactNode; tone?: "accent" | "warn" | "bad" | "good" }) {
  const toneClass =
    tone === "accent"
      ? "border-violet-500/50 text-violet-500"
      : tone === "warn"
        ? "border-amber-500/50 text-amber-600"
        : tone === "bad"
          ? "border-red-500/50 text-red-500"
          : tone === "good"
            ? "border-emerald-500/50 text-emerald-600"
            : "border-border text-muted-foreground";
  return <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-2xs ${toneClass}`}>{children}</span>;
}

const btn =
  "rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-50";
const input = "rounded-md border border-border bg-background px-2 py-1.5 text-xs";

function SourcePill({ m }: { m: Model }) {
  if (m.contextSource === "custom") return <Pill tone="accent">custom</Pill>;
  if (m.contextSource === "fallback") return <Pill tone="warn">default 128K</Pill>;
  return <Pill>docs</Pill>;
}

const fmtGp = (n: number) => n.toLocaleString();
const gp = (n?: number) => (n === undefined ? "—" : fmtGp(n));

// GET /v1/balance: a personal key has an account balance and no cap; a customer key has a GP limit
// and no visible account. One card handles both.
function BalanceCard({ data, busy, onRefresh }: { data: View; busy: boolean; onRefresh: () => void }) {
  const b = data.balance;
  const unit = b?.satuan ?? "GP";
  const batas = b?.batas ?? null;
  const akun = b?.akun ?? null;
  const usable = b?.bisa_dipakai !== false;
  const remaining = batas?.sisa_gp ?? akun?.saldo_gp;
  const left = batas?.batas_gp && batas.sisa_gp !== undefined ? batas.sisa_gp / batas.batas_gp : undefined;
  const danger = b !== null && !usable;
  const warn =
    !danger &&
    ((left !== undefined && left <= 0.1) ||
      (remaining !== undefined && b?.biaya_minimum_gp !== undefined && remaining < b.biaya_minimum_gp));
  const tone = danger ? "bad" : warn ? "warn" : "good";
  const barClass = danger ? "bg-red-500" : warn ? "bg-amber-500" : "bg-emerald-500";
  const usage = b?.pemakaian_key;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3.5 py-3">
        <span className="text-xs font-semibold">Usage</span>
        <Pill>{unit}</Pill>
        {b?.key?.prefix ? <Pill>{b.key.prefix}…</Pill> : null}
        {b?.key?.jenis ? <Pill>{b.key.jenis === "pelanggan" ? "customer key" : "personal key"}</Pill> : null}
        {b ? <Pill tone={tone}>{danger ? (b.key?.status === "dijeda" ? "paused" : "unusable") : warn ? "low" : "ok"}</Pill> : null}
        <button className={`${btn} ml-auto`} disabled={busy || !data.hasKey} onClick={onRefresh}>
          {busy ? "Working…" : "Refresh"}
        </button>
      </div>

      {!data.hasKey ? (
        <div className="p-3.5 text-2xs text-muted-foreground">Add your Geraikita API key above to see the balance.</div>
      ) : !b ? (
        <div className="p-3.5 text-2xs text-muted-foreground">
          {data.balanceError ? `Could not read the balance: ${data.balanceError}` : "No balance data yet."}
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-3.5 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-lg">
              {gp(remaining)} <span className="text-xs">{unit}</span>
            </span>
            <span className="text-2xs text-muted-foreground">
              {batas ? `left of a ${gp(batas.batas_gp)} ${unit} ${batas.periode ?? "limit"}` : "account balance"}
              {akun?.gp_hadiah ? ` · ${gp(akun.gp_hadiah)} ${unit} bonus` : ""}
            </span>
          </div>
          {left !== undefined ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-state-hover"
              role="progressbar"
              aria-valuenow={Math.round(left * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className={`h-full rounded-full ${barClass}`} style={{ width: `${Math.max(2, Math.min(100, left * 100))}%` }} />
            </div>
          ) : null}
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-2xs">
            <dt className="text-muted-foreground">Used today</dt>
            <dd>
              {gp(usage?.hari_ini_gp)} {unit}
              {usage?.request_hari_ini !== undefined ? ` · ${usage.request_hari_ini} requests` : ""}
            </dd>
            <dt className="text-muted-foreground">Used this month</dt>
            <dd>
              {gp(usage?.bulan_ini_gp)} {unit}
            </dd>
            <dt className="text-muted-foreground">Used total</dt>
            <dd>
              {gp(usage?.total_gp)} {unit}
              {usage?.request_total !== undefined ? ` · ${usage.request_total} requests` : ""}
            </dd>
            {batas ? (
              <>
                <dt className="text-muted-foreground">Limit used</dt>
                <dd>
                  {gp(batas.terpakai_gp)} / {gp(batas.batas_gp)} {unit}
                  {batas.reset_at ? ` · resets ${new Date(batas.reset_at).toLocaleString()}` : ""}
                </dd>
              </>
            ) : null}
            {b.biaya_minimum_gp !== undefined ? (
              <>
                <dt className="text-muted-foreground">Minimum per request</dt>
                <dd>
                  {gp(b.biaya_minimum_gp)} {unit}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Key status</dt>
            <dd>{b.key?.status ?? (usable ? "usable" : "not usable")}</dd>
            <dt className="text-muted-foreground">Last checked</dt>
            <dd>{data.balanceAt ? new Date(data.balanceAt).toLocaleString() : "never"}</dd>
            {data.balanceError ? (
              <>
                <dt className="text-muted-foreground">Last error</dt>
                <dd className="text-red-500">{data.balanceError}</dd>
              </>
            ) : null}
          </dl>
          {danger || warn ? (
            <div className="text-2xs text-muted-foreground">
              {danger ? "This key cannot be used right now. Top up or raise its limit at " : "Running low. Top up at "}
              <a className="text-violet-500 underline" href="https://ai.geraikita.com/en/dashboard" target="_blank" rel="noreferrer">
                ai.geraikita.com/dashboard
              </a>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ModelRow({ m, isDefault, busy, run }: { m: Model; isDefault: boolean; busy: boolean; run: (fn: () => Promise<View>) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(m.contextK));
  useEffect(() => setDraft(String(m.contextK)), [m.contextK]);
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000;

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-state-hover"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">{m.id}</span>
        {isDefault ? <Pill tone="good">default</Pill> : null}
        <Pill tone={m.tier === "token" ? "accent" : undefined}>{TIER_TEXT[m.tier] ?? m.tier}</Pill>
        <span className="w-16 text-right font-mono text-2xs">{fmtK(m.contextK)}</span>
        <SourcePill m={m} />
        <span className="text-2xs text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="bg-sidebar px-3.5 pb-3.5 pl-8">
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 py-2 text-2xs">
            <dt className="text-muted-foreground">Model ID</dt>
            <dd className="font-mono">{m.id}</dd>
            <dt className="text-muted-foreground">API type</dt>
            <dd>{m.tier === "token" ? "Token API (billed per token)" : "Per-Request API (flat price per request)"}</dd>
            <dt className="text-muted-foreground">Vendor</dt>
            <dd>{m.ownedBy || "—"}</dd>
            <dt className="text-muted-foreground">Context source</dt>
            <dd>
              {m.contextSource === "custom"
                ? "Set by you"
                : m.contextSource === "docs"
                  ? "Geraikita docs"
                  : "Not in the docs; 128K fallback (OpenCode may compact early)"}
            </dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-2xs text-muted-foreground" htmlFor={`ctx-${m.id}`}>
              Context (K tokens)
            </label>
            <input
              id={`ctx-${m.id}`}
              type="number"
              min={1}
              max={10000}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={`${input} w-28 font-mono`}
            />
            <button
              className={btn}
              disabled={busy || !valid || parsed === m.contextK}
              onClick={() => run(() => rpc.call("setContext", { id: m.id, contextK: parsed }) as Promise<View>)}
            >
              Save
            </button>
            <button
              className={btn}
              disabled={busy || m.contextSource !== "custom"}
              onClick={() => run(() => rpc.call("setContext", { id: m.id, contextK: null }) as Promise<View>)}
            >
              Reset
            </button>
            <button
              className={btn}
              disabled={busy || isDefault}
              onClick={() => run(() => rpc.call("setDefaultModel", { id: m.id }) as Promise<View>)}
            >
              Set as default
            </button>
            {!valid ? <span className="text-2xs text-red-500">Enter a whole number from 1 to 10000.</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setData((await rpc.call("view", null)) as View);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rpc]);
  useEffect(() => void load(), [load]);
  useRealtime("state-changed", () => void load());

  const run = useCallback((fn: () => Promise<View>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  // Keep the balance fresh while this section is open; /v1/balance allows 30 calls a minute per key.
  useEffect(() => {
    const timer = setInterval(() => {
      rpc.call("refreshBalance", null).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(timer);
  }, [rpc]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.models ?? []).filter(
      (m) => (filter === "all" || m.tier === filter) && (!q || m.id.toLowerCase().includes(q) || m.ownedBy.toLowerCase().includes(q)),
    );
  }, [data, filter, query]);

  if (!data) return <div className="p-4 text-2xs text-muted-foreground">{error ?? "Loading…"}</div>;

  const count = (t: Filter) => (t === "all" ? data.models.length : data.models.filter((m) => m.tier === t).length);
  const byTier = (t: string) => data.models.filter((m) => m.tier === t);

  return (
    <div className="flex flex-col gap-4">
      <BalanceCard data={data} busy={busy} onRefresh={() => run(() => rpc.call("refreshBalance", null) as Promise<View>)} />

      {!data.hasKey ? (
        <div className="rounded-lg border border-amber-500/50 p-3 text-xs">Add your Geraikita API key above, then sync.</div>
      ) : null}

      <div className="rounded-lg border border-border">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-3.5 py-3">
          <label htmlFor="gk-default" className="min-w-[140px] text-xs">
            Default model
          </label>
          <select
            id="gk-default"
            className={`${input} min-w-[240px] flex-1 font-mono`}
            value={data.defaultModel}
            disabled={busy || data.models.length === 0}
            onChange={(e) => run(() => rpc.call("setDefaultModel", { id: e.target.value }) as Promise<View>)}
          >
            {data.models.length === 0 ? <option value={data.defaultModel}>{data.defaultModel}</option> : null}
            {(["standard", "token"] as const).map((t) =>
              byTier(t).length ? (
                <optgroup key={t} label={TIER_TEXT[t]}>
                  {byTier(t).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </optgroup>
              ) : null,
            )}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
          <span className="min-w-[140px] text-xs">Last sync</span>
          <span className="flex-1 text-2xs text-muted-foreground">
            {data.lastSync ? (
              <>
                <Pill tone={data.lastSync.ok ? "good" : "bad"}>{data.lastSync.ok ? "ok" : "failed"}</Pill>{" "}
                {new Date(data.lastSync.at).toLocaleString()} · {data.lastSync.message}
              </>
            ) : (
              "never"
            )}
          </span>
          <button className={btn} disabled={busy || !data.hasKey} onClick={() => run(() => rpc.call("sync", null) as Promise<View>)}>
            {busy ? "Working…" : "Sync now"}
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-red-500/50 p-3 text-xs text-red-500">{error}</div> : null}

      <div className="rounded-lg border border-border">
        <div className="border-b border-border px-3.5 py-3">
          <div className="text-xs font-semibold">Models</div>
          <div className="text-2xs text-muted-foreground">
            Context sizes come from the Geraikita docs (the API does not return them). Models missing from the docs fall back to
            128K. Open a row to set your own size.
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(["all", "standard", "token"] as const).map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-3 py-1 text-2xs ${filter === f ? "border-violet-500 text-violet-500" : "border-border hover:bg-state-hover"}`}
              >
                {f === "all" ? "All" : TIER_TEXT[f]} {count(f)}
              </button>
            ))}
            <input
              aria-label="Search models"
              placeholder="Search model or vendor"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${input} ml-auto w-56`}
            />
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="p-4 text-2xs text-muted-foreground">{data.models.length ? "No models match." : "No models yet. Sync first."}</div>
        ) : (
          shown.map((m) => <ModelRow key={m.id} m={m} isDefault={m.id === data.defaultModel} busy={busy} run={run} />)
        )}
      </div>
    </div>
  );
}

// Sidebar-footer disclosure: the balance beside bb's built-in "Provider usage" card. That card only
// renders provider bridges implementing `provider/usage`, which the built-in provider-acp serves
// from OpenCode's own credentials, so a gateway like Geraikita cannot appear there.
function BalanceFooter() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData((await rpc.call("view", null)) as View);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [rpc]);
  useEffect(() => void load(), [load]);
  useRealtime("state-changed", () => void load());

  useEffect(() => {
    rpc.call("refreshBalance", null).catch(() => undefined);
  }, [rpc]);

  const run = useCallback((fn: () => Promise<View>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  if (!data) return <div className="p-3 text-2xs text-muted-foreground">{error ?? "Loading…"}</div>;
  return (
    <div className="p-2">
      <BalanceCard data={data} busy={busy} onRefresh={() => run(() => rpc.call("refreshBalance", null) as Promise<View>)} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "acp-geraikita", icon: GeraikitaIcon });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "balance",
    label: "Geraikita usage",
    icon: "ChartColumn",
    component: BalanceFooter,
  });
  app.slots.settingsSection({
    id: "models",
    title: "Geraikita models",
    description: "Balance, default model, model sync and per-model context size.",
    component: SettingsSection,
  });
});
