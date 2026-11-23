# Org Refusal Tag — Why an Organization Was Refused

**Status:** proposed, together with the key-server §6 line that points here. The format and codes are
declared by `@agentconnect.md/protocol` `org-refusal.ts`; no reader acts on a tag yet, so no issuer may
send one yet (§6). This document records what the schema cannot carry.

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
- `<sentence>` is a plain statement of what happened, for a reader that knows no better. In the steady
  state it carries no links and no instructions: what to do next is the reader's to say, for its own
  surface. During the rollout an issuer may keep links after the tag for readers that predate it (§6).
- The tag **leads** the message. Runtimes put their own text before the message and some put text
  after it (§4.2), so a leading tag sits right after the runtime's prefix in every case, while a
  trailing one would not end the text either.
- The `[ERR:` prefix is reserved for organization refusals. Nothing else AgentConnect reads may use it,
  so a well-formed tag with an unregistered code is still an organization refusal, just one whose reason
  this version does not know.

A message without a tag is not wrong; it is a refusal that names no reason, and readers treat it as
they do today (§5).

## 3. Codes

| Code              | Meaning                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `out_of_credits`  | The organization had prepaid credit and it is used up or expired. Adding credit lets it run again.                                                                                                                                                                  |
| `never_funded`    | No credit has ever reached the organization: no purchase, grant or promotion. Adding credit lets it start. Kept apart from `out_of_credits` because the next step reads differently, as the console's billing banner already tells "never funded" from "spent out". |
| `standing_lapsed` | The organization's standing expired and nothing renewed it. The refuser fails closed: until whatever decides standing renews it, the organization may not run. Adding credit does not help; it clears when renewal resumes.                                         |

**`standing_lapsed` is a refusal, not `unavailable`.** On the two key-server channels every code here
rides inside `org_suspended`, the organization-wide verdict "may not run", with its consequences: the
session stops and its key is revoked, and the Control Plane answers 402. On the gateway channel there is
no verdict, only a refused request; the code chooses wording there and changes no state (§5). `unavailable` is the key server unable to answer at all, and
keeps the degradation window. A lapse is an answer: the issuer's own rule says an organization whose
standing was not renewed may not run, much as a lease that ran out is not an unknown lease. An issuer
that would rather keep organizations running through a renewal gap does not refuse them, and sends no
code at all.

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
1.19.6. The same holds at 423 with `[ERR:standing_lapsed]`, behind `API Error: 423` and
`unexpected status 423 Locked:`.

| Runtime          | Text handed up                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Claude Code      | `API Error: 402 [ERR:out_of_credits] Out of AgentConnect credits`                                  |
| Codex            | `unexpected status 402 Payment Required: [ERR:out_of_credits] Out of AgentConnect credits, url: …` |
| DeepSeek Harness | `turn failed: [ERR:out_of_credits] Out of AgentConnect credits`                                    |
| OpenCode         | `[ERR:out_of_credits] Out of AgentConnect credits`                                                 |

The measurement is a one-off probe outside this repository, against four runtimes at pinned versions;
the catalog has more, and an adapter bump can change its decoration without notice. The reader PR adds
these four texts as fixtures, and a runtime's row is measured again when its adapter changes how it
reports a provider error.

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
- **On the gateway channel, look for a tag only in a session whose credential the key server issued.**
  On an install with no key server, provider or proxy text that happens to contain a tag would otherwise
  produce an "add credit" notice for a billing page that does not exist.
- **Parse once, at the boundary AgentConnect owns.** In-band text is needed only where a runtime or the
  strict `KeyServerErrorBody` stands in between. Past that point the code travels as a field: the
  Control Plane's 402 body, the acquire `failed` answer and the daemon's hook report carry the parsed
  code, so the tag stays out of the public REST surface and out of every other reader's parser.
- **Map codes to the turn failure classification by code, not by wording.** The daemon already
  classifies failed turns from provider-authored text (`turnFailureCode`, hook reason
  `provider_quota_exhausted`); an `out_of_credits` refusal is classified from its code, whatever the
  sentence says. The mapping for each code is the reader PR's to state.

**A tag is presentation, never authority.** Gateway text reaches the daemon through a runtime and a
provider endpoint the daemon does not control, so a reader may choose wording from a tag but must not
change state because of one: no marking an organization suspended, no revoking, no stopping other
sessions. Those follow the key server's `org_suspended` verdict, as they do today.

## 6. Rollout

Readers ship first, and issuers tag only after them.

1. **Readers.** The daemon's failure notice, the Control Plane and the console learn the tag (§5). A
   reader that meets an untagged message keeps showing it as written, so this step changes nothing until
   an issuer tags.
2. **Issuers.** An issuer starts tagging once the readers it serves read the tag, and only then drops
   links and instructions from its sentence.

A reader that predates the tag shows a tagged message as written: `[ERR:out_of_credits] Out of
AgentConnect credits`, with no pointer to where credit is added. Not every such reader is one an issuer
can wait for: `computer-pool/acquire` hands the message to whichever daemon the agent runs on, and a
self-hosted daemon upgrades on its own schedule. An issuer therefore accepts that degradation for old
readers when it switches: the text still says what happened, and the tag is short enough to read past.
An issuer that cannot accept it keeps its links in the sentence after the tag until it can; the tag
leads either way.

## 7. Alternatives considered

**A structured field instead of a tag.** `KeyServerErrorBody` is strict: a new field such as
`error.reason` is rejected by every reader that predates it, and the refusal would surface as an
unattributable error, which §6 of the key-server design exists to prevent. The gateway channel has no
field to add at all: the runtime lifts the provider's message and nothing else. In-band text is the one
carrier every channel and every reader version already passes through. Where AgentConnect owns both
ends (§5), the code does travel as a field.

## 8. Out of scope

- Which reasons a deployment stops organizations for. The registry names reasons once a refuser sends
  them; it does not ask any deployment to.
- Other failures that reach a turn: provider errors, quota refusals that are not about the
  organization's standing (`quota_denied`), and the runtime's own faults keep their current handling.
