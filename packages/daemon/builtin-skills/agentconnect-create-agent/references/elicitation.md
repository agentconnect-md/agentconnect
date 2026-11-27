# Asking questions on AgentConnect: elicitation cards

AgentConnect renders a runtime's **structured question** (ACP `elicitation/create`,
form mode) as a card in the conversation — a webchat card, a Slack Block Kit card — with
real controls (radio options, checkboxes, a text or number input, a multi-field form) and
a submit. The answer comes back as typed data, not as a free-text message you have to
parse. Use this for every parameter in the create-agent flow.

## How to raise a card

Use your runtime's structured-question tool — in Claude Code that is
`AskUserQuestion`; other ACP runtimes expose an equivalent "ask the user" request.
The daemon turns it into the platform card. Plain prose questions still work but
cost the user a typed reply and cost you a parsing step; reserve prose for
explanations, not for collecting values.

## What a card can hold

| Field kind   | Renders as            | Notes                                                             |
| ------------ | --------------------- | ----------------------------------------------------------------- |
| `enum`       | single-choice options | Give each option a short label; the value is what you get back.   |
| `multi-enum` | checkboxes + confirm  | Supports min/max item counts.                                     |
| `boolean`    | two options (yes/no)  | Use for confirmations such as "Create this agent?".               |
| `text`       | free-text input       | Can carry `minLength`/`maxLength`/`pattern`/format (email, uri…). |
| `number`     | numeric input         | Optional integer flag and min/max.                                |

- **Defaults** are honored: the card pre-fills the control, the user may change it.
- **Multi-field form**: one card can carry 2–**10** fields with one submit. Above
  10 fields the daemon declines the card — split it.
- **Slack** shows at most **5 option buttons** per choice; webchat has no cap.
  When an enum has more than 5 options and the user might be in Slack, split the
  list or ask the long list as a text field with the options spelled out.
- Options are the **only** answers the user can give; there is no "other" unless
  you add one. Always add an escape hatch such as "Something else" / "Skip" where
  the list might be incomplete.
- A **dismissed / declined** card is a real answer: stop and ask how the user wants
  to proceed instead of retrying the same card.
- **URL mode** exists for consent flows (open this link, e.g. a GitHub App install
  page). Use it when a prerequisite requires the user to complete a flow in their
  browser: show the exact URL, wait for them to come back, then re-check.

## Cards versus Console dialogs

Two different things appear in the conversation and they are not interchangeable:

- a **question card** is yours — you raise it, the user answers, the answer comes back
  as typed data you act on;
- a **Console dialog** is the platform's own form, opened by `manageCodeHosts`,
  `configureIntegration`, `configureAgent`, `manageAgentTools`, `installSkill` or
  `installMcpServer`. The user fills it in under their own Console session, and what
  comes back is a short summary of what was saved.

The dividing line is authority. Anything the platform must do under the user's own
credentials — installing an App, connecting GitLab, a bot token, an app secret, an MCP
header, an env var — is a dialog. Never raise a question card to collect one of those,
and never turn a dialog's job into a series of questions. Conversely, do not open a
dialog to ask something a card answers in one tap.

One at a time, either way: a pending dialog is a pending question, and stacking a card
on top of it is how a user ends up answering the wrong one.

## Where cards do not work

Headless sessions — cron firings, inbound hooks (GitHub / webhook), dream and other
daemon-internal passes — have nobody to answer, and the Claude Code runtime has
`AskUserQuestion` disabled there. If this skill is invoked from such a session, say
the flow needs an interactive chat (webchat or a chat platform) and stop.

## Rules of thumb for this skill

1. **A card you do not need is a card you do not raise.** Two cards is the budget for
   a whole creation: one for what only the user knows, one boolean to confirm. Before
   adding a field, ask which of these it is — a value a **read** already answers
   (there is one online daemon; the runtime offers one model), a value the **template
   fixes** (access tier, permission mode, output mode, slug, branch), or a real choice
   only the user can make (which repository, which review format). Only the third kind
   is a field; the first two are looked up and stated.
2. **Read before you ask.** Option lists (daemons, runtimes, models, efforts,
   permission modes, existing agent names, GitHub repositories) come from the admin
   tools, never from memory. Stale or invented values fail at `createAgent`.
3. **Every field carries a default**, so submitting the card untouched produces the
   thing the user asked for.
4. **Label with consequences.** "Permission mode: bypass (edits files without
   asking)" beats "bypass". Put the human name (`name`) and the runtime's own
   description in the label when the catalog provides them.
5. **Confirm before writing.** Every create/update goes through a boolean card that
   restates what will be created. The confirmation is the user's decision, not a
   formality — respect a "no".
6. **Never collect secrets** in a card or in chat: no tokens, no API keys, no
   passwords. A prerequisite that needs a credential is a Console dialog you open
   from here (above); you only re-read afterwards.
