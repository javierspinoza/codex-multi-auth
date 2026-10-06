# Local session storage and network review

Date: 2026-10-06. Package: codex-multi-auth 2.19.1. Repository base: cedbec02, with the local browser-login URL change.

## Conclusion and scope

No automatic upload or remote backup of the saved session JSONL files or account-pool JSON was found in the reviewed first-party account manager, wrapper, runtime proxy, local bridge, prompt fetchers, update checker, or local interop code. This is a source inspection with focused tests, not a network capture or a proof that every executable or dependency on the machine is free of unwanted network behavior.

The program is networked: inference sends the request body, including messages and conversation context, to OpenAI by default. OAuth authentication and refresh send the required credentials to OpenAI. A local transcript and a stateless inference request do not establish zero retention by the upstream provider.

The installed package was compared with the corresponding generated runtime, scripts, and vendor files in the workspace: 715 shared files matched by SHA-256, with no differing shared files. This comparison does not audit the implementation of every third-party dependency or the official Codex binary.

## Local storage evidence

- `lib/runtime-paths.ts`: `getCodexHomeDir()` uses `CODEX_HOME`, otherwise `~/.codex`; `getCodexMultiAuthDir()` resolves the separate account-manager root.
- `lib/codex-manager/commands/history.ts`: reads `<codex-home>/sessions/rollout-*.jsonl` recursively with filesystem APIs and writes the results to the terminal. No network call in this module.
- `scripts/codex.js`: `mirrorDirectoryIntoShadowHome()` uses a local directory link or local copy; `syncCopiedShadowHomeDirectories()` copies back to the original local home.
- `lib/oc-chatgpt-orchestrator.ts`: optional interop sync writes local files and exports local named backups, rather than sending them to a remote service.
- `lib/usage/types.ts` and `lib/usage/redaction.ts`: usage rows contain counters and request metadata; account/email identifiers are hashed. The row schema has no prompt or transcript field.
- `lib/logger.ts`: optional request body logging writes diagnostic files; in plugin-host mode it also delegates sanitized log messages to the host's `app.log` API. The host's own data handling is outside this review.

Filesystem metadata inspection confirmed a session directory and account pool under the default home on this machine. The account pool and official auth file had mode 0600. Alternate account homes also have their own session directories. Credential values and conversation contents were not read for this metadata inspection.

## Network destinations and payloads

| Destination | Purpose and payload |
| --- | --- |
| `auth.openai.com` | OAuth/browser/device login and token exchange/refresh; authorization credentials needed for authentication |
| `chatgpt.com/backend-api` | Account/workspace checks, quota and capability probes, inference and supported model/image/thread-goal traffic; selected account bearer token and inference request body |
| `api.openai.com` | Optional API-key model discovery, probes and inference; API key and request payload |
| `developers.openai.com` | Optional API model capability documentation lookup |
| `api.github.com`, `github.com`, `raw.githubusercontent.com` | Downloads of releases and prompt templates, with HTTP metadata/ETag headers |
| `registry.npmjs.org/codex-multi-auth/latest` | Version metadata lookup; GET with an Accept header, no account-pool or transcript payload |
| Numeric loopback | OAuth callback, rotation proxy, app router, bridge, and explicitly configured development upstream |

Evidence: `lib/constants.ts`, `lib/auth/auth.ts`, `lib/auth/device-auth.ts`, `lib/auth/account-access.ts`, `lib/quota-probe.ts`, `lib/runtime/api-model-runtime.ts`, `lib/runtime/api-model-capabilities.ts`, `lib/prompts/codex.ts`, `lib/prompts/host-codex-prompt.ts`, `lib/prompts/fetch-utils.ts`, and `lib/update-notice.ts`.

## Routing boundaries and limitations

- The default rotation upstream is the ChatGPT backend. The forwarded POST body is the incoming inference body, not a read of the account JSON or an inventory of saved transcripts (`lib/runtime-rotation-proxy.ts`).
- The wrapper environment override `CODEX_MULTI_AUTH_RUNTIME_PROXY_UPSTREAM_BASE_URL` accepts only numeric-loopback HTTP with an explicit port (`scripts/codex.js`). A local upstream process may itself forward elsewhere; its behavior is outside this project's validation.
- The library `upstreamBaseUrl` option allows other HTTPS destinations. It does not restrict every library caller to OpenAI domains. A caller choosing such a destination controls where the selected bearer token and inference payload go.
- The rotation proxy rejects redirects; its WebSocket transport disables redirect following. This prevents those inference paths from automatically forwarding bearer credentials to redirect targets. This finding does not assert that every other fetch path in the package rejects redirects.
- The bridge validates a loopback upstream and requires local client authentication by default.
- No project-owned analytics service or automatic session-upload implementation was found. The official Codex CLI, third-party dependencies, MCP servers, plugins, cloud commands, proxies, and any OS cloud-folder synchronization are separate behavior.
- Official documentation says Codex sends usage/health metrics by default and supports disabling them with `[analytics] enabled = false`. The inspected Codex configs did not explicitly set this flag. This does not establish what traffic an already-running process has sent.

## Validation

Passed 33 tests:

```bash
npm test -- test/codex-manager-history-command.test.ts test/usage-redaction.test.ts
```

Passed 43 selected proxy/bridge tests (234 other tests excluded by the name filter):

```bash
npm test -- test/runtime-rotation-proxy.test.ts test/local-bridge.test.ts -t 'redirect|upstreamBaseUrl|loopback|bearer|unauthenticated|non-loopback|client token|client API key'
```

Proxy/bridge validation used localhost servers and test credentials. The initial unfiltered proxy run inside the restricted sandbox was interrupted when it did not finish promptly; the relevant network-boundary tests were rerun with localhost access. No live account login or real inference request was needed for these tests.

Official references: [Codex state locations and metrics](https://learn.chatgpt.com/docs/config-file/config-advanced), [Codex CLI including cloud and MCP commands](https://learn.chatgpt.com/docs/codex/cli).
