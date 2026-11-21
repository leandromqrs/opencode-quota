import type { QuotaErrorCode } from "../core/types.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { failedAccount, type ProviderFetchResult } from "./contract.js";

const ACCOUNT = "Alibaba console (account unverified)";
const MANAGEMENT_ACCOUNT = "QwenCloud management account";
const INDIVIDUAL_API = "qwencloud-individual-api";
const CODES = [
  "cancelled",
  "timeout",
  "unauthorized",
  "body-too-large",
  "invalid-response",
  "invalid-amount",
  "invalid-reset",
  "missing-balance",
  "cli-not-found",
  "cli-unsupported",
  "cli-failed",
] as const;
type DiagnosticCode = (typeof CODES)[number];
const API_CODES = [
  "invalid-credentials", "session-expired", "credentials-unavailable", "account-changed",
  "cancelled", "timeout", "unauthorized", "rate-limited", "http-error", "network-error",
  "body-too-large", "invalid-response", "business-error", "invalid-amount", "invalid-reset",
  "missing-balance",
] as const;
type ApiCode = (typeof API_CODES)[number];
type PersonalWindow = { usedFraction: number; resetAt?: string };
type NativeQuota = {
  source: "alibaba-console-cli" | typeof INDIVIDUAL_API;
  state: "ready" | "unknown" | "error" | "disconnected";
  windows: PersonalWindow[];
  codes: (DiagnosticCode | ApiCode)[];
};

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid native quota response");
  return value as Record<string, unknown>;
}

function isTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function decodeQuota(value: unknown): NativeQuota {
  const data = record(value, [
    "state",
    "source",
    "accountBinding",
    "observedAt",
    "balances",
    "diagnostics",
    "personalWindows",
  ]);
  const api = data.source === INDIVIDUAL_API;
  if (
    (!api && data.source !== "alibaba-console-cli") ||
    (api ? "accountBinding" in data : data.accountBinding !== "unverified") ||
    !isTime(data.observedAt) ||
    !Array.isArray(data.balances) ||
    data.balances.length !== 0 ||
    !Array.isArray(data.diagnostics) ||
    data.diagnostics.length > 32
  )
    throw new Error("Invalid native quota response");
  if (data.state !== "ready" && data.state !== "unknown" && data.state !== "error" &&
      !(api && data.state === "disconnected"))
    throw new Error("Invalid native quota state");
  const codes = data.diagnostics.map((raw) => {
    const diagnostic = record(raw, ["action", "code"]);
    if (
      api
        ? !["quota", "GenerateCLIAccessToken", "IndividualTokenPlanUsage"].includes(String(diagnostic.action)) ||
          !API_CODES.includes(diagnostic.code as ApiCode)
        : diagnostic.action !== "AlibabaTokenPlanUsage" ||
          !CODES.includes(diagnostic.code as DiagnosticCode)
    )
      throw new Error("Invalid native quota diagnostic");
    return diagnostic.code as DiagnosticCode | ApiCode;
  });
  if (
    "personalWindows" in data &&
    (!Array.isArray(data.personalWindows) || data.personalWindows.length > 1)
  )
    throw new Error("Invalid native quota windows");
  const windows = ((data.personalWindows ?? []) as unknown[]).map((raw) => {
    const window = record(raw, ["period", "scope", "usedFraction", "resetAt"]);
    if (
      window.period !== "monthly" ||
      window.scope !== "personal" ||
      typeof window.usedFraction !== "number" ||
      !Number.isFinite(window.usedFraction) ||
      window.usedFraction < 0 ||
      window.usedFraction > 1 ||
      ("resetAt" in window && !isTime(window.resetAt))
    )
      throw new Error("Invalid native quota window");
    return {
      usedFraction: window.usedFraction,
      ...(typeof window.resetAt === "string" ? { resetAt: window.resetAt } : {}),
    };
  });
  if (
    data.state === "ready"
      ? windows.length !== 1 || codes.length !== 0
      : windows.length !== 0 || (data.state === "error" && codes.length === 0) ||
        (data.state === "disconnected" && codes.length !== 0)
  )
    throw new Error("Inconsistent native quota state");
  return { source: api ? INDIVIDUAL_API : "alibaba-console-cli", state: data.state, windows, codes };
}

function failure(code: QuotaErrorCode, message: string, account = ACCOUNT): ProviderFetchResult {
  return { attempted: true, accounts: [failedAccount(account, message, { code })], debug: [] };
}

function individualFailure(quota: NativeQuota): ProviderFetchResult {
  const fail = (code: QuotaErrorCode, message: string) => failure(code, message, MANAGEMENT_ACCOUNT);
  if (quota.state === "disconnected") return fail("not_configured", "Connect QwenCloud management OAuth in OpenCode.");
  if (quota.state === "unknown") return fail("no_data", "QwenCloud returned no monthly Individual Token Plan data.");
  switch (quota.codes[0]) {
    case "session-expired":
    case "unauthorized": return fail("login_expired", "Sign in to QwenCloud in OpenCode again.");
    case "invalid-credentials":
    case "credentials-unavailable": return fail("not_configured", "QwenCloud management credentials are unavailable.");
    case "timeout": return fail("timeout", "QwenCloud quota request timed out.");
    case "invalid-response":
    case "invalid-amount":
    case "invalid-reset":
    case "body-too-large": return fail("bad_response", "Invalid QwenCloud Individual quota response.");
    default: return fail("provider_error", "QwenCloud Individual quota read failed.");
  }
}

function diagnosticFailure(code: DiagnosticCode | undefined): ProviderFetchResult {
  switch (code) {
    case "unauthorized":
      return failure(
        "login_expired",
        "Alibaba console login required; run bl auth login --console.",
      );
    case "cli-not-found":
      return failure("local_tool", "Alibaba Cloud CLI not found on the trusted PATH.");
    case "cli-unsupported":
      return failure("local_tool", "Alibaba Cloud CLI is not supported on this platform.");
    case "timeout":
      return failure("timeout", "QwenCloud quota request timed out.");
    case "missing-balance":
      return failure("no_data", "Alibaba console returned no personal quota data.");
    case "invalid-response":
    case "invalid-amount":
    case "invalid-reset":
    case "body-too-large":
      return failure("bad_response", "Invalid Alibaba console quota response.");
    default:
      return failure("local_tool", "Alibaba Cloud CLI quota read failed.");
  }
}

export const qwenCloudProvider: QuotaProvider = {
  id: "qwencloud",
  cachePolicy: { kind: "uncached" },
  async isAvailable(ctx) {
    if (!ctx.readQwenCloudQuota) return false;
    try {
      return (await ctx.resolveRuntimeProviderIds()).has("qwencloud");
    } catch {
      return false;
    }
  },
  matchesCurrentModel: (model) => modelProviderMatchesRuntimeId(model, "qwencloud"),
  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const selected = ctx.config.currentProviderID;
    const read = ctx.readQwenCloudQuota;
    if (
      (selected && selected !== "qwencloud") ||
      (!selected &&
        ctx.config.currentModel?.includes("/") &&
        !modelProviderMatchesRuntimeId(ctx.config.currentModel, "qwencloud"))
    )
      return { attempted: false, skipped: true, accounts: [], debug: [] };
    if (!read || !(await qwenCloudProvider.isAvailable(ctx)))
      return { attempted: false, accounts: [], debug: [] };
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Quota timeout"));
        }, ctx.config.requestTimeoutMs ?? 12_000);
      });
      const value = await Promise.race([read(controller.signal), expired]);
      let quota: NativeQuota;
      try {
        quota = decodeQuota(value);
      } catch {
        return failure("bad_response", "Invalid QwenCloud native quota response.");
      }
      const api = quota.source === INDIVIDUAL_API;
      if (quota.state !== "ready")
        return api ? individualFailure(quota) : quota.state === "unknown"
          ? failure("no_data", "Alibaba console returned no personal quota data.")
          : diagnosticFailure(quota.codes[0] as DiagnosticCode | undefined);
      return {
        attempted: true,
        accounts: [
          {
            name: api ? MANAGEMENT_ACCOUNT : ACCOUNT,
            errors: [],
            rows: quota.windows.map((window) => ({
              key: "personal.monthly",
              label: "Monthly",
              type: "quota",
              method: api ? "remote_api" : "local_cli",
              authority: "provider_reported",
              prominence: "primary",
              window: "month",
              percentRemaining: 100 - window.usedFraction * 100,
              ...(window.resetAt ? { resetsAt: window.resetAt } : {}),
            })),
          },
        ],
        debug: [
          { key: "source", value: quota.source },
          ...(api ? [] : [{ key: "account_binding", value: "unverified" }]),
        ],
      };
    } catch {
      return controller.signal.aborted
        ? failure("timeout", "QwenCloud quota request timed out.")
        : failure("provider_error", "QwenCloud native quota RPC unavailable.");
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  },
};
