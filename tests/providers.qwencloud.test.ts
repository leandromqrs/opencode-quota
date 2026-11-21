import { describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import type { QuotaProviderContext } from "../src/lib/entries.js";
import { qwenCloudProvider } from "../src/providers/qwencloud.js";

const observedAt = "2026-11-11T00:00:00.000Z";
const resetAt = "2026-11-15T00:00:00.000Z";
const reply = (fraction = 0.5715795927593333) => ({
  state: "ready",
  source: "alibaba-console-cli",
  accountBinding: "unverified",
  observedAt,
  balances: [],
  diagnostics: [],
  personalWindows: [{ period: "monthly", scope: "personal", usedFraction: fraction, resetAt }],
});
function context(
  read = vi.fn(async (_signal: AbortSignal): Promise<unknown> => reply()),
): QuotaProviderContext {
  return {
    client: { config: { providers: async () => ({ data: { providers: [{ id: "qwencloud" }] } }) } },
    workspaceRoot: "/synthetic",
    locationDirectory: "/synthetic",
    resolveRuntimeProviderIds: async () => new Set(["qwencloud"]),
    readQwenCloudQuota: read,
    config: { cursorPlan: "auto", enabledProviders: ["qwencloud"], currentProviderID: "qwencloud" },
  };
}

describe("QwenCloud native quota", () => {
  it("discovers without reading quota and matches only the native provider", async () => {
    const read = vi.fn(async () => reply());
    const ctx = context(read);
    expect(await qwenCloudProvider.isAvailable(ctx)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(qwenCloudProvider.matchesCurrentModel?.("qwencloud/qwen3")).toBe(true);
    expect(qwenCloudProvider.matchesCurrentModel?.("openrouter/qwen/qwen3")).toBe(false);
    expect(qwenCloudProvider.matchesCurrentModel?.("alibaba-token-plan/qwen3")).toBe(false);
    expect(await qwenCloudProvider.isAvailable({ ...ctx, readQwenCloudQuota: undefined })).toBe(
      false,
    );
    expect(
      await qwenCloudProvider.isAvailable({
        ...ctx,
        resolveRuntimeProviderIds: async () => new Set(["openai"]),
      }),
    ).toBe(false);
    expect(qwenCloudProvider.cachePolicy).toEqual({ kind: "uncached" });
  });

  it("uses the native RPC, keeps the unverified CLI origin and never invents counts", async () => {
    for (const fraction of [0, 1, 0.5715795927593333]) {
      const ctx = context(vi.fn(async () => reply(fraction)));
      const result = await qwenCloudProvider.fetch(ctx);
      expect(result.attempted).toBe(true);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].name).toBe("Alibaba console (account unverified)");
      expect(result.accounts[0].login).toBeUndefined();
      expect(result.accounts[0].rows).toEqual([
        {
          key: "personal.monthly",
          label: "Monthly",
          type: "quota",
          method: "local_cli",
          authority: "provider_reported",
          prominence: "primary",
          window: "month",
          percentRemaining: 100 - fraction * 100,
          resetsAt: resetAt,
        },
      ]);
      expect(ctx.readQwenCloudQuota).toHaveBeenCalledOnce();
    }
  });

  it("does not call the reader for another selected provider or a missing native capability", async () => {
    const ctx = context();
    const result = await qwenCloudProvider.fetch({
      ...ctx,
      config: { ...ctx.config, currentProviderID: "openai" },
    });
    expect(result).toMatchObject({ attempted: false, skipped: true, accounts: [] });
    expect(rowsFromProviderResult("qwencloud", result)).toEqual({
      rows: [],
      skipped: true,
      debug: [],
    });
    expect(ctx.readQwenCloudQuota).not.toHaveBeenCalled();
    expect(
      await qwenCloudProvider.fetch({
        ...ctx,
        config: { ...ctx.config, currentProviderID: undefined, currentModel: "openai/gpt-5" },
      }),
    ).toMatchObject({ attempted: false });
    const missing = await qwenCloudProvider.fetch({ ...ctx, readQwenCloudQuota: undefined });
    expect(missing).toEqual({ attempted: false, accounts: [], debug: [] });
    expect(rowsFromProviderResult("qwencloud", missing).error).toEqual({ code: "not_configured" });
  });

  it("rejects forged provenance, team balances, malformed windows and state combinations", async () => {
    const value = reply();
    for (const invalid of [
      { ...value, source: "qwencloud-token-plan" },
      { ...value, accountBinding: "verified" },
      { ...value, balances: [{ remaining: "42", scope: "team" }] },
      { ...value, personalWindows: [{ ...value.personalWindows[0], scope: "team" }] },
      { ...value, personalWindows: [{ ...value.personalWindows[0], usedFraction: -1 }] },
      { ...value, personalWindows: [{ ...value.personalWindows[0], usedFraction: NaN }] },
      { ...value, personalWindows: [{ ...value.personalWindows[0], usedFraction: "0.5" }] },
      { ...value, personalWindows: [{ ...value.personalWindows[0], resetAt: "invalid" }] },
      { ...value, personalWindows: [value.personalWindows[0], value.personalWindows[0]] },
      { ...value, state: "unknown" },
      { ...value, state: "error" },
      { ...value, diagnostics: [{ action: "PRIVATE", code: "PRIVATE" }] },
      { ...value, secret: "PRIVATE" },
      null,
    ]) {
      const result = await qwenCloudProvider.fetch(context(vi.fn(async () => invalid)));
      expect(result.accounts[0].rows).toEqual([]);
      expect(result.accounts[0].errors[0].facts?.code).toBe("bad_response");
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
  });

  it("keeps unknown and errors distinct from zero quota with safe diagnostics", async () => {
    for (const [state, code, expected] of [
      ["unknown", "missing-balance", "no_data"],
      ["error", "unauthorized", "login_expired"],
      ["error", "cli-not-found", "local_tool"],
      ["error", "timeout", "timeout"],
    ]) {
      const value = {
        ...reply(),
        state,
        personalWindows: undefined,
        diagnostics: [{ action: "AlibabaTokenPlanUsage", code }],
      };
      delete value.personalWindows;
      const result = await qwenCloudProvider.fetch(context(vi.fn(async () => value)));
      expect(result.accounts[0].rows).toEqual([]);
      expect(result.accounts[0].errors[0].facts?.code).toBe(expected);
    }
  });

  it("bounds the RPC and aborts it without retaining timers or leaking errors", async () => {
    const ctx = context(
      vi.fn(async () => {
        throw new Error("PRIVATE");
      }),
    );
    expect(JSON.stringify(await qwenCloudProvider.fetch(ctx))).not.toContain("PRIVATE");
    let signal: AbortSignal | undefined;
    ctx.readQwenCloudQuota = async (value) => {
      signal = value;
      return new Promise(() => {});
    };
    ctx.config.requestTimeoutMs = 10;
    const result = await qwenCloudProvider.fetch(ctx);
    expect(signal?.aborted).toBe(true);
    expect(result.accounts[0].errors[0].facts?.code).toBe("timeout");
  });

  it("releases its request signal after a successful read and accepts an absent reset", async () => {
    let signal: AbortSignal | undefined;
    const value = reply(0);
    const { resetAt: _resetAt, ...window } = value.personalWindows[0];
    const ctx = context(
      vi.fn(async (incoming) => {
        signal = incoming;
        return { ...value, personalWindows: [window] };
      }),
    );
    const result = await qwenCloudProvider.fetch(ctx);
    expect(signal?.aborted).toBe(true);
    expect(result.accounts[0].rows[0].resetsAt).toBeUndefined();
    expect(result.accounts[0].rows[0].percentRemaining).toBe(100);
  });
});
