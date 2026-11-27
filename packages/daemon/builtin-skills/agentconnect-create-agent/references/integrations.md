# Integrations: getting the new agent reached

A trigger is how an **event** reaches an agent; an integration is how a **person** does.
The template's own trigger is part of creation (SKILL.md step 4). Everything on this
page is step 5 — offered once, added only when the user wants it, never bolted onto a
creation nobody asked to wire into Slack.

## The one tool

`configureIntegration` opens the Console's integration wizard inside the conversation:

```json
{ "mode": "create", "provider": "slack", "agentId": "<uuid>" }
```

`provider` is optional (omit it and the user picks a tile) and may be any chat platform
— `slack`, `telegram`, `discord`, `feishu`, `linear` — or a hook kind — `github`,
`gitlab`, `gitea`, `webhook`. `agentId` preselects the agent and stays editable.

Editing an existing row instead:

```json
{ "mode": "edit", "agentId": "<uuid>", "target": { "kind": "integration", "id": "<uuid>" } }
```

`kind: 'integration'` is a chat binding (ids from `listIntegrations`); `kind:
'codehost-subscription'` is a GitHub/GitLab/Gitea trigger row (ids from
`listAgentHooks`). Both need the owning `agentId`, and the tool resolves them through a
read before it opens anything, so a wrong id is a 404 here rather than a confusing
dialog.

The dialog is the credential boundary. Bot tokens, app secrets, request URLs and OAuth
hops all live inside it, under the user's own Console session. **Never** ask for any of
them in chat, and never offer to "just paste it here" when a user tries.

After a submit, verify with `listIntegrations` (the binding and its conversations) or
`listAgentHooks` (trigger rows) before you claim anything works.

## What each platform actually costs the user

Know this before you offer it — "shall I wire it into Slack?" is a different question
depending on whether that takes ten seconds or a Slack admin.

| Provider                    | What the user does in the dialog                                                                             | Needs                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **Slack**                   | the deployment's "Add to Slack" install when the funnel is enabled, otherwise a custom Slack app they create | a Slack workspace admin for the install; a public callback (relay) unless the deployment runs socket mode |
| **Telegram**                | paste a bot token from BotFather                                                                             | nothing else — the cheapest one to offer                                                                  |
| **Discord**                 | generate the invite and add the bot to the server                                                            | Manage Server on the guild                                                                                |
| **Lark / Feishu**           | app id + secret, and the request URL the dialog shows                                                        | a Lark admin; a reachable request URL                                                                     |
| **Linear**                  | connect the workspace through the deployment's Linear app                                                    | a Linear workspace admin                                                                                  |
| **Webhook**                 | the wizard mints the ingress URL and its signing secret                                                      | a public relay; the secret is shown once                                                                  |
| **GitHub / GitLab / Gitea** | a repository trigger — see [code-hosts.md](code-hosts.md)                                                    | the host's connection                                                                                     |

Notes that change the answer:

- **A bot is durable; an integration is a binding.** One bot identity can front several
  agents, routed per conversation — adding a second agent to a Slack workspace usually
  means another integration on the **same** bot, not another Slack app. Check
  `listIntegrations` and `listBots` before sending anyone to create an app.
- **Webhook triggers are console-only by design.** They mint an ingress URL and an HMAC
  secret, which is a capability, so no admin MCP tool creates one — the dialog does.
- **Linear addresses agents in the text.** One deployment app fronts every agent; a
  bare delegation reaches the team conversation's default agent and `@<agent-name>`
  picks a specific one. A team is the channel, so each team has its own trigger.
- **Feishu and Slack need a public callback**; a deployment with no relay cannot
  terminate one. If the dialog reports that, it is an operator task, not the user's.

## Channel triggers

Once a bot is in a conversation, each conversation carries a trigger mode:

- `mention` — @-mention only (the default),
- `any` — every message,
- `off` — muted; membership and history are kept.

`setChannelTrigger` sets it (`integrationId` + `channelId` from `listIntegrations`), and
also moves one conversation to a different owning agent (`agentId`, or `null` to clear
the override). This is a write, so it goes through the owner's approval like any other.

A restricted agent starts with its channels `off` — if the user says "it's in the
channel but silent", that, or a `mention`-mode conversation nobody mentioned, is nearly
always why.

## What to say when the user asks for something that is not creation

An existing agent, another repository, a second platform — this skill's flow is for
_creating_ one agent. Everything above works the same for an agent that already exists:
`configureIntegration` with its `agentId`, `setChannelTrigger` for the conversation,
`configureAgent` for its configuration. Do not run the template flow again to get there.
