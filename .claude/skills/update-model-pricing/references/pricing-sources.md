# Pricing sources

Use primary sources only and record the access date in the pricing module.

## OpenAI

- Standard, long-context, and specialized model rates: <https://developers.openai.com/api/docs/pricing>
- Prompt cache reads and cache-write billing: <https://developers.openai.com/api/docs/guides/prompt-caching>
- Reasoning-token billing semantics: <https://developers.openai.com/api/docs/guides/reasoning#how-reasoning-works>
- Model IDs, snapshots, aliases, and per-model caveats: follow the model links from the pricing page under `https://developers.openai.com/api/docs/models/`.

Do not copy Batch, Flex, Priority, regional, subscription-credit, tool-call, or container prices into the Standard token fallback.

## Gemini (Antigravity)

- Standard paid-tier rates, dated price changes, and cache rules: <https://aistudio.google.com/docs/pricing>

Price only the exact Gemini API model ids Antigravity selects through its `model` config option (`gemini-4-neon`, not `gemini-4-neon-high`). Record each dated price change as a rate period instead of waiting to edit it on the day. Leave Antigravity's non-Google models and its orchestrator ids unsupported: Google's table does not price them. Do not copy Batch, Flex, Priority, Contributor, or free-tier prices.

## Antigravity ACP

As of `agy acp` 1.5.13, PromptResponse usage is the sum over every model request in the prompt, with disjoint `inputTokens` (non-cached), `cachedReadTokens`, and `outputTokens` buckets; `thoughtTokens` is a subset of output, and `usage_update` carries no `cost`. Re-probe with a two-tool-call prompt after an upgrade: the summed `totalTokens` should exceed the final `usage_update.used`.

## codex-acp

- Current token mapping: <https://github.com/agentclientprotocol/codex-acp/blob/main/src/TokenCount.ts>
- Current prompt response assembly: <https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexAcpServer.ts>
- ACP usage semantics RFD: <https://agentclientprotocol.com/rfds/session-usage>

AgentConnect does not pin codex-acp in the workspace lockfile. Resolve the effective version from the `codex-acp` entry in the ACP registry/cache described by `packages/daemon/src/runtimes/registry.ts`, or from an explicit runtime override, then inspect that upstream tag as well as main. As of codex-acp v1.1.0, PromptResponse usage is per-turn; ACP `inputTokens` is non-cached input, `cachedReadTokens` is separate, and `outputTokens` already includes reasoning. These are versioned implementation facts, not safe assumptions for every ACP runtime.

## Review checklist

- Confirm every price dimension and long-context row against the official table.
- Register only exact official aliases and dated snapshots.
- Leave preview models without a published token rate unsupported.
- Verify that exactly 272,000 request-input tokens remain on the short tier when the rule is `>272K`.
- Confirm behavior when an adapter omits cache-write data.
- Confirm models without a cache discount use the normal input rate rather than zero.
