# QwenCloud native quota

The built-in `qwencloud` quota provider reads the `qwencloud.quota` RPC exposed by
`opencode-qwencloud-oauth`. Both plugins must run in the same OpenCode location.
It requires no HTTP bridge, extra service, bearer token or custom quota definition.

Only the native OpenCode provider ID `qwencloud` matches. This does not match Qwen
models accessed through OpenRouter or Alibaba's other provider IDs. Availability
and startup do not call the quota RPC. A request for quota invokes it; a request
whose selected provider is not QwenCloud does not.

Set `quotaSource: "individual-api"` in the OAuth plugin options and sign in to
QwenCloud management OAuth in OpenCode. Leave the quota bridge disabled. The
monthly row uses `remote_api` and requires neither CLI. The quota belongs to the
management connection; it does not establish ownership of the inference key.
See the [OAuth plugin quota guide](https://github.com/leandromqrs/opencode-qwencloud-oauth/blob/main/docs/quota.md).

Without that option, the same RPC can still report the monthly percentage from
the Alibaba console CLI as `local_cli`. Its account is unverified against both
the management login and the inference key. The provider rejects team balances
and invalid percentages or reset times. It does not infer credit totals or model
entitlement, and failed reads never become zero usage.
