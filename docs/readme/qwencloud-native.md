# QwenCloud native quota

The built-in `qwencloud` quota provider reads the `qwencloud.quota` RPC exposed by
`opencode-qwencloud-oauth`. Both plugins must run in the same OpenCode location.
It requires no HTTP bridge, extra service, bearer token or custom quota definition.

Only the native OpenCode provider ID `qwencloud` matches. This does not match Qwen
models accessed through OpenRouter or Alibaba's other provider IDs. Availability
and startup do not call the quota RPC. A request for quota invokes it; a request
whose selected provider is not QwenCloud does not.

The monthly percentage is reported by the Alibaba console CLI. Its account is not
verified against the QwenCloud management OAuth login or inference API key. Rows
are labeled `Alibaba console (account unverified)`, use the `local_cli` method and
are not persisted under either identity. Refreshing a session for another provider
skips the QwenCloud read without replacing its prior result or timestamps with a
missing-setup error. The provider rejects management/BSS
responses, team balances, invalid percentages and invalid reset timestamps. It
does not infer credits, subscription status or model entitlement. Missing quota
and failed reads remain errors rather than becoming zero usage.

## Use this source checkout

This checkout is based on upstream tag `v6.2.0`, matching the installed consumer.
Build the package with `pnpm run build`. After explicitly approving the plugin
selection change, replace the existing quota plugin package entry with the local
directory `file:///var/home/leandromqrs/Projects/My/opencode-quota` in the applicable
OpenCode configuration. Keep the QwenCloud plugin and all unrelated entries.
Do not load both copies of the quota plugin.

OpenCode's documented local-directory loading uses this package's existing `name`
and `exports` for the server, TUI and GUI; no package rename is needed. Source
tests do not establish that the running host has selected this build. Verify the
QwenCloud row in the actual panel after selection. Until then, the installed npm
consumer is unchanged.

## Local activation evidence

The user approved selecting this checkout globally after a configuration backup.
The previous local package's Codex customization was preserved in source. Final
validation passed typecheck, build and 3,952 tests, with two existing skips.
A sessionless targeted refresh through the running quota RPC returned provider
`qwencloud`, method `local_cli`, remaining percentage `42.84204072406666` and reset
`2026-11-14T16:00:00.000Z`. This verifies panel snapshot ingestion, not client-side
visual rendering. No listener, adapter service or custom remote definition was
installed. These local changes have not been published upstream.
