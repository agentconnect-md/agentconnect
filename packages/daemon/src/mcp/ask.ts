/** MCP-side elicitation (#1965 Gap A): a daemon bridge tool asks the agent's OWN host instead of guessing. */

/** One offered choice; `label` is the host-rendered text when every option carries one. */
export interface AskOption {
  value: string
  label?: string
}

/** One field of an ask — only the primitives MCP's restricted elicitation schema can express. */
export type AskField =
  | { kind: 'text'; title?: string; description?: string }
  | { kind: 'confirm'; title?: string; description?: string }
  | { kind: 'choice'; title?: string; description?: string; options: AskOption[] }

/** What a tool wants to know: one prompt plus a flat set of fields. */
export interface AskSpec {
  message: string
  fields: Record<string, AskField>
  /** Field names the host must fill; omitted ⇒ every field is optional. */
  required?: string[]
}

/** A property of an emitted `requestedSchema`. `title`/`description`/`oneOf` are property-level only. */
export type AskProperty =
  | { type: 'string'; title?: string; description?: string }
  | { type: 'boolean'; title?: string; description?: string }
  | { type: 'string'; title?: string; description?: string; enum: string[] }
  | { type: 'string'; title?: string; description?: string; oneOf: { const: string; title: string }[] }

/** The wire schema of an ask. NO root key beyond these three: codex re-parses it with a deny-unknown-fields type and a root `title` alone kills the forward inside codex core before ACP ever sees it. */
export interface AskRequestedSchema {
  type: 'object'
  properties: Record<string, AskProperty>
  required?: string[]
}

/** The ask as it travels to the bridge, which turns it into the SDK's `input_required` return. */
export interface AskWire {
  key: string
  message: string
  requestedSchema: AskRequestedSchema
}

/** What the host answered on an earlier round of THIS tool call. */
export type AskAnswer =
  { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' }

/** What the agent host can render, read from its `initialize` client capabilities. */
export interface AskModes {
  form: boolean
  url: boolean
}

/** The per-call ask surface handed to a tool. Absent ⇒ this connection cannot ask at all. */
export interface AskPort {
  answer(key: string): AskAnswer | undefined
}

/** The deps slice a tool that can ask declares. */
export interface AskDeps {
  /** Present only when the bridge reported a host that renders elicitation forms; absent ⇒ keep the previous guess-or-fail behaviour. THE REPLAY RULE: the answer arrives on a FRESH tool call that re-runs the handler from the top — turn gate, approval gate and tool body alike — so a tool may only ask BEFORE it does observable work, or must be safe to replay. */
  ask?: AskPort
}

/** The outcome of {@link askHost} when it does NOT need another round. */
export type AskOutcome =
  { state: 'unavailable' } | { state: 'answered'; content: Record<string, unknown> } | { state: 'refused' }

/** Thrown by {@link askHost} to make the ask: `McpControlServer` turns it into the bridge's `input_required` return. Tools must NOT catch it. */
export class AskRequired extends Error {
  constructor(readonly ask: AskWire) {
    super(`waiting on the agent host's answer to "${ask.key}"`)
    this.name = 'AskRequired'
  }
}

/** The property for one field. A choice emits titled `oneOf` only when EVERY option is labelled. */
function propertyFor(field: AskField): AskProperty {
  const chrome = {
    ...(field.title !== undefined ? { title: field.title } : {}),
    ...(field.description !== undefined ? { description: field.description } : {})
  }
  if (field.kind === 'confirm') return { type: 'boolean', ...chrome }
  if (field.kind === 'text') return { type: 'string', ...chrome }
  if (field.options.length > 0 && field.options.every((o) => o.label !== undefined)) {
    return { type: 'string', ...chrome, oneOf: field.options.map((o) => ({ const: o.value, title: o.label! })) }
  }
  return { type: 'string', ...chrome, enum: field.options.map((o) => o.value) }
}

/** Reduce a spec to the restricted wire schema. Exported for the emission tests. */
export function askRequestedSchema(spec: AskSpec): AskRequestedSchema {
  const properties: Record<string, AskProperty> = {}
  for (const [name, field] of Object.entries(spec.fields)) properties[name] = propertyFor(field)
  const required = spec.required?.filter((name) => name in properties) ?? []
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** Ask the agent's own host one question, or read the answer it already gave: `unavailable` ⇒ this connection cannot ask and the caller keeps its previous behaviour, `refused` ⇒ a human declined or cancelled (a usable outcome, never an exception), and no answer yet ⇒ {@link AskRequired}. See {@link AskDeps.ask} for the replay rule. */
export function askHost(port: AskPort | undefined, key: string, spec: AskSpec): AskOutcome {
  if (!port) return { state: 'unavailable' }
  const answer = port.answer(key)
  if (!answer) throw new AskRequired({ key, message: spec.message, requestedSchema: askRequestedSchema(spec) })
  return answer.action === 'accept' ? { state: 'answered', content: answer.content } : { state: 'refused' }
}

/** The modes a client's declaration supports, by the server SDK's own lenient pre-mode rule (`isImpliedCapabilityMember`): a BARE `elicitation: {}` counts as form support, which is exactly what the Claude harness sends — a strict `elicitation.form` read would silently disable every ask on that runtime while codex kept working. */
export function askModes(capabilities: { elicitation?: unknown } | undefined): AskModes | undefined {
  const declared = capabilities?.elicitation
  if (declared === undefined || declared === null) return undefined
  const modes = typeof declared === 'object' ? (declared as { form?: unknown; url?: unknown }) : {}
  const url = modes.url !== undefined
  const form = modes.form !== undefined || !url
  return { form, url }
}
