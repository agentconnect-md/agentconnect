# Integration and ACP runtime capabilities

Integrations and runtimes are independent axes: an integration routes work to an
agent; the agent's selected ACP runtime executes it. A Slack, webhook, or other
integration does not require a particular runtime or model.

**Available** means AgentConnect has an implementation, subject to the selected
daemon, deployment configuration, and provider permissions. It is not a claim
that every adapter/provider combination has been live-tested. **Pending** means
not yet implemented or not yet verified, as qualified below. **Not integrated**
means AgentConnect has no dedicated integration for that control; it does not
mean the upstream runtime cannot do it itself.

## Integrations

The ingress owner receives the event or connection; execution and platform API
replies remain daemon-owned. Relay ingress is forwarded directly to the owning
daemon, not through the Control Plane. All rows below are **Available** in the
current implementation; deployment tiles are gated by daemon capabilities and
feature configuration.

| Platform or entry point | Conversations or events                           | Ingress owner                            | Public callback required | Shared bot or App behavior                                                        | Setup guide                                                                                                                                 |
| ----------------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack                   | Channels, threads, DMs                            | Daemon (Socket Mode) or Relay (HTTP)     | HTTP only                | Multiple agents per bot only with HTTP and Sharable enabled                       | [Slack](https://www.agentconnect.md/docs/connect-automate/chat-platforms/slack)                                                             |
| Telegram                | DMs, groups, forum topics                         | Daemon (long polling)                    | No                       | One agent per bot                                                                 | [Telegram](https://www.agentconnect.md/docs/connect-automate/chat-platforms/telegram)                                                       |
| Discord                 | Channels, threads, DMs                            | Daemon (Gateway)                         | No                       | One agent per bot                                                                 | [Discord](https://www.agentconnect.md/docs/connect-automate/chat-platforms/discord)                                                         |
| Lark / Feishu           | Group mentions, one-to-one chats                  | Daemon (long connection) or Relay (HTTP) | HTTP only                | One agent per bot in either mode                                                  | [Lark / Feishu](https://www.agentconnect.md/docs/connect-automate/chat-platforms/lark-feishu)                                               |
| Google Chat             | Space mentions, threads, DMs                      | Relay (HTTPS)                            | Yes                      | One agent per own app; deployment app serves built-in agents across organizations | [Google Chat](https://www.agentconnect.md/docs/connect-automate/chat-platforms/googlechat)                                                  |
| QQ                      | Group mentions, DMs                               | Daemon (WebSocket)                       | No                       | One agent per bot; no guild/channel ingress                                       | [QQ](https://www.agentconnect.md/docs/connect-automate/chat-platforms/qq)                                                                   |
| DingTalk                | Group mentions, DMs, quoted follow-ups            | Daemon (Stream)                          | No                       | One agent per internal app                                                        | [Console setup](designs/dingtalk-integration.md#5-console-setup), [implementation](../packages/daemon/src/platforms/dingtalk/connection.ts) |
| GitHub                  | Watched issue, PR, comment and review events      | Relay (webhooks)                         | Yes                      | Installed GitHub App identity; multiple agents may watch a repository             | [GitHub](https://www.agentconnect.md/docs/connect-automate/triggers-automation/github)                                                      |
| GitLab                  | Watched issue, MR, comment and review events      | Relay (webhooks)                         | Yes                      | A group service account per agent                                                 | [GitLab](https://www.agentconnect.md/docs/connect-automate/triggers-automation/gitlab)                                                      |
| Gitea / Forgejo         | Watched issue, PR, comment and review events      | Relay (webhooks)                         | Yes                      | One bot user/token per organization; repository webhook shared by triggers        | [Gitea](https://www.agentconnect.md/docs/connect-automate/triggers-automation/gitea)                                                        |
| Linear                  | Delegated issues, app mentions, follow-up prompts | Relay (webhooks)                         | Yes                      | Connected workspace shares one deployment OAuth app across enabled agents         | [Linear](https://www.agentconnect.md/docs/connect-automate/triggers-automation/linear)                                                      |
| Generic webhooks        | JSON deliveries mapped to agent turns             | Relay (HTTPS)                            | Yes (inbound endpoint)   | Endpoint/token per integration; no platform bot                                   | [Webhooks](https://www.agentconnect.md/docs/connect-automate/triggers-automation/webhooks)                                                  |
| Schedules               | Cron firings; optional integration output         | Daemon (local scheduler)                 | No                       | Uses the target integration identity, or runs headless                            | [Schedules](https://www.agentconnect.md/docs/connect-automate/triggers-automation/schedules)                                                |
| Playground              | Browser chat with an agent                        | Relay (webchat WebSocket)                | No provider callback     | Console identity; no external bot                                                 | [Playground](https://www.agentconnect.md/docs/build-your-team/agents/playground)                                                            |
| Agent chat API          | API-key chat turns; streamed replies              | Relay (HTTP streaming)                   | No provider callback     | Agent opts in; conversations scoped to key owner                                  | [Agent chat API](https://www.agentconnect.md/docs/connect-automate/agent-chat-api)                                                          |

A callback marked **Yes** needs a Relay endpoint reachable by the sender. For a
private code host this may be a private route rather than a public Internet
address. Playground and API clients also need to reach the Relay, but do not
register a provider callback. Schedules fire on the daemon, not the Relay; do not
rely on an offline daemon to run on time.

Cloud and OSS use the same ingress boundaries. Cloud supplies the public Relay
and built-in Slack installation; OSS operators must publish/connect a Relay for
HTTP delivery and configure deployment-owned provider apps where required.
Slack defaults to HTTP on Cloud and can use Socket Mode without a Relay. Lark /
Feishu defaults to a long connection on both; HTTP does not make its bot
multi-agent. Google Chat has no direct-daemon mode. DingTalk uses per-organization
internal apps on both, and messages sent while its Stream connection is offline
are not redelivered. Its linked design still has a draft header; the row describes
only the implemented Stream path, not the proposed third-party app distribution.

Sources for the delivery and identity boundaries:

- [Daemon platform registry](../packages/daemon/src/platforms/integration-config.ts),
  [wire configuration](../packages/protocol/src/frames/integration.ts),
  [sharing manifest](../packages/protocol/src/platform-manifest.ts), and
  [Relay platform registry](../packages/relay/src/platforms/registry.ts).
- [Relay entry points](../packages/relay/src/index.ts),
  [code-host ingress](../packages/relay/src/hooks/), and
  [shared-bot and webchat routing](designs/shared-bot-relay.md).

Microsoft Teams is **Pending**: its [design](designs/teams-integration.md) is a
draft, not an installed connector. A proposed transport in a design document is
not evidence of availability; use the registries above to distinguish implemented
paths from proposals.

## ACP runtimes

The **selected daemon's reported runtime profiles are the live source of truth**,
not this table or a historical test-results list. Install/sign in to the runtime
on that daemon, then use the agent's Runtime settings. Availability depends on
the launch definition, executable or sandbox image, credentials, and a successful
probe/admission. A registry entry alone does not prove that a runtime can launch.
See [daemon setup](https://www.agentconnect.md/docs/build-your-team/daemons/install-the-daemon)
and [agent configuration](https://www.agentconnect.md/docs/build-your-team/agents/configure-an-agent).

“Advertised controls” below means model, effort/reasoning, fast mode, and
permission mode **only where reported**. Exact options come from ACP probing and
the daemon's per-model `modelCatalog`, delivered through `facts/daemon-runtimes`
and read by the console through `GET /api/v1/daemons/:id`. Native catalog drivers
are discovery fast paths; generic ACP enumeration is the fallback. Missing
catalog data is not a promise of support. No model names, versions, or option
values are fixed by this page.

| Runtime or adapter       | Discovery and launch                              | AgentConnect-managed controls                                                   | MCP transports                                                        | Shared-login support                               | Runtime-native tool sandbox                         | Notes / source                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude (`claude-acp`)    | Available: registry + ACP probe                   | Advertised controls; Claude session metadata                                    | stdio; HTTP/SSE if reported                                           | Available on Linux                                 | Available: native Bash sandbox policy               | [Claude integration](../packages/daemon/src/runtime-defs/claude-runtime.ts), [ACP host](../packages/daemon/src/acp/acp-host.ts)                                                            |
| Codex (`codex-acp`)      | Available: managed adapter + ACP probe            | Advertised controls                                                             | stdio; HTTP/SSE if reported                                           | Available on Linux                                 | Available: daemon-owned permission profiles         | [Managed adapter](../packages/daemon/src/runtimes/managed.ts), [permission profiles](../packages/daemon/src/acp/codex-permission-profiles.ts)                                              |
| OpenCode / Kilo          | Available: registry + ACP probe                   | Advertised controls; native model catalog                                       | stdio; HTTP/SSE if reported; process-scoped server registration       | Not integrated (shared refresh)                    | Not integrated                                      | [Catalog drivers](../packages/daemon/src/runtimes/model-catalog.ts), [MCP scope](../packages/daemon/src/runtimes/session-mcp-servers.ts)                                                   |
| Gemini CLI (`gemini`)    | Available: registry + ACP probe                   | Advertised controls; model set at launch, API-key catalog; no live model switch | stdio; HTTP/SSE if reported                                           | Not integrated (shared refresh)                    | Not integrated                                      | [Catalog driver](../packages/daemon/src/runtimes/model-catalog.ts), [model environment](../packages/daemon/src/runtimes/model-env.ts)                                                      |
| Qoder CLI / Qoder CN CLI | Available: curated launcher + ACP admission       | Advertised controls                                                             | stdio; HTTP/SSE if reported                                           | Available on Linux                                 | Not integrated                                      | [Launchers](../packages/daemon/src/runtimes/curated.ts), [shared credentials](../packages/daemon/src/runtimes/runtime-credentials.ts)                                                      |
| Kimi Code (`kimi`)       | Available: registry + ACP probe                   | Advertised controls                                                             | stdio; HTTP/SSE if reported                                           | Available on Linux                                 | Not integrated                                      | [Registry resolution](../packages/daemon/src/runtimes/registry.ts), [shared credentials](../packages/daemon/src/runtimes/runtime-credentials.ts)                                           |
| OpenClaw                 | Available: curated ACP bridge to external Gateway | Advertised controls; execution belongs to Gateway                               | Not integrated: per-session MCP rejected                              | Not integrated (shared refresh)                    | Not integrated; bridge is not an execution boundary | [Launcher and explicit limitations](../packages/daemon/src/runtimes/curated.ts)                                                                                                            |
| Other ACP runtimes       | Pending verification until reported by the daemon | Advertised controls only; generic ACP discovery                                 | Pending verification; use reported capabilities and adapter overrides | Pending verification; do not assume shared refresh | Not integrated unless an explicit mapping is added  | [Registry](../packages/daemon/src/runtimes/registry.ts), [curated catalog](../packages/daemon/src/runtimes/curated.ts), [runtime facts](../packages/daemon/src/runtimes/facts-registry.ts) |

MCP transport choices are not static per-runtime promises. The daemon attaches
stdio definitions and filters HTTP/SSE servers against the runtime's probed MCP
capabilities; before a probe it may attempt them optimistically. Runtime overrides
can reject per-session MCP entirely (OpenClaw) or require process isolation for
server registration (OpenCode/Kilo). See [MCP resolution](../packages/daemon/src/mcp/resolve-servers.ts)
and [session MCP scope](../packages/daemon/src/runtimes/session-mcp-servers.ts).

Shared login here specifically means the Linux private runtime HOME reuses the
host login's refreshable credentials rather than a copy. It is not a claim that
all authentication methods or operating systems share refresh state. Other
runtimes may receive seeded credentials or environment keys without this shared
refresh integration; see [credential preparation](../packages/daemon/src/runtimes/runtime-credentials.ts)
and [private HOME setup](../packages/daemon/src/runtimes/runtime-home.ts).

Runtime-native tool sandbox integration is separate from the daemon's outer
execution strategy (Host, SRT, microsandbox, or Kubernetes). On sandboxed launches,
Claude/Codex policies restrict model-authored tools while allowing the trusted
runtime to use its credentials; **Not integrated** does not mean an outer sandbox
is unavailable, nor that credentials are shielded from that runtime's tools. See
[launch preparation](../packages/daemon/src/launch/prepare.ts) and the
[sandboxing guide](https://www.agentconnect.md/docs/operate-govern/sandboxing)
for supported boundaries and limitations.

## Keeping the matrices current

Update the integration table when a connector, Relay route, delivery mode, or
sharing boundary changes, checking its setup guide against the registries and
implementation. Update the runtime table when AgentConnect adds or removes a
catalog driver, launch override, shared-login mapping, MCP restriction, or native
tool-sandbox policy. Keep dynamic models and options in daemon-reported facts;
see the [model catalog design](designs/runtime-model-catalog.md). Mark unverified
behavior Pending rather than copying old live-test results or draft promises.
