import type { Amount, QuotaErrorCode } from "../core/types.js";
import type { QuotaProvider } from "../lib/entries.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { readQuotaRpc } from "../lib/read-quota-rpc.js";
import { failedAccount, type ProviderFetchResult } from "./contract.js";

const ID = "jetbrains";
const LABEL = "Junie by Jetbrains";
const NO_ATTEMPT = { attempted: false, accounts: [], debug: [] };
const BALANCE = /^(0|[1-9]\d{0,15})(\.\d{2,6}) (credits|USD)$/u;

function decodeBalance(value: unknown): Amount | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("label" in value) ||
    value.label !== LABEL ||
    !("groups" in value) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 1
  )
    throw new Error("Invalid Junie quota snapshot");
  if (value.groups.length === 0) return undefined;
  const row: unknown = value.groups[0];
  if (
    !row ||
    typeof row !== "object" ||
    !("title" in row) ||
    row.title !== "Balance" ||
    !("value" in row) ||
    typeof row.value !== "string" ||
    row.value.length > 48
  )
    throw new Error("Invalid Junie balance row");
  const match = BALANCE.exec(row.value);
  if (!match || match[0] !== row.value) throw new Error("Invalid Junie balance row");
  return {
    decimal: `${match[1]}${match[2]}`,
    unit:
      match[3] === "USD" ? { kind: "currency", code: "USD" } : { kind: "count", unit: "credit" },
  };
}

function failure(code: QuotaErrorCode, message: string): ProviderFetchResult {
  return { attempted: true, accounts: [failedAccount(LABEL, message, { code })], debug: [] };
}

export const junieProvider: QuotaProvider = {
  id: ID,
  cachePolicy: { kind: "uncached", clearRowsOnError: true },
  async isAvailable(ctx) {
    if (!ctx.readJunieQuota) return false;
    try {
      return (await ctx.resolveRuntimeProviderIds()).has(ID);
    } catch {
      return false;
    }
  },
  matchesCurrentModel: (model) => modelProviderMatchesRuntimeId(model, ID),
  async fetch(ctx) {
    const read = ctx.readJunieQuota;
    if (!read || !(await junieProvider.isAvailable(ctx))) return NO_ATTEMPT;
    const response = await readQuotaRpc(read, ctx.config.requestTimeoutMs);
    switch (response.kind) {
      case "timeout":
        return failure("timeout", "Junie quota request timed out.");
      case "unavailable":
        return failure("provider_error", "Junie native quota RPC unavailable.");
    }
    let amount: Amount | undefined;
    try {
      amount = decodeBalance(response.value);
    } catch {
      return failure("bad_response", "Invalid Junie native quota response.");
    }
    if (!amount) return failure("no_data", "Junie did not report a balance.");
    return {
      attempted: true,
      accounts: [
        {
          name: LABEL,
          errors: [],
          rows: [
            {
              key: "balance",
              label: "Balance",
              type: "balance",
              method: "remote_api",
              authority: "provider_reported",
              prominence: "primary",
              amount,
            },
          ],
        },
      ],
      debug: [],
    };
  },
};
