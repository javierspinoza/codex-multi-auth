# Legacy model reference review — 2026-10-06

GPT-5.2 references in the current source serve several purposes. The literal
`gpt-5.2` in a diagnostic's prompt-family field does not identify the model
requested for inference.

| Reference | Location | Purpose and decision |
| --- | --- | --- |
| `promptFamily: "gpt-5.2"` | `lib/request/helpers/model-map.ts`, `scripts/codex.js` | Shared instruction family and account/quota bucket for GPT-5.6 and GPT-6. Retained because the family is also persisted in account storage. |
| `gpt_5_2_prompt.md`, `gpt-5.2-instructions.md` | `lib/prompts/codex.ts` | Upstream instruction-template filename and local cache filename. Retained; renaming these would change fetching and caching rather than select Luna. |
| `gpt-5.2`, `gpt-5.2-chat-latest`, `gpt-5.2-codex` | `lib/request/helpers/model-map.ts`, `scripts/codex.js` | Accepted legacy aliases that resolve to `gpt-5.6-sol`; `gpt-5.2-pro` resolves to `gpt-6-astra`. Retained to preserve existing configurations and workload tiers. |
| `fallbackToGpt52OnUnsupportedGpt53` | `lib/config.ts`, `lib/schemas.ts`, `lib/request/error-classification.ts`, `index.ts`, `config/schema/config.schema.json` | Compatibility setting for the retired GPT-5.3 → GPT-5.2 Codex fallback. The built-in fallback chain no longer uses that edge; legacy custom chains can still name it. Retained as a public configuration key. |
| Legacy model literals in tests and release notes | `test/`, `docs/releases/`, `CHANGELOG.md` | Compatibility fixtures, regression cases, and historical release records. Retained. |
| `DEFAULT_PROBE_MODEL = "gpt-5.6-sol"` | `lib/request/helpers/model-map.ts` | Active default for account diagnostics and quota probes. Changed to `gpt-6-luna`. |
| `model: "openai/gpt-5.6-sol"` | `config/minimal-codex.json` | Active selection in the optional minimal debug template. Changed to `openai/gpt-6-luna`. |

The manager and runtime quota probes share `QUOTA_PROBE_MODEL_CHAIN`. Its new
order is `gpt-6-luna` → `gpt-5.6-sol` → `gpt-6.1-sol`, preserving the previous
Sol candidates for accounts that reject Luna. Manager commands with an explicit
`--model` continue to try that model first. Normal request routing still defaults
to `gpt-6.1-sol`.

The existing Luna model profile already supplies model normalization, reasoning,
and tool capabilities. Probes continue to use the lowest effort declared by
that Codex profile (`low`), `stream: true`, and `store: false`. No account-state
migration or endpoint change is required.

The [official GPT-6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)
confirms the `gpt-6-luna` identifier and Responses API support. The
[GPT-6 migration guide](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart)
supports preserving compatible reasoning settings and using Responses for
tools. These public API documents do not establish each OAuth account's Codex
entitlement; the preserved fallbacks handle model rejection.

Validation: 16 relevant Vitest suites passed (766 tests), covering both quota
probe implementations, both fallback candidates, explicit-model selection,
legacy aliases, prompt families, manager commands, and configuration templates.
Type checking, the build, and ESLint on changed TypeScript files also passed.
The request tests used mocked responses rather than live account probes.
