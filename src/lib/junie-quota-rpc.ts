import { Rpc } from "@opencode/plugin/rpc";

export const JunieQuotaRpc = Rpc.define({
  id: "jetbrains.quota",
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
});

export type JunieQuotaReader = (signal: AbortSignal) => Promise<unknown>;
