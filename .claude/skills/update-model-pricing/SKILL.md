---
name: update-model-pricing
description: Verify and refresh AgentConnect's daemon-side public OpenAI fallback pricing, exact model aliases, long-context and cache rules, and regression tests. Use when OpenAI model prices or IDs change, fallback cost becomes missing or stale, codex-acp changes its token mapping, or someone asks to audit or update packages/daemon/src/usage/openai-public-pricing.ts.
---

# Update Model Pricing

Keep the daemon's offline cost fallback aligned with current public OpenAI Standard API pricing and the codex-acp version selected by AgentConnect's runtime registry or an explicit runtime override.

## Workflow

1. Read `packages/daemon/src/usage/openai-public-pricing.ts`, its focused test, and `packages/daemon/src/runtimes/registry.ts`. Resolve the effective codex-acp package/version from the current ACP registry entry or the deployment's explicit runtime command/args; it is not pinned in `pnpm-lock.yaml`.
2. Read [references/pricing-sources.md](references/pricing-sources.md) and fetch the current official sources. Do not rely on remembered prices or third-party tables.
3. Re-check the resolved codex-acp tag's `TokenCount` mapping and compare it with upstream main before changing the formula. Confirm whether ACP input, cache-read, cache-write, output, and thought fields are disjoint and whether PromptResponse usage is per-turn.
4. Update the manifest with exact published model IDs, prices, dated snapshots, thresholds, and the verification date. Cover text/reasoning models that codex-acp advertises or AgentConnect explicitly supports; do not broaden the manifest to unrelated OpenAI products. Keep unknown models unsupported; never infer a price by prefix or strip an unlisted date suffix.
5. Update tests in the same patch. Cover every alias, the exact long-context boundary, cache behavior, unknown models, malformed usage, and reasoning non-duplication.
6. Run the focused daemon tests, daemon typecheck, and formatting check. Review the final diff for unrelated product or telemetry changes.

## Repository Rules

- Price Standard API tokens in USD per one million tokens. Do not branch on ChatGPT subscription versus API-key authentication.
- Prefer an ACP-provided cost for a turn. Run fallback calculation only when that turn reports no cost.
- Keep cost display unchanged. Do not add estimated labels, approximation glyphs, or CP/Web schema fields unless explicitly requested.
- Calculate each Codex turn with the model selected for that session at turn start; do not reprice a whole session using its final model.
- Treat output tokens as already including reasoning tokens. Never add thought tokens a second time.
- Apply a long-context tier only when the public table publishes one and request input is strictly above its documented threshold.
- Keep runtime pricing offline and deterministic. Never fetch prices from the daemon at runtime.
- Preserve historical stored amounts; a price refresh affects only future fallback turns.

## Validation

Run:

```bash
pnpm --filter @agentconnect.md/daemon exec vitest run test/openai-public-pricing.test.ts test/local-store.test.ts test/daemon-webchat.test.ts test/acp-host.test.ts
pnpm --filter @agentconnect.md/daemon typecheck
pnpm format:check
```

If codex-acp's usage mapping changed, add a regression that demonstrates the new upstream shape before modifying the fold or cost formula.
