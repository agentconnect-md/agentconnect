---
name: agentconnect-create-team
description: Create a team of AgentConnect agents from a team template — a lead that runs a task board (a Linear team, or GitHub Issues) and delegates to a coder, a QA agent and a code reviewer — in one guided flow. Use whenever the user asks for a team, a pod, a squad, "agents that work together", "a lead and some engineers", "hire a team for this repo", or asks which team templates exist. Asks one card for the whole team, confirms once, then creates every member by running the sibling agentconnect-create-agent skill per member with its Ask values pre-answered, and ends with one summary of the team and how to give it its first issue. Needs the AgentConnect admin MCP tools; without them it creates nothing and points the user at the console webchat.
---

# Create an AgentConnect agent team from a template

You are the org's built-in **`agentconnect`** preset agent. This skill turns "give me
an engineering team for this repo" into **several working agents that already know
each other**: one card, one confirmation, then each member is created by the sibling
[`agentconnect-create-agent`](../agentconnect-create-agent/SKILL.md) skill with its
values pre-answered, and the lead is created last, naming the others.

A team here is nothing the platform stores. It is a **naming prefix, a shared board,
a shared repository, and personas that name each other**. Members find one another at
run time with the collaboration tools every agent has (`listAgents`, `sendMessage`
with `toAgent`), and the organization's default Agent visibility (`all`) already lets
them call each other. So there is no team object to create, nothing to wire, and every
member remains an ordinary agent the user can edit, pause or delete alone.

Read `agentconnect-create-agent` first — its rules, dialog etiquette, approval handling
and the section **"When another skill drives this one"** are what you are invoking.
Platform knowledge and safety rules live in `agentconnect-platform`.

## Teams

| Team                | Members                                                                                 | Board                                    | Spec                                                                       |
| ------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| **engineering-pod** | `lead` · `coder` · `qa` · `code-reviewer`, all on one repository, named `<team>-<role>` | a Linear team (default) or GitHub Issues | [references/teams/engineering-pod.md](references/teams/engineering-pod.md) |

More teams will be added here. If the user wants a composition no team covers — no QA,
two coders, a reviewer only — say so and offer the nearest: the team spec says which
members are optional, and anything smaller than that is `agentconnect-create-agent`
with one template at a time.

## The rules that keep this short

1. **One card for the whole team, one confirmation.** The team spec's Ask section is
   the union of what its members cannot decide, deduplicated: the repository once, the
   board once, the heartbeat once. Members never get their own card.
2. **The team's fixed values win over a member template's defaults.** The spec sets the
   naming prefix, the board, the repository and the member list; each member template
   keeps its own permission mode, workspace access, output mode and persona.
3. **Members are created by `agentconnect-create-agent`, not by you.** You hand it the
   template name, the pre-answered Ask values and the `name` override, and take back
   the agent id. Do not call `createAgent` yourself; do not re-derive a template's
   fixed table here.
4. **Order matters once.** Teammates first, the **lead last** — its persona names
   them, and its board binding makes it the team's default. A partial team (a member
   failed or was denied) is still reported honestly: what exists, what does not, and
   how to add the missing member alone.
5. **Say what it costs before it starts.** Every member is a `createAgent` approval,
   the lead's board binding is one more, and on Linear each member enabled on the
   workspace is one Console dialog the user completes. Four members on Linear is
   roughly five approvals and four dialogs; say so in the confirmation so the user is
   not surprised by the fifth card.

## The flow

### Step 0 — Preflight

Exactly `agentconnect-create-agent` Step 0: the admin tools are present (`whoami`
first), the session is interactive, a write tool exists. Absent ⇒ stop and point at the
console webchat. Run it **once**; members do not repeat it.

### Step 1 — Pick the team

If the request maps to a team, confirm it in a sentence. Otherwise a single-select card
listing the teams above plus "Something else". A request for a single role is not a
team: hand it to `agentconnect-create-agent`.

### Step 2 — Read the live data, run the team-level prerequisites

Never invent option lists:

1. `listDaemons`, `listDaemonCapabilities`, `getDaemon` — placement, runtime, model,
   resolved once and used for every member (a team on two daemons is not a question
   this skill asks; the user can move a member afterwards).
2. `listAgents` — is the prefix free? The spec's naming rule needs a prefix no existing
   agent uses; propose the next one when it is taken.
3. `listIntegrations` filtered to platform `linear` — is a Linear workspace connected,
   and which teams does it have? None connected ⇒ Linear is still offered: the lead's
   own P1 opens the wizard that connects one. A `404` ⇒ no Linear app on this
   deployment; the board is GitHub Issues.
4. The code-host chain for the repository, once for the team, per
   `agentconnect-create-agent/references/code-hosts.md` (over the AgentConnect MCP server,
   `readSkill` with `{"name": "agentconnect-create-agent", "path": "references/code-hosts.md"}`) — including
   `getGithubRepositoryAccess`, because the coder needs a write workspace from the
   caller's own authority and that `403` must surface **before** the card.

### Step 3 — One card, then one confirmation

Following `agentconnect-create-agent/references/elicitation.md` (over the AgentConnect MCP
server, `readSkill` with `{"name": "agentconnect-create-agent", "path": "references/elicitation.md"}`): one card with the team
spec's Ask fields plus `daemon` / `runtime` / `model` where the reads left a choice;
every field defaulted.

Then one table: the members with their slugs, the board, the repository, each member's
fixed values that matter (write vs read workspace, non-asking permission mode, who is
woken by whom), the heartbeat, and the approval/dialog count from rule 5. One boolean
card: "Create this team?". A "no" or a dismissed card ends the flow.

### Step 4 — Create the members, in the spec's order

For each member, invoke `agentconnect-create-agent` per its "When another skill drives
this one" section: template, pre-answered Ask values, `name` / `displayName`
overrides from the spec. Between members:

- **Report waits by member** ("waiting for approval of `eng-coder`'s creation").
- **One dialog at a time.** A Linear enablement dialog for the coder must come back
  before the QA's opens.
- **A failed member does not stop the others** unless the spec marks it required
  (the lead is). Record it and continue; the summary says what is missing.
- **Collect** each member's `agentId` and slug — the lead's persona and the summary
  need them.

Create the **lead last**, passing the teammates' slugs into its `teammates` value and
letting its own template bind the board (Linear owner via `setChannelTrigger`, or the
GitHub `issues` trigger) and the heartbeat.

### Step 5 — Show the result

One closing message:

1. **The team**: a table of members — role, slug, console URL
   (`/<orgSlug>/agents/<agentId>`, origin from the conversation), what wakes each one.
2. **How to give it work**, from the spec's Verify section: on Linear, delegate an
   issue in the team to the app (no text reaches the lead; `@<slug>` reaches a
   member); on GitHub, comment `@<lead slug>` on an issue.
3. **What is missing**, if anything: a member that failed, a permission still to grant,
   a heartbeat declined — each as one line with the single-agent way to add it.

Then stop. Do not create anything the user did not ask for.
