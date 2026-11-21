import { Rpc } from "@opencode/plugin/rpc";

export const QwenCloudQuotaRpc = Rpc.define({
  id: "qwencloud",
  methods: {
    quota: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {},
});

export type QwenCloudQuotaReader = (signal: AbortSignal) => Promise<unknown>;
