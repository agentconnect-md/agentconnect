/**
 * Arm B of the tool-surface A/B: a `post` façade over the landed `sendMessage`.
 *
 * This implements the write primitive of `docs/designs/messaging-primitives.md`
 * §2.2 as an EVALUATION-ONLY tool. It is a façade and nothing more: every call
 * compiles into exactly one legal `sendMessage` input and is executed by the
 * product tool itself (`callProductTool`). No routing, activation, addressing or
 * policy code is touched — the two arms differ ONLY in the schema and
 * description the model carries, which is the whole point of the experiment.
 *
 * The design claim under test is that the target union is really three
 * orthogonal dimensions:
 *
 *   conversation   which exchange this post belongs to
 *   address        who it is addressed to (structured, never parsed from prose)
 *   visibility     whether it has a platform projection
 *
 * so the "exactly one target mode, and here are the illegal combinations"
 * rule table becomes unnecessary rather than merely shorter. Every legal
 * `sendMessage` form below has a composition; if a form could not be expressed
 * by compiling to what exists, that is reported as a finding, not patched by
 * changing the product.
 *
 * NOT expressible by EITHER arm, and deliberately out of the experiment: a
 * fully-addressed cross-room handoff into an existing THREAD. The routing
 * rework removed `thread` from every `sendMessage` target (baseline §6.4), so
 * the façade has nothing to compile it to. Including it would measure a known
 * product gap rather than the two surfaces.
 */
import type { EvaluationToolDefinition } from '../../packages/daemon/src/evaluation/index.js'

/** One compiled call: the `sendMessage` input a `post` reduces to. */
export interface CompiledPost {
  args: Record<string, unknown>
  /** Which of the six legal `sendMessage` forms this became. */
  form: 'agent-channel' | 'agent-postless' | 'user-dm' | 'user-channel' | 'channel-bare' | 'parent-session'
}

export class PostCompileError extends Error {}

interface PostInput {
  conversation?: unknown
  message?: unknown
  address?: unknown
  visibility?: unknown
  expectReply?: unknown
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PostCompileError(`post: "${field}" must be a non-empty string`)
  }
  return value
}

/**
 * Compile one `post` into the single `sendMessage` input that expresses it.
 *
 * Pure and total: it either yields a legal product call or throws a message that
 * names what was wrong. It never guesses — an under-specified post is an error,
 * because silently picking a target is exactly the failure mode a surface A/B
 * is supposed to detect.
 */
export function compilePost(input: PostInput): CompiledPost {
  const message = str(input.message, 'message')
  const conversation = input.conversation
  if (conversation === null || typeof conversation !== 'object') {
    throw new PostCompileError('post: "conversation" must be an object naming where the post belongs')
  }
  const kind = str((conversation as { kind?: unknown }).kind, 'conversation.kind')
  const visibility = input.visibility === undefined ? 'visible' : str(input.visibility, 'visibility')
  if (visibility !== 'visible' && visibility !== 'session-only') {
    throw new PostCompileError('post: "visibility" must be "visible" or "session-only"')
  }
  const address = input.address === undefined ? [] : input.address
  if (!Array.isArray(address) || address.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new PostCompileError('post: "address" must be an array of ids')
  }
  const addresses = address as string[]

  switch (kind) {
    case 'channel': {
      const channel = str((conversation as { channel?: unknown }).channel, 'conversation.channel')
      if (visibility === 'session-only') {
        throw new PostCompileError(
          'post: a conversation in a channel is always visible; use conversation.kind "private" for a ' +
            'session-only address'
        )
      }
      if (addresses.length === 0) return { args: { channel, message }, form: 'channel-bare' }
      const agents = addresses.filter((id) => isAgentId(id))
      if (agents.length > 0) {
        if (addresses.length > 1) {
          throw new PostCompileError('post: a channel post can address at most one agent')
        }
        return {
          args: { toAgent: agentTarget(agents[0]!, input.expectReply), channel, message },
          form: 'agent-channel'
        }
      }
      return {
        args: { toUser: addresses.length === 1 ? addresses[0]! : addresses, channel, message },
        form: 'user-channel'
      }
    }
    case 'private': {
      if (addresses.length !== 1) {
        throw new PostCompileError('post: a private conversation addresses exactly one agent')
      }
      if (visibility !== 'session-only') {
        throw new PostCompileError(
          'post: a private conversation has no platform projection; set visibility "session-only"'
        )
      }
      return { args: { toAgent: agentTarget(addresses[0]!, input.expectReply), message }, form: 'agent-postless' }
    }
    case 'dm': {
      const user = str((conversation as { user?: unknown }).user, 'conversation.user')
      return { args: { toUser: user, message }, form: 'user-dm' }
    }
    case 'parent': {
      const sessionId = str((conversation as { sessionId?: unknown }).sessionId, 'conversation.sessionId')
      return { args: { sessionId, message }, form: 'parent-session' }
    }
    default:
      throw new PostCompileError(
        `post: unknown conversation.kind "${kind}" (expected "channel", "private", "dm" or "parent")`
      )
  }
}

/** Agent ids in the arena (and in production) are UUIDs; platform member ids are
 *  not. The façade needs the distinction only to pick which product field a
 *  channel address compiles into — the product still authorizes it. */
function isAgentId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function agentTarget(agentId: string, expectReply: unknown): unknown {
  return expectReply === true ? { agentId, needsReply: true } : agentId
}

/** The `post` descriptor — arm B's entire surface. */
export const POST_TOOL_DESCRIPTOR = {
  name: 'post',
  description:
    'Send one message. Three independent choices: WHICH conversation, WHO it addresses, and whether it is ' +
    'visible on the platform.\n' +
    'To speak in the conversation you are already in, do NOT use this tool — write your ordinary turn reply.\n' +
    '- `conversation` — where the post belongs:\n' +
    '  • `{"kind":"channel","channel":"<channel id>"}` — a new conversation at that channel’s root.\n' +
    '  • `{"kind":"private"}` — a new private conversation with the agent you address (nothing is posted).\n' +
    '  • `{"kind":"dm","user":"<platform user id>"}` — your direct message with that human.\n' +
    '  • `{"kind":"parent","sessionId":"<Parent session>"}` — the conversation that woke you.\n' +
    '- `address` — ids this post is addressed to: agent ids (from `listAgents`) or human platform ids. ' +
    'Omit it to address nobody.\n' +
    '- `visibility` — `"visible"` (default) or `"session-only"` for a post with no platform projection.\n' +
    'Set `expectReply: true` when you address an agent and need its answer back.\n' +
    'Write `message` as CommonMark/GFM. The daemon supplies your identity; you cannot impersonate anyone.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      conversation: {
        type: 'object' as const,
        description: 'Which conversation this post belongs to.',
        properties: {
          kind: { type: 'string', enum: ['channel', 'private', 'dm', 'parent'] },
          channel: { type: 'string', description: 'Channel id, for kind "channel".' },
          user: { type: 'string', description: 'Human platform id, for kind "dm".' },
          sessionId: { type: 'string', description: 'Parent session id, for kind "parent".' }
        },
        required: ['kind']
      },
      address: {
        type: 'array' as const,
        items: { type: 'string' },
        description: 'Ids this post addresses: agent ids or human platform ids. Omit to address nobody.'
      },
      visibility: {
        type: 'string' as const,
        enum: ['visible', 'session-only'],
        description: 'Whether the post has a platform projection. Defaults to "visible".'
      },
      expectReply: {
        type: 'boolean' as const,
        description: 'Set true when you address an agent and need its answer back.'
      },
      message: { type: 'string' as const, description: 'The message body, as CommonMark/GFM.' }
    },
    required: ['conversation', 'message'],
    additionalProperties: false as const
  }
}

/** Build arm B's registry entry. Every call compiles and is then executed by the
 *  PRODUCT tool, so the two arms share one implementation. */
export function postFacadeTool(options: {
  visibleTo?: (agentId: string) => boolean
  onCall?: (record: {
    agentId: string
    input: Record<string, unknown>
    outcome: 'compiled' | 'invalid'
    form?: string
    error?: string
  }) => void
}): EvaluationToolDefinition {
  return {
    descriptor: POST_TOOL_DESCRIPTOR,
    visibleTo: options.visibleTo ?? (() => true),
    handler: async ({ agentId, input, callProductTool }) => {
      let compiled: CompiledPost
      try {
        compiled = compilePost(input as PostInput)
      } catch (error) {
        options.onCall?.({ agentId, input, outcome: 'invalid', error: (error as Error).message })
        // Surfaced to the model exactly as the product surfaces its own refusals.
        throw error
      }
      options.onCall?.({ agentId, input, outcome: 'compiled', form: compiled.form })
      return callProductTool('sendMessage', compiled.args)
    }
  }
}
