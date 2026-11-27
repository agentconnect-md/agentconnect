# Team: engineering-pod

Four agents on **one repository**, coordinated through **one task board**: a lead that
scopes and delegates, a coder that implements and opens pull requests, a QA agent that
verifies them, and a code reviewer that reviews every pull request as it opens. The
lead is the only member with a board trigger of its own; the coder and QA are woken by
the lead (or addressed by name in Linear); the reviewer is woken by the code host.

```
person delegates issue ──▶ lead ──sendMessage──▶ coder ──opens PR──▶ code-reviewer (PR trigger)
                            ▲  └──sendMessage──▶ qa  ◀── PR URL ──┘
                            └────── replies (needsReply) ─────────┘
```

Member templates, in `agentconnect-create-agent/references/templates/` (over the AgentConnect MCP server,
`readSkill` with `{"name": "agentconnect-create-agent", "path": "references/templates/<role>.md"}`):
[lead](../../../agentconnect-create-agent/references/templates/lead.md) ·
[coder](../../../agentconnect-create-agent/references/templates/coder.md) ·
[qa](../../../agentconnect-create-agent/references/templates/qa.md) ·
[code-reviewer](../../../agentconnect-create-agent/references/templates/code-reviewer.md).

## Fixed by this team — never ask, just state in the confirmation

| Field           | Value                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prefix `<team>` | The Linear team **key lower-cased** (`ENG` → `eng`) when the board is Linear; the repository name lower-cased otherwise. Overridable only when `listAgents` shows the prefix in use — then propose `<prefix>2` and say why. Every member is `<team>-<role>`: `eng-lead`, `eng-coder`, `eng-qa`, `eng-reviewer`. Display names `ENG · Lead` and so on. |
| board           | **Linear** when a workspace is connected or can be connected; **GitHub Issues** when the deployment has no Linear app. Stated, not asked, unless both are genuinely available and the user gave no hint — then it is the one `board` field.                                                                                                           |
| repository      | One for the whole team; every member's workspace points at it (write for coder and reviewer, read for lead and QA — per their templates).                                                                                                                                                                                                             |
| placement       | One daemon (or the pool), one runtime, one model for every member, from the Step 2 reads.                                                                                                                                                                                                                                                             |
| reviewer format | `Details` when the host allows it (code-reviewer's rule), otherwise `Brief` — decided by the reads, not asked here.                                                                                                                                                                                                                                   |
| who is required | **lead** and **coder**. `qa` and `code-reviewer` are optional members: when the user says "no QA" or the org already reviews this repository (`listAgentHooks` shows a pull-request trigger on it), drop the member and tell the lead's persona so.                                                                                                   |
| heartbeat       | Off by default; the lead template's Ask decides.                                                                                                                                                                                                                                                                                                      |

## Ask — the one card

- **`repo`** — the repository (enum from the installations the deployment has, plus a
  "Different repository" escape hatch). Skip when named.
- **`board`** — only when both are possible: `Linear team <KEY>` (one option per team
  row of the connected workspace, from `listIntegrations`) · `GitHub issues on <repo>`.
- **`members`** — multi-select, all on by default: `Coder` (locked on) · `QA` ·
  `Code reviewer`. The lead is not an option; it is the team.
- **`heartbeat`** — `None` (**default**) · `Weekday mornings` · `Twice a day, weekdays`,
  and **`timezone`** (text, default `UTC`), exactly as the lead template asks.
- `daemon`, `runtime`, `model` — only what the reads left ambiguous.

## Prerequisites — team level, before the card

- Code host vouches for the repository ([code-hosts.md](../../../agentconnect-create-agent/references/code-hosts.md)),
  and on GitHub the installation has **Contents: write** and **Pull requests: write**
  (the coder pushes and opens pull requests; the reviewer publishes reviews).
- On GitHub the caller has write on the repository (`getGithubRepositoryAccess`) — the
  coder's and reviewer's write workspaces are created under the caller's authority.
  Read only ⇒ offer _grant it now, I'll wait_; there is no read-only engineering pod.
- Linear board: a connected workspace, or the lead's P1 dialog connects one; the team
  the user named exists in it.
- Prefix free (`listAgents`).

## Create — in this order

Each step is one `agentconnect-create-agent` run with pre-answered values. Collect the
`agentId` and slug from each.

| #   | Template        | Overrides and pre-answered values                                                                                                                                         | Dialogs the user completes                                                        |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `coder`         | `name: <team>-coder`, `displayName: <TEAM> · Coder`, `repo`, `board` (Linear team or None)                                                                                | Linear: enable on the workspace                                                   |
| 2   | `qa`            | `name: <team>-qa`, `displayName: <TEAM> · QA`, `repo`, `board`, `browser: yes` unless the user said otherwise                                                             | Linear: enable on the workspace; the `agent-browser` skill installer              |
| 3   | `code-reviewer` | `name: <team>-reviewer`, `displayName: <TEAM> · Reviewer`, `repo`, `reviewFormat` from the reads                                                                          | GitLab/Gitea: the trigger wizard; GitHub: none                                    |
| 4   | `lead`          | `name: <team>-lead`, `displayName: <TEAM> · Lead`, `repo`, `board`, `teammates: [<team>-coder, <team>-qa, <team>-reviewer]` (only those created), `heartbeat`, `timezone` | Linear: enable on the workspace, then `setChannelTrigger` makes it the team owner |

Skip rows the user deselected. A row that fails (denied approval, a `403` chat cannot
fix) is recorded and the flow continues; the lead's `teammates` lists only members that
exist, so its persona never promises a colleague it does not have.

## Verify

- **Linear:** in team `<KEY>`, create a small issue ("add a CONTRIBUTING note about
  branch naming") and delegate it to the app. The feed acks with the lead's name; the
  lead creates a sub-issue or wakes `<team>-coder`; a branch and pull request named
  after the issue appear; the reviewer's review lands on the pull request; the lead
  wakes `<team>-qa` with the URL; QA's verdict comes back; the lead moves the issue and
  comments the outcome. `listSessions` shows one session per member along the way.
- **GitHub Issues:** comment `@<team>-lead please handle this` on an issue; the same
  chain, with the lead's report as a single comment when its turn ends.
- **Direct addressing on Linear:** `@<team>-coder fix the typo in README` on an issue
  skips the lead and wakes the coder alone — a useful smoke test for one member.
- Nothing fires ⇒ the lead template's Verify list. A member wake answering
  `not_allowed` ⇒ Agent visibility is `selected` on one side; `configureAgent`,
  `section: 'access'`.

## Optional, afterwards — never as chores

- A Slack channel for the lead's digests (a chat integration on the lead plus a cron
  with a target channel);
- test-account secrets for QA (`configureAgent`, `secrets`);
- a repository engineering checklist as an org skill enabled on coder and reviewer
  (`installSkill`);
- restricted visibility on all four if the repository is sensitive.
