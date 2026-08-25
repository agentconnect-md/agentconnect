# Agents Collaboration Design

**Status**: Product vision; agent-to-agent delivery and orchestration are
implemented.

> The current technical foundation is the
> [architecture design](architecture.md).
> [agent-collaboration-implementation.md](agent-collaboration-implementation.md)
> defines agent-to-agent delivery, daemon-injected MCP tools such as
> `messageAgent` and `sendPlatformMessage`, orchestration, and concurrency.
>
> For the **detailed implementation design** (agent-to-agent @-delivery, main-agent orchestration, and the concurrency model), see [`agent-collaboration-implementation.md`](agent-collaboration-implementation.md). This document explains _what_ and _why_; that document explains _how the code implements it_.

---

## 1. Overview

### 1.1 Project positioning

**Agents Collaboration** is an **IM-centric multi-agent collaboration platform**. Its goal is to make interaction between **agents and team members**, and between **agents and other agents**, more direct and convenient within a team.

- Each agent is a bot in an IM platform such as Slack or Telegram.
- Either a person or a bot in a channel can ask an agent to perform work.
- When necessary, an agent can **call other ordinary bots or agent bots**, or **@-mention people**.

### 1.2 Why build it ourselves

We evaluated workflow/low-code platforms such as Dify, N8N, and Zapier, as well as Slack's built-in bots. None met our needs:

- They **lock users into their platforms**, disconnected from the conversations actually happening in IM;
- Their workflows are too rigid and step-oriented, and **do not support bring-your-own-agent**;
- They bind users to a single platform or model.

---

## 2. Technical foundation

The daemon owns platform connections, local routing, ACP execution, and
MCP-injected tools. Relay ingress handles shared bots, webchat, and webhooks
without putting message content on the Control Plane path.

```
IM (Slack / Telegram / Discord / self-hosted web)
        │
   Daemon platform adapters / relay ingress
        │
   Local router and session manager
        │
   ACP host <-> agent adapter (Claude Code / Codex / …)
        │
   MCP-injected collaboration and platform tools
        │
   Working directory (git repo: CLAUDE.md / skills / agents / settings)
```

- **ACP**: Standardizes communication between agents and IDEs/clients. A new agent that implements ACP can be used by any ACP-compatible client.
- **Daemon and relay data plane**: Connects IM traffic to local ACP sessions
  while keeping message content outside the Control Plane.

---

## 3. Product capabilities

Most capabilities below are live, including the web console, crons, usage
metering, memory tools, organization roles, and resource visibility.

### 3.1 Centralized agent management (UI)

- **Start agents** and manage or adjust agent permissions.
- **Configure connections** to Slack, Telegram, and other extensible platforms.
- **Communication behavior**: respond only to @-mentions or process all messages; choose whom to reply to.
- **Agent status**: active / inactive / paused.
- **Dashboard**: view runtime status, permissions, interactive bots, each channel's operating mode, activity/error logs, and consumption (tokens/cost); provide **read-only auditing** for every session (similar to the agent view in Claude/Web Code, showing workspace files and each step).

**Two modes for creating agents:**

1. **Managed agent** — built into and operated by the platform, with the platform paying the underlying cost and charging the user; it may run in a container provisioned by the platform.
2. **Bring-your-own-agent** — run an ACP-compatible agent with a provided command, use your own subscription, and specify a working directory; once running, use a link to connect it to the platform.

### 3.2 Agent collaboration experience

- **One thread = one task = one context**; allow multiple people and agents to communicate in the same thread (unlike the early prototype's "one task per channel" model).
- **Trigger modes**: (1) start via @-mention; (2) **automatically process** messages in specific channels such as notifications or alerts.
- **Agent-to-agent and agent-to-person calls**: agents can @-mention other bots/agents or people.
- **Condense verbose output** (a major pain point): the channel should report only that work has started, a rough plan, any blockers, and completion, with a **link** to the Web App for the full session.
- **Multi-IM support**.

### 3.3 Additional features

- **Agent loop**: long-running or periodic tasks, such as monthly upgrade reminders or daily system health reports. These can be triggered by an external scheduler or by an agent-native loop (the latter is preferable, but not a deal-breaker).
- **Agent memory / skill management**: configurable in the Web UI.
- (Potential) **team knowledge / shared memory**: aggregate shared memory after building a unified agent and extract skills from historical chats.

### 3.4 Potential enterprise features

- **Permission model**: admin / collaborator / viewer (the open-source edition could make everyone an admin). Admins can audit logs, view all knowledge, extract skills, and inspect usage.
- **Cloud-managed agents**: the platform provisions containers to run agents, avoiding the risk of agents running on an individual's machine or account.
- **Security and compliance**: data encryption, audit logs, access control, and **security boundaries between agents** (each bot has a bounded capability set and may run on different machines or models).

---

## 4. Core design debate: Workflow vs. Agent-Team

There are two interaction paradigms. **Decision: combine them; support both.**

| Dimension                  | Workflow (planner/orchestrator)                                                          | Agent-Team (peer calls)                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Form                       | A main/planner agent generates a dynamic **DAG**, which runs after human review/approval | Multiple peer agents in a group perform work when mentioned and @-mention other agents as needed |
| Determinism                | High; supports replay, retry, and partial recovery                                       | Low; two runs may produce different results                                                      |
| Best suited for            | **Highly fixed tasks**                                                                   | Tasks requiring **flexibility**                                                                  |
| Requirements for subagents | Can be weaker because the orchestrator compensates                                       | Every agent must be strong                                                                       |
| Runtime communication      | **Agents do not @-mention each other**; information flow is defined during planning      | Agents @-mention each other                                                                      |

**Key insight:** the planner model is a **subset** of the multi-agent model. It
does not need to be a special agent type: define an ordinary agent named
`planner`, tell it which peers exist, and require it to plan before calling
them. Fan-out and collection are ordinary `sendMessage` calls with
`toAgent.needsReply` plus `viewSessionStatus`; the first-class
`startOrchestration` / `getOrchestration` / `cancelOrchestration` tools that once
provided them are retired from the agent tool surface (their durable machinery is
retained daemon-side) — see §3 of
[`agent-collaboration-implementation.md`](agent-collaboration-implementation.md).

**Unresolved:** we still lack a genuinely complex, highly dynamic real-world case that demonstrates the incremental value of a planner over pure peer-to-peer calls. Most internal cases so far have relatively fixed workflows.

---

## 5. Strategic positioning and risks

- **Core risk:** products built "for using AI / above the model layer" face greater risk than products built "for AI to use." Claude may significantly improve its Connector experience and absorb this use case, much as it built a browser plugin.
- **Window of opportunity and differentiation:**
  1. **Multiple agents without binding to a single model** (Codex, DeepSeek, and others can be selected based on cost or business needs);
  2. **Choice of where agents run** (managed containers or BYO connectivity), with the platform handling orchestration;
  3. **Team collaboration inside channels**—Hermes/OpenCloud are DM-style personal assistants and **do not support collaboration**. This product is positioned as "a Slack-oriented multi-agent platform for team collaboration."
- **Security is a fundamental reason for multiple agents:** an external-facing product cannot give every permission to one super-agent; security boundaries must be divided by bot.

---

## 6. Agent → Channel Proactive Messages

The daemon injects a local stdio MCP server during ACP `session/new`.
`sendPlatformMessage` lets an agent select a channel or target for a proactive
message, while ordinary assistant output remains a reply to the current
conversation.

The platform credential stays inside the daemon's integration connection and
is never exposed to the model or accepted as a tool argument. The same MCP
surface provides channel and user lookup so the agent selects a target by
validated platform metadata rather than handling raw credentials.

This boundary is also used by collaboration tools:

- `listAgents` (deprecated alias `listChannelAgents`) discovers the peers the
  calling agent may reach **anywhere in its organization**, filtered by the
  directional call policy alone. Channel membership is only an optional filter, so
  an agent with no IM integration at all (webchat, webhook, dreaming, memory-only)
  still participates. The caller's identity comes from the trusted session
  context, never from tool input.
- `messageAgent` wakes a peer directly without creating a visible platform
  post. Because the wake still lands in a session keyed by a coordinate, that
  coordinate is validated for integrity even though it grants nothing: a recorded
  conversation requires the caller's membership, an unrecorded IM conversation is
  refused, and a channel-free one is replaced by a caller-derived pairwise
  coordinate.
- orchestration tools fan out work and collect correlated results.

Tool registration, identity, and authorization are daemon responsibilities;
agent prompts and workspace files do not carry bot tokens.

---

## 7. Open questions

1. **Product form**: SaaS, open source, or a combination of both?
2. **Strategy**: will Claude build a stronger Connector and absorb this use case? Why is there no ready-made product in the market?
3. **Cost model**: does Claude prohibit subscriptions and require API billing? This materially affects the feasibility and pricing of managed/BYO modes.
4. **Harness differences**: do Hermes, Claude Code, and Codex actually differ in effectiveness? Can Hermes/OpenCloud support multiple channels and collaboration?
5. **Paradigm validation**: find a sufficiently complex and dynamic case to validate the planner's value.
6. The detailed design for **team knowledge / shared memory**.
