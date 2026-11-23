# Org Refusal Tag — Why an Organization Was Refused

**Status:** proposed. The format and codes are declared by `@agentconnect.md/protocol`
`org-refusal.ts`; no reader acts on a tag yet. This document records what the schema cannot carry.

## 1. Why a tag

When an organization may not run, the refusal reaches AgentConnect through more than one channel,
and only one of them is a contract AgentConnect defines:

| Channel                               | Who refuses                                          | Who reads it                                               |
| ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `IssueKey` answers `org_suspended`    | the key server ([key-server.md](key-server.md) §6)   | the daemon, in the turn's failure notice                   |
| `OrgStanding` answers `org_suspended` | the key server ([key-server.md](key-server.md) §2.3) | the Control Plane, then the console (402 `ORG_SUSPENDED`)  |
| a model request is refused            | the deployment's model gateway                       | the runtime, then the daemon, in the turn's failure notice |

Each channel carries a sentence written by whoever refused, and the reader shows it as written. That
sentence cannot be acted on: a reader cannot tell running out of credit from any other refusal, so it
cannot show the next step that fits, link to a page of its own surface, or speak the reader's
language. The HTTP status cannot carry the reason either. On the gateway channel the runtime stands
between the refusal and the daemon, and runtimes treat statuses in ways the refuser does not control
(§4.2): some read 401 and 403 as a signed-out credential and drop the body, several retry a 5xx for
minutes, and some hand up the message without the status at all.

So the reason travels inside the message, where every channel already carries text, as a tag the
reader can find in any of them.

## 2. Format

```
[ERR:<code>] <sentence>
```

- `<code>` is lower snake_case, `[a-z][a-z0-9_]{0,63}`, and names **why** the organization was refused
  (§3). It is the only part a reader branches on.
- Exactly one space follows the tag.
- `<sentence>` is a plain statement of what happened, for a reader that knows no better. It carries no
  links and no instructions: what to do next is the reader's to say, for its own surface.
- The tag **leads** the message. Runtimes put their own text before the message and some put text
  after it (§4.2), so a leading tag sits right after the runtime's prefix in every case, while a
  trailing one would not end the text either.

A message without a tag is not wrong; it is a refusal that names no reason, and readers treat it as
they do today (§5).

## 3. Codes

| Code                   | Meaning                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `out_of_credits`       | The organization's prepaid credit is used up. Adding credit lets it run again.                                                                                         |
| `standing_unconfirmed` | The refuser cannot confirm the organization may run: whatever decides its standing has not renewed it. Not a decision about the organization; it may clear on its own. |

- A code names one reason for good. It is never reused for another meaning.
- Adding a reason is a row here and a member of `OrgRefusalCode`, then the refusers that send it.
- A reader that meets a code it does not know treats the refusal as an organization refusal with no
  known reason and shows the sentence (§5). So a refuser may start sending a new code before every
  reader knows it.
- The same reason uses the same code on every channel, so one organization's refusal reads the same in
  the console and in chat.

## 4. Channels

### 4.1 Key-server refusals

On `IssueKey` and `OrgStanding`, the tagged message is `error.message` of a `KeyServerErrorBody` whose
`error.code` is `org_suspended`. The status and the rest of the body are as [key-server.md](key-server.md)
§6 defines them; the tag adds a reason to a verdict the contract already carries.

### 4.2 Model gateway refusals

A deployment's model gateway that refuses a model request because of the organization's standing puts
the tagged message where the runtime will lift it:

- **In the provider's own error shape**, chosen by the dialect the credential is for. Anthropic:
  `{"type":"error","error":{"type":"permission_error","message":"<tagged message>"}}`. OpenAI:
  `{"error":{"message":"<tagged message>","type":"…","code":"…","param":null}}`. A body in any other
  shape is not lifted: DeepSeek Harness hands up only `DeepSeek Messages request failed (402)`.
- **At a status no runtime treats as signed out or retryable.** Not 401 or 403: Claude Code and
  DeepSeek Harness answer ACP `-32000 Authentication required`, and the daemon marks the runtime as
  needing a login. Not a 5xx, 408, 409 or 429: SDKs retry them, and the message arrives minutes later
  if at all. 402, 422 and 423 pass through every runtime below at once.

What each runtime hands up for a tagged message at 402, measured 2026-11-23 against a mock gateway with
claude-agent-acp 0.109.1, codex-acp 2.9.0-agentconnect.1, deepseek-harness-acp 0.4.41 and OpenCode
1.19.6. The probe's tag carried the status rather than a code; the message is passed through verbatim
either way, and the same holds at 423.

| Runtime          | Text handed up                                                                          |
| ---------------- | --------------------------------------------------------------------------------------- |
| Claude Code      | `API Error: 402 [ERR:402] Out of AgentConnect credits`                                  |
| Codex            | `unexpected status 402 Payment Required: [ERR:402] Out of AgentConnect credits, url: …` |
| DeepSeek Harness | `turn failed: [ERR:402] Out of AgentConnect credits`                                    |
| OpenCode         | `[ERR:402] Out of AgentConnect credits`                                                 |

The gateway is the deployment's, not AgentConnect's, so this section is what a gateway does if it wants
its refusals read; nothing here requires a deployment to run one.

## 5. Reading

- Find the tag anywhere in the text: `parseOrgRefusal` in the protocol package. The text before it is
  the runtime's or the transport's, not the refuser's.
- Branch on the code. What each code shows — the next step, a link to the organization's billing page,
  the wording — is the reader's choice and follows [product-conventions.md](../product-conventions.md).
- Use the sentence only where the code is unknown. On the gateway channel, strip the runtime's
  decoration first (the daemon already does, `undecorateRuntimeError`), since Codex appends text after
  the message.
- With no tag, show the text as before.

**A tag is presentation, never authority.** Gateway text reaches the daemon through a runtime and a
provider endpoint the daemon does not control, so a reader may choose wording from a tag but must not
change state because of one: no marking an organization suspended, no revoking, no stopping other
sessions. Those follow the key server's `org_suspended` verdict, as they do today.

## 6. Out of scope

- Which reasons a deployment stops organizations for. The registry names reasons once a refuser sends
  them; it does not ask any deployment to.
- Other failures that reach a turn: provider errors, quota refusals that are not about the
  organization's standing (`quota_denied`), and the runtime's own faults keep their current handling.
