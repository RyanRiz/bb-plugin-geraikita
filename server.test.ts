import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceSchema, buildOpencodeConfig, resolveContext } from "./server.ts";

test("labels by billing tier; context = override > docs > 128K fallback", () => {
  const overrides = { "gemma-3-4b": 64 };
  const cfg = buildOpencodeConfig({
    models: [{ id: "glm-5.3", tier: "standard" }, { id: "glm-5.3-token", tier: "token" }, { id: "gemma-3-4b", tier: "standard" }, { id: "brand-new", tier: "standard" }],
    defaultModel: "glm-5.3",
    contextOverridesK: overrides,
  });
  const m = cfg.provider.geraikita.models as Record<string, { name: string; limit: { context: number } }>;
  assert.equal(m["glm-5.3"].name, "[Per Request] glm-5.3");
  assert.equal(m["glm-5.3-token"].name, "[Token] glm-5.3-token");
  assert.equal(m["glm-5.3-token"].limit.context, 1_000_000);
  assert.equal(m["gemma-3-4b"].limit.context, 64_000);
  assert.equal(m["brand-new"].limit.context, 128_000);
  assert.deepEqual(resolveContext("deepseek-v4-pro-0813-token", {}), { contextK: 512, source: "docs" });
  assert.equal(resolveContext("brand-new", {}).source, "fallback");
  assert.equal(cfg.model, "geraikita/glm-5.3");
});

test("balance keeps both key shapes (customer limit, personal account) and unknown fields", () => {
  // The customer-key example from https://ai.geraikita.com/en/docs/saldo
  const customer = balanceSchema.parse({
    object: "balance",
    satuan: "GP",
    key: { nama: "Toko Budi", prefix: "gk-AbCdEfGh", jenis: "pelanggan", status: "aktif" },
    batas: { periode: "bulanan", batas_gp: 50000, terpakai_gp: 12500, sisa_gp: 37500, reset_at: "2026-11-30T17:00:00.000Z" },
    pemakaian_key: { hari_ini_gp: 800, bulan_ini_gp: 12500, total_gp: 40100, request_hari_ini: 14, request_total: 702 },
    akun: null,
    bisa_dipakai: true,
    diperbarui_at: "2026-11-05T03:12:09.000Z",
  });
  assert.equal(customer.batas?.sisa_gp, 37500);
  assert.equal(customer.akun, null);

  // A personal key: no `batas`, an account balance present.
  const personal = balanceSchema.parse({
    satuan: "GP",
    key: { prefix: "gk-InPyMclC1", jenis: "pribadi", status: "aktif" },
    batas: null,
    pemakaian_key: { hari_ini_gp: 6384, request_hari_ini: 123 },
    akun: { saldo_gp: 12253, gp_hadiah: 0 },
    bisa_dipakai: true,
    biaya_minimum_gp: 5,
  });
  assert.equal(personal.akun?.saldo_gp, 12253);
  assert.equal(personal.batas, null);
  assert.equal(personal.biaya_minimum_gp, 5);

  // Unknown or moved fields must not throw: they are stripped, not rejected.
  const sparse = balanceSchema.parse({ bisa_dipakai: false, something_new: 1 });
  assert.equal(sparse.bisa_dipakai, false);
  assert.equal(sparse.akun, undefined);
});
