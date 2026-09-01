# AgentConnect documentation

This directory holds the guides and design documents for the whole system. This
page is the index: every document is listed exactly once, under its primary
area, with one line on what it covers — implementation status and ownership live
in each document's own header. When a document spans two areas, follow the
cross-references inside it.

## Guides

- [product-conventions.md](product-conventions.md) — User-facing product behavior every implementation must preserve.
- [config-file-secrets.md](config-file-secrets.md) — The `*_DATA` secret convention for file-shaped credentials (Docker config, kubeconfig).
- [self-host-caddy-https.md](self-host-caddy-https.md) — Publishing a self-hosted stack behind Caddy HTTPS.
- [self-managed-gitlab.md](self-managed-gitlab.md) — Connecting a deployment to a self-managed GitLab instance.

## Designs

The authoritative designs live in [`designs/`](designs/). Start with
[architecture.md](designs/architecture.md); everything else details one part of
the picture it draws.

### Core architecture

- [architecture.md](designs/architecture.md) — The anchor: bridging messaging platforms to agent execution, the CP-off-the-hot-path invariant, and the deployment shapes.
- [system-detailed-design.md](designs/system-detailed-design.md) — Components, technology choices, and the interfaces between them.
- [daemon-detailed-design.md](designs/daemon-detailed-design.md) — The daemon: CLI, configuration, lifecycle, platform integration, CP interaction.
- [control-plane-implementation.md](designs/control-plane-implementation.md) — The Control Plane: composition root, persistence, and the HTTP/WS edges.
- [cli-daemon-split.md](designs/cli-daemon-split.md) — Why `agentconnect` and `agentconnect-daemon` are separate bins, and the contract between them.
- [daemon-cp-ws-protocol.md](designs/daemon-cp-ws-protocol.md) — The daemon ↔ CP WebSocket wire specification.
- [api-versioning.md](designs/api-versioning.md) — The REST `/api/v1` versioning policy.
- [high-availability.md](designs/high-availability.md) — HA design principles and the graceful-degradation contract.

### Chat platforms and ingress

- [integration-plugin-architecture.md](designs/integration-plugin-architecture.md) — The per-host platform-module seam: contracts, registries, and the shared manifest.
- [shared-bot-relay.md](designs/shared-bot-relay.md) — Shared bots and the unified inbound relay.
- [ingress-tenant-fence.md](designs/ingress-tenant-fence.md) — Fencing inbound deliveries to the owning tenant.
- [slack-integration-install.md](designs/slack-integration-install.md) — Slack installation and credential distribution.
- [slack-install-smoothing.md](designs/slack-install-smoothing.md) — The streamlined Slack install flow.
- [slack-identity.md](designs/slack-identity.md) — Slack accounts as a sign-in method, and the one rule for reading that identity.
- [slack-approval-dm.md](designs/slack-approval-dm.md) — DM-ing a linked agent editor to decide a pending approval from Slack.
- [slack-streaming-turn-output.md](designs/slack-streaming-turn-output.md) — Streaming a Slack turn's tool-call chrome over one native card stream.
- [feishu-integration.md](designs/feishu-integration.md) — The Lark / Feishu integration, international and CN variants.

### Webchat and console

- [webchat-multi-agents.md](designs/webchat-multi-agents.md) — Multi-agent webchat conversations: roster, primary agent, activation.
- [webchat-side-panels.md](designs/webchat-side-panels.md) — The session-detail right dock.
- [webchat-cross-integration-continuation.md](designs/webchat-cross-integration-continuation.md) — Continuing other integrations' sessions from webchat.
- [webchat-preset-agentconnect-mcp.md](designs/webchat-preset-agentconnect-mcp.md) — The preset AgentConnect MCP for webchat sessions.
- [merged-conversation-view.md](designs/merged-conversation-view.md) — One merged transcript across a conversation's sessions.
- [icon-uploads.md](designs/icon-uploads.md) — Agent and organization icon upload, storage, and serving.

### Code hosts and triggers

- [webhook-triggers-and-github-events.md](designs/webhook-triggers-and-github-events.md) — General webhook triggers: mapping one inbound delivery to one agent turn.
- [github-app-git-credentials.md](designs/github-app-git-credentials.md) — GitHub App repository selection and credential-free git on daemons.
- [github-pr-review-checks.md](designs/github-pr-review-checks.md) — Formal GitHub PR reviews and durable informational Checks.
- [gitlab-com-integration.md](designs/gitlab-com-integration.md) — The GitLab integration end to end.
- [linear-integration.md](designs/linear-integration.md) — The Linear integration.
- [git-workspace-model.md](designs/git-workspace-model.md) — The host-neutral git workspace contract.
- [multi-repository-workspaces.md](designs/multi-repository-workspaces.md) — Secondary workspace roots and cross-repository review.
- [agent-multi-repo-authorization.md](designs/agent-multi-repo-authorization.md) — Explicit multi-repository allowlists, per-repository minting, and the `gh` wrapper.

### Sessions and messaging

- [session-concept.md](designs/session-concept.md) — What a session is.
- [send-message-routing-rework.md](designs/send-message-routing-rework.md) — The `sendMessage` routing ladder.
- [activation-parity.md](designs/activation-parity.md) — Consistent activation semantics across surfaces.
- [turn-final-context-refresh.md](designs/turn-final-context-refresh.md) — Turn-final context refresh and answer regeneration on IM turns.
- [transcript-full-tool-body.md](designs/transcript-full-tool-body.md) — Complete tool-call bodies in transcripts.
- [agent-authored-attachments.md](designs/agent-authored-attachments.md) — Outbound agent-authored files across platforms.
- [inbound-file-attachments.md](designs/inbound-file-attachments.md) — Inbound user files: the workspace landing zone and the web-console upload.

### Authorization, identity, and visibility

- [authorization-policy.md](designs/authorization-policy.md) — The OSS authorization policy.
- [resource-visibility.md](designs/resource-visibility.md) — Resource visibility and sharing: the org/restricted model.
- [session-visibility.md](designs/session-visibility.md) — Session visibility and conversation audiences.
- [directional-agent-visibility.md](designs/directional-agent-visibility.md) — Directional visibility between agents.
- [session-access-cold-visit.md](designs/session-access-cold-visit.md) — Session access for the infrequent visitor.
- [daemon-api-key-auth.md](designs/daemon-api-key-auth.md) — Daemon API-key authentication.
- [org-scoped-data-layer.md](designs/org-scoped-data-layer.md) — The org-scoped persistence convention.

### Secrets and credentials

- [secret-store-seams.md](designs/secret-store-seams.md) — Secret-store interfaces and the shared `SecretCipher`.
- [per-org-secret-encryption.md](designs/per-org-secret-encryption.md) — Per-org key derivation and crypto-shredding.
- [organization-secrets-and-variables.md](designs/organization-secrets-and-variables.md) — Organization-level secrets, variables, and environments.
- [key-server.md](designs/key-server.md) — Dynamic provider-credential issuance for cloud daemons.

### Agents and collaboration

- [agents-collaboration-design.md](designs/agents-collaboration-design.md) — The product vision for agent-to-agent collaboration.
- [agent-collaboration-implementation.md](designs/agent-collaboration-implementation.md) — The collaboration mechanics: agent-to-agent delivery and orchestration.
- [loop-breaker-design.md](designs/loop-breaker-design.md) — Feedback-loop protection for platform messages and collaboration.
- [collaboration-arena.md](designs/collaboration-arena.md) — The collaboration arena.
- [collaboration-arena-baseline.md](designs/collaboration-arena-baseline.md) — The arena's measured baseline.
- [agent-reachability-graph.md](designs/agent-reachability-graph.md) — Which agents can reach which: the reachability graph.
- [preset-agents.md](designs/preset-agents.md) — Preset agents and guided onboarding.
- [agent-assistant.md](designs/agent-assistant.md) — The AgentConnect MCP: system operations for AI tools.
- [agent-capability-benchmark-harness.md](designs/agent-capability-benchmark-harness.md) — Add-on evaluation and harness neutrality.

### Memory, knowledge, and tools

- [memory-system-plan.md](designs/memory-system-plan.md) — The managed memory system.
- [memory-evolution.md](designs/memory-evolution.md) — `MemoryProvider` and external memory plugins.
- [memory-dreaming.md](designs/memory-dreaming.md) — Offline memory consolidation ("dreaming").
- [organization-knowledge.md](designs/organization-knowledge.md) — Organization knowledge bundles and dream suggestions.
- [shared-skills.md](designs/shared-skills.md) — One isolated `skills` CLI for git and local skill sources.
- [centralized-tool-management.md](designs/centralized-tool-management.md) — Centralized tool management: the relay-data-plane MCP proxy.

### Runtimes and fleet

- [k8s-daemon-pool.md](designs/k8s-daemon-pool.md) — Multi-org cloud daemons and the duty ledger.
- [cluster-spawn-and-shim.md](designs/cluster-spawn-and-shim.md) — Running ACP runtimes in sandbox pods, and the in-sandbox shim.
- [cloud-data-plane-postgres.md](designs/cloud-data-plane-postgres.md) — PostgreSQL as the cloud daemon's durable store.
- [daemon-groups.md](designs/daemon-groups.md) — Daemon groups and agent placement.
- [background-task-aware-reclaim.md](designs/background-task-aware-reclaim.md) — ACP host reclamation that respects background jobs.
- [runtime-model-catalog.md](designs/runtime-model-catalog.md) — Runtime model discovery, per-model fallback, and local caching.

## Working papers

[`superpowers/`](superpowers/) holds point-in-time implementation plans and
specs produced during development. They record how a change was executed, are
not kept current, and never override the designs above.
