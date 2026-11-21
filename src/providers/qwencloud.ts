import type { QuotaErrorCode } from "../core/types.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { readQuotaRpc } from "../lib/read-quota-rpc.js";
import { failedAccount, type ProviderFetchResult } from "./contract.js";

const ACCOUNT = "Alibaba console (account unverified)";
const MANAGEMENT_ACCOUNT = "QwenCloud management account";
const INDIVIDUAL_API = "qwencloud-individual-api";
const CONSOLE_CLI = "alibaba-console-cli";
const CLI_CODES = [
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
const API_CODES = [
  "invalid-credentials",
  "session-expired",
  "credentials-unavailable",
  "account-changed",
  "cancelled",
  "timeout",
  "unauthorized",
  "rate-limited",
  "http-error",
  "network-error",
  "body-too-large",
  "invalid-response",
  "business-error",
  "invalid-amount",
  "invalid-reset",
  "missing-balance",
] as const;
type DiagnosticCode = (typeof CLI_CODES)[number] | (typeof API_CODES)[number];
type PersonalWindow = { usedFraction: number; resetAt?: string };
type QuotaSource = typeof CONSOLE_CLI | typeof INDIVIDUAL_API;
type NativeQuota = { source: QuotaSource } & (
  | { state: "ready"; window: PersonalWindow }
  | { state: "unknown" }
  | { state: "disconnected" }
  | { state: "error"; code: DiagnosticCode }
);

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

function decodeDiagnostic(value: unknown, source: QuotaSource): DiagnosticCode {
  const { action, code } = record(value, ["action", "code"]);
  const allowedCodes = source === INDIVIDUAL_API ? API_CODES : CLI_CODES;
  const allowedAction =
    source === INDIVIDUAL_API
      ? action === "quota" ||
        action === "GenerateCLIAccessToken" ||
        action === "IndividualTokenPlanUsage"
      : action === "AlibabaTokenPlanUsage";
  const matched = allowedCodes.find((candidate) => candidate === code);
  if (!allowedAction || !matched) throw new Error("Invalid native quota diagnostic");
  return matched;
}

function decodeWindow(value: unknown): PersonalWindow {
  const window = record(value, ["period", "scope", "usedFraction", "resetAt"]);
  const { period, scope, usedFraction, resetAt } = window;
  if (
    period !== "monthly" ||
    scope !== "personal" ||
    typeof usedFraction !== "number" ||
    !Number.isFinite(usedFraction) ||
    usedFraction < 0 ||
    usedFraction > 1 ||
    ("resetAt" in window && !isTime(resetAt))
  )
    throw new Error("Invalid native quota window");
  return { usedFraction, ...(typeof resetAt === "string" ? { resetAt } : {}) };
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
  const { source, state, balances, diagnostics, personalWindows } = data;
  if (source !== INDIVIDUAL_API && source !== CONSOLE_CLI)
    throw new Error("Invalid native quota source");
  if (
    (source === INDIVIDUAL_API ? "accountBinding" in data : data.accountBinding !== "unverified") ||
    !isTime(data.observedAt) ||
    !Array.isArray(balances) ||
    balances.length !== 0 ||
    !Array.isArray(diagnostics) ||
    diagnostics.length > 32
  )
    throw new Error("Invalid native quota response");
  const codes = diagnostics.map((diagnostic: unknown) => decodeDiagnostic(diagnostic, source));
  const windows = "personalWindows" in data ? personalWindows : [];
  if (!Array.isArray(windows) || windows.length > 1)
    throw new Error("Invalid native quota windows");
  if (state === "ready" && windows.length === 1 && codes.length === 0)
    return { source, state, window: decodeWindow(windows[0]) };
  if (windows.length === 0) {
    if (state === "unknown") return { source, state };
    if (state === "error" && codes[0]) return { source, state, code: codes[0] };
    if (state === "disconnected" && source === INDIVIDUAL_API && codes.length === 0)
      return { source, state };
  }
  throw new Error("Inconsistent native quota state");
}

function failure(code: QuotaErrorCode, message: string, account = ACCOUNT): ProviderFetchResult {
  return { attempted: true, accounts: [failedAccount(account, message, { code })], debug: [] };
}

function individualFailure(quota: Exclude<NativeQuota, { state: "ready" }>): ProviderFetchResult {
  const fail = (code: QuotaErrorCode, message: string) =>
    failure(code, message, MANAGEMENT_ACCOUNT);
  if (quota.state === "disconnected")
    return fail("not_configured", "Connect QwenCloud management OAuth in OpenCode.");
  if (quota.state === "unknown")
    return fail("no_data", "QwenCloud returned no monthly Individual Token Plan data.");
  switch (quota.code) {
    case "session-expired":
    case "unauthorized":
      return fail("login_expired", "Sign in to QwenCloud in OpenCode again.");
    case "invalid-credentials":
    case "credentials-unavailable":
      return fail("not_configured", "QwenCloud management credentials are unavailable.");
    case "timeout":
      return fail("timeout", "QwenCloud quota request timed out.");
    case "invalid-response":
    case "invalid-amount":
    case "invalid-reset":
    case "body-too-large":
      return fail("bad_response", "Invalid QwenCloud Individual quota response.");
    default:
      return fail("provider_error", "QwenCloud Individual quota read failed.");
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
    const response = await readQuotaRpc(read, ctx.config.requestTimeoutMs);
    switch (response.kind) {
      case "timeout":
        return failure("timeout", "QwenCloud quota request timed out.");
      case "unavailable":
        return failure("provider_error", "QwenCloud native quota RPC unavailable.");
    }
    let quota: NativeQuota;
    try {
      quota = decodeQuota(response.value);
    } catch {
      return failure("bad_response", "Invalid QwenCloud native quota response.");
    }
    const api = quota.source === INDIVIDUAL_API;
    if (quota.state !== "ready") {
      if (api) return individualFailure(quota);
      if (quota.state === "unknown")
        return failure("no_data", "Alibaba console returned no personal quota data.");
      return diagnosticFailure(quota.state === "error" ? quota.code : undefined);
    }
    const { window } = quota;
    return {
      attempted: true,
      accounts: [
        {
          name: api ? MANAGEMENT_ACCOUNT : ACCOUNT,
          errors: [],
          rows: [
            {
              key: "personal.monthly",
              label: "Monthly",
              type: "quota",
              method: api ? "remote_api" : "local_cli",
              authority: "provider_reported",
              prominence: "primary",
              window: "month",
              percentRemaining: 100 - window.usedFraction * 100,
              ...(window.resetAt ? { resetsAt: window.resetAt } : {}),
            },
          ],
        },
      ],
      debug: [
        { key: "source", value: quota.source },
        ...(api ? [] : [{ key: "account_binding", value: "unverified" }]),
      ],
    };
  },
};
