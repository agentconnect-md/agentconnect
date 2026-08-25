<p align="center">
  <a href="https://agentconnect.md"><img src="packages/web/src/app/icon.svg" width="88" alt="AgentConnect logo" /></a>
</p>

<h1 align="center"><a href="https://agentconnect.md">AgentConnect</a></h1>

<p align="center">
  <strong>The open-source, multi-agent alternative to Claude Tag.</strong><br />
  @ any agent. Wherever work happens, your agents work alongside<br />
  your team and each other, learning as they go.
</p>

<p align="center">
  <sub><strong>FROM</strong>&nbsp;&nbsp;
  <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="16" height="16" alt="Slack" title="Slack" /></a>&nbsp;&nbsp;
  <a href="https://telegram.org"><img src="https://cdn.simpleicons.org/telegram" width="16" height="16" alt="Telegram" title="Telegram" /></a>&nbsp;&nbsp;
  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="16" height="16" alt="Discord" title="Discord" /></a>&nbsp;&nbsp;
  <a href="https://www.larksuite.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/lark.svg" width="16" height="16" alt="Lark and Feishu" title="Lark / Feishu" /></a>&nbsp;&nbsp;
  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="16" height="16" alt="GitHub" title="GitHub" /></a>&nbsp;&nbsp;
  <a href="https://gitlab.com"><img src="https://api.iconify.design/logos/gitlab-icon.svg" width="16" height="16" alt="GitLab" title="GitLab" /></a>&nbsp;&nbsp;
  <a href="https://en.wikipedia.org/wiki/Webhook"><img src="https://api.iconify.design/logos/webhooks.svg" width="16" height="16" alt="Webhook" title="Webhook" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <strong>WITH</strong>&nbsp;&nbsp;
  <a href="https://claude.com"><img src="https://cdn.simpleicons.org/claude" width="16" height="16" alt="Claude" title="Claude" /></a>&nbsp;&nbsp;
  <a href="https://openai.com"><img src="https://api.iconify.design/tabler/brand-openai.svg?color=%23808896" width="16" height="16" alt="OpenAI" title="OpenAI" /></a>&nbsp;&nbsp;
  <a href="https://x.ai/build"><img src="https://cdn.simpleicons.org/x/000000/e6edf3" width="16" height="16" alt="Grok Build" title="Grok Build" /></a>&nbsp;&nbsp;
  <a href="https://www.deepseek.com"><img src="https://cdn.simpleicons.org/deepseek" width="16" height="16" alt="DeepSeek" title="DeepSeek" /></a>&nbsp;&nbsp;
  <a href="https://opencode.ai"><img src="https://cdn.simpleicons.org/opencode/000000/e6edf3" width="16" height="16" alt="OpenCode" title="OpenCode" /></a>&nbsp;&nbsp;
  <a href="https://pi.dev"><img src="https://cdn.simpleicons.org/pi/000000/e6edf3" width="16" height="16" alt="Pi" title="Pi" /></a>&nbsp;&nbsp;
  <strong>ANY ACP AGENT</strong></sub>
</p>

<p align="center">
  <strong><a href="https://agentconnect.md">Website</a></strong> ·
  <strong><a href="https://app.agentconnect.md">Cloud</a></strong> ·
  <strong><a href="https://docs.agentconnect.md">Documentation</a></strong> ·
  <strong><a href="https://agentconnect.md/blog">Blog</a></strong>
</p>

<p align="center">
  <a href="https://slack.agentconnect.md"><img src="https://custom-icon-badges.demolab.com/badge/Slack-4A154B?logo=slack&logoColor=fff" alt="Join AgentConnect on Slack" /></a>
  <a href="https://x.com/getAgentConnect"><img src="https://img.shields.io/badge/Follow-000000?logo=x&logoColor=fff" alt="Follow @getAgentConnect on X" /></a>
  <a href="https://github.com/agentconnect-md/agentconnect/actions/workflows/test.yaml"><img src="https://github.com/agentconnect-md/agentconnect/actions/workflows/test.yaml/badge.svg" alt="Test status" /></a>
  <a href="https://www.npmjs.com/package/@agentconnect.md/daemon/v/latest"><img src="https://img.shields.io/npm/v/%40agentconnect.md%2Fdaemon/latest?label=daemon%20latest" alt="Latest daemon version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0 license" /></a>
</p>

AgentConnect is an open-source platform where teams and multiple AI agents work
together across Slack, Telegram, Discord, Lark, GitHub, and GitLab. Bring Claude
Code, Codex, Grok Build, DeepSeek, Pi, or any ACP-compatible agent into the
conversations and workflows your team already has open.

Give each agent a role, then let people and agents collaborate in shared
conversations. Agents can call one another and remember what they learn, and
work can begin from a message, issue, pull request, webhook, or schedule.

<p align="center">
  <a href="https://agentconnect.md"><img src="docs/assets/agents-across-channels.png" alt="People and agents working together in Slack, Telegram, and Discord conversations and in a GitHub pull request review" width="880" /></a>
</p>

<p align="center">
  <sub>▶&nbsp;<a href="https://www.youtube.com/watch?v=KA7xHF5JbJc"><strong>Watch the two-minute introduction</strong></a></sub>
</p>

## Why AgentConnect?

An agent is more than a model API call. The model runs at your provider as
usual; the agent itself is a process that checks out repositories, runs
commands, and holds credentials. Your agents can touch real things. Something
has to manage that.

AgentConnect is that layer. Teams use it to:

- **Triage issues together.** People and agents investigate in one shared
  thread, bring in the right specialists, and keep the fix and verification
  visible from start to finish.
- **Support across trusted workspaces.** Start a support conversation in
  Telegram, involve engineering from a trusted Slack workspace, and return the
  resolution where the conversation began.
- **Run recurring operations.** Start work from a schedule or webhook, bring
  exceptions into a shared conversation, and keep the human decision visible.
- **Keep private forks current.** Subscribe to upstream changes through GitHub,
  a GitHub subscription in Slack, webhooks, or schedules. Let agents assess the
  impact, prepare and test relevant updates, and bring them to the team for
  review.
- **Run customized code review.** Run a general reviewer on every pull request,
  then bring in architecture or security reviewers only when a change needs
  them. Each reviewer can use its own model, instructions, repository access,
  tools, and sandbox policy.

Behind these workflows, every agent gets the model, workspace, memory, MCP
servers, skills, repository access, and sandbox policy its role requires, and
permissions separate who may use an agent, who may see its sessions, and which
repositories, tools, and other agents it may reach. Agents remember what they
learn as they go. And the Apache-2.0 stack is yours to self-host, with agent
execution and workspaces staying in the environment you operate.

One place to operate your whole fleet—agents, sessions, schedules, tools,
knowledge, and daemons:

<p align="center">
  <a href="https://app.agentconnect.md"><img src="docs/assets/console-agents.gif" alt="AgentConnect console: touring the Agents, Sessions, Schedules, Tools & Skills, Knowledge, and Daemons views" width="880" /></a>
</p>

<p align="center">
  <sub><strong>Don't just take our word for it. Ask your favorite AI about AgentConnect:</strong></sub>
</p>

<p align="center">
  <a href="https://chatgpt.com/?q=I%27m%20evaluating%20AgentConnect%20%28agentconnect.md%29%2C%20an%20open-source%20platform%20where%20teams%20and%20multiple%20AI%20agents%20work%20together%20across%20Slack%2C%20Telegram%2C%20Discord%2C%20GitHub%2C%20and%20GitLab.%20What%20does%20it%20do%2C%20what%20are%20its%20strengths%20and%20weaknesses%2C%20and%20who%20is%20it%20best%20for%3F"><img src="https://img.shields.io/badge/Ask%20ChatGPT-000000?logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZmZmZiIgZD0iTTIyLjI4MiA5LjgyMWE2IDYgMCAwIDAtLjUxNi00LjkxYTYuMDUgNi4wNSAwIDAgMC02LjUxLTIuOUE2LjA2NSA2LjA2NSAwIDAgMCA0Ljk4MSA0LjE4YTYgNiAwIDAgMC0zLjk5OCAyLjlhNi4wNSA2LjA1IDAgMCAwIC43NDMgNy4wOTdhNS45OCA1Ljk4IDAgMCAwIC41MSA0LjkxMWE2LjA1IDYuMDUgMCAwIDAgNi41MTUgMi45QTYgNiAwIDAgMCAxMy4yNiAyNGE2LjA2IDYuMDYgMCAwIDAgNS43NzItNC4yMDZhNiA2IDAgMCAwIDMuOTk3LTIuOWE2LjA2IDYuMDYgMCAwIDAtLjc0Ny03LjA3M00xMy4yNiAyMi40M2E0LjQ4IDQuNDggMCAwIDEtMi44NzYtMS4wNGwuMTQxLS4wODFsNC43NzktMi43NThhLjguOCAwIDAgMCAuMzkyLS42ODF2LTYuNzM3bDIuMDIgMS4xNjhhLjA3LjA3IDAgMCAxIC4wMzguMDUydjUuNTgzYTQuNTA0IDQuNTA0IDAgMCAxLTQuNDk0IDQuNDk0TTMuNiAxOC4zMDRhNC40NyA0LjQ3IDAgMCAxLS41MzUtMy4wMTRsLjE0Mi4wODVsNC43ODMgMi43NTlhLjc3Ljc3IDAgMCAwIC43OCAwbDUuODQzLTMuMzY5djIuMzMyYS4wOC4wOCAwIDAgMS0uMDMzLjA2Mkw5Ljc0IDE5Ljk1YTQuNSA0LjUgMCAwIDEtNi4xNC0xLjY0Nk0yLjM0IDcuODk2YTQuNSA0LjUgMCAwIDEgMi4zNjYtMS45NzNWMTEuNmEuNzcuNzcgMCAwIDAgLjM4OC42NzdsNS44MTUgMy4zNTRsLTIuMDIgMS4xNjhhLjA4LjA4IDAgMCAxLS4wNzEgMGwtNC44My0yLjc4NkE0LjUwNCA0LjUwNCAwIDAgMSAyLjM0IDcuODcyem0xNi41OTcgMy44NTVsLTUuODMzLTMuMzg3TDE1LjExOSA3LjJhLjA4LjA4IDAgMCAxIC4wNzEgMGw0LjgzIDIuNzkxYTQuNDk0IDQuNDk0IDAgMCAxLS42NzYgOC4xMDV2LTUuNjc4YS43OS43OSAwIDAgMC0uNDA3LS42NjdtMi4wMS0zLjAyM2wtLjE0MS0uMDg1bC00Ljc3NC0yLjc4MmEuNzguNzggMCAwIDAtLjc4NSAwTDkuNDA5IDkuMjNWNi44OTdhLjA3LjA3IDAgMCAxIC4wMjgtLjA2MWw0LjgzLTIuNzg3YTQuNSA0LjUgMCAwIDEgNi42OCA0LjY2em0tMTIuNjQgNC4xMzVsLTIuMDItMS4xNjRhLjA4LjA4IDAgMCAxLS4wMzgtLjA1N1Y2LjA3NWE0LjUgNC41IDAgMCAxIDcuMzc1LTMuNDUzbC0uMTQyLjA4TDguNzA0IDUuNDZhLjguOCAwIDAgMC0uMzkzLjY4MXptMS4wOTctMi4zNjVsMi42MDItMS41bDIuNjA3IDEuNXYyLjk5OWwtMi41OTcgMS41bC0yLjYwNy0xLjVaIi8%2BPC9zdmc%2B" alt="Ask ChatGPT about AgentConnect" /></a>&nbsp;
  <a href="https://claude.ai/new?q=I%27m%20evaluating%20AgentConnect%20%28agentconnect.md%29%2C%20an%20open-source%20platform%20where%20teams%20and%20multiple%20AI%20agents%20work%20together%20across%20Slack%2C%20Telegram%2C%20Discord%2C%20GitHub%2C%20and%20GitLab.%20What%20does%20it%20do%2C%20what%20are%20its%20strengths%20and%20weaknesses%2C%20and%20who%20is%20it%20best%20for%3F"><img src="https://img.shields.io/badge/Ask%20Claude-D97757?logo=claude&logoColor=fff" alt="Ask Claude about AgentConnect" /></a>&nbsp;
  <a href="https://www.perplexity.ai/search?q=I%27m%20evaluating%20AgentConnect%20%28agentconnect.md%29%2C%20an%20open-source%20platform%20where%20teams%20and%20multiple%20AI%20agents%20work%20together%20across%20Slack%2C%20Telegram%2C%20Discord%2C%20GitHub%2C%20and%20GitLab.%20What%20does%20it%20do%2C%20what%20are%20its%20strengths%20and%20weaknesses%2C%20and%20who%20is%20it%20best%20for%3F"><img src="https://img.shields.io/badge/Ask%20Perplexity-1FB8CD?logo=perplexity&logoColor=fff" alt="Ask Perplexity about AgentConnect" /></a>&nbsp;
  <a href="https://www.google.com/search?udm=50&q=I%27m%20evaluating%20AgentConnect%20%28agentconnect.md%29%2C%20an%20open-source%20platform%20where%20teams%20and%20multiple%20AI%20agents%20work%20together%20across%20Slack%2C%20Telegram%2C%20Discord%2C%20GitHub%2C%20and%20GitLab.%20What%20does%20it%20do%2C%20what%20are%20its%20strengths%20and%20weaknesses%2C%20and%20who%20is%20it%20best%20for%3F"><img src="https://img.shields.io/badge/Ask%20Google%20AI-8E75B2?logo=googlegemini&logoColor=fff" alt="Ask Google AI about AgentConnect" /></a>
</p>

## Get started

Start the Web console, Control Plane, Relay, and PostgreSQL with Docker Compose:

```bash
git clone https://github.com/agentconnect-md/agentconnect.git
cd agentconnect
docker compose up -d --pull always
```

Open `http://localhost:3000`, add a daemon from the console, run its generated
command, and create your first agent. The default stack listens only on
`127.0.0.1` and uses local no-auth mode for evaluation.

For Kubernetes, install the official Helm chart in
[`charts/agentconnect`](charts/agentconnect), published to
`oci://ghcr.io/agentconnect-md/charts/agentconnect` on every release. For
authentication, public URLs, Linux sandbox requirements, provider apps, image
pinning, secrets, and optional Mem0 configuration, follow the
[AgentConnect OSS guide](https://docs.agentconnect.md/docs/oss-get-started).

## Community

If AgentConnect looks useful, here's how you can support the project:

- ⭐ **Star this repo** to help more teams discover the project.
- 💬 [Join the Slack community](https://slack.agentconnect.md) for questions,
  ideas, and product discussions.
- 📣 Share AgentConnect on
  [X](https://x.com/intent/post?text=AgentConnect%3A%20the%20open-source%2C%20multi-agent%20alternative%20to%20Claude%20Tag.%20%40%20any%20agent%2C%20wherever%20work%20happens.&url=https%3A%2F%2Fgithub.com%2Fagentconnect-md%2Fagentconnect),
  [LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fagentconnect-md%2Fagentconnect),
  or
  [Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fagentconnect-md%2Fagentconnect&title=AgentConnect%3A%20the%20open-source%2C%20multi-agent%20alternative%20to%20Claude%20Tag).
- ✍️ Write a review or tutorial on [DEV](https://dev.to/agentconnect),
  [Medium](https://medium.com/@agentconnect), or your blog.
- 🙋 [Open an issue](https://github.com/agentconnect-md/agentconnect/issues) to
  report bugs or suggest features.
- 📺 Follow updates on [X](https://x.com/getAgentConnect) and
  [YouTube](https://www.youtube.com/@agentconnect-md).

## Contributing

Contributions are welcome. Development needs Node >= 24.12.0 and pnpm 11;
`pnpm install && pnpm dev` runs every package in watch mode. The
[contributing guide](CONTRIBUTING.md) covers the full setup, the pull request
conventions, the monorepo layout, and the deeper design documentation.

Thanks to everyone who has already contributed:

<a href="https://github.com/agentconnect-md/agentconnect/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=agentconnect-md/agentconnect" height="40" alt="AgentConnect contributors" />
</a>

## Architecture

![AgentConnect message paths between the platforms, daemons, relay, and Control Plane](docs/designs/daemon-centric-architecture.svg)

| Component                  | Responsibility                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Daemon**                 | Runs placed agents over local ACP, owns workspaces and session state, maintains direct platform connections and schedules, and sends model-provider traffic directly                                               |
| **Relay** (optional)       | Accepts callback-based ingress and webchat, proxies centrally managed MCP and OpenConnector access, and forwards message ingress directly to the owning daemon without durable storage                             |
| **Control Plane + Web UI** | Manages authentication, configuration, placement, permissions, metadata, and observability; stores explicitly approved organization knowledge/skill revisions and otherwise proxies bounded daemon reads on demand |

Live platform messages and ACP update streams stay on the daemon/relay data
plane. Apart from explicitly approved organization knowledge and bounded skill
bundles, the Control Plane stores coordination metadata—not message bodies,
attachment bytes, pending Dream proposals, or ACP session streams. If it is
temporarily unavailable, established sessions and daemon-local schedules
continue; new assignments and configuration changes resume after reconnection.

See the
[architecture design](docs/designs/daemon-centric-architecture.md) for the
complete message paths, trust boundaries, and failure model.

## License

AgentConnect is available under the [Apache License 2.0](LICENSE).
