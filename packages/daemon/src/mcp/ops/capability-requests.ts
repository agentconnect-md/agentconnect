// `requestCapability` and `withdrawCapabilityRequest` (capability-requests.md §4.1): the agent asks for what its setup lacks; a person completes it in the console.
import { CAPABILITY_REASON_MAX, CapabilityAsk, CapabilityKind } from '@agentconnect.md/protocol'
import { z } from 'zod'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { parseArgs, requiredString } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'
import {
  isCheckCoordinate,
  isGettingToKnowCoordinate,
  isResearchCoordinate
} from '../../session/subsession-coordinate.js'

export interface CapabilityRequestDeps {
  capabilityRequests?: {
    /** Whether this session may ask right now: the CP serves it, the agent is offered it, and the session is not a check. */
    offered(ctx: SessionContext): boolean
    request(ctx: SessionContext, ask: CapabilityAsk, reason: string): Promise<unknown>
    withdraw(ctx: SessionContext, requestId: string): Promise<unknown>
  }
}

const KIND_MESSAGE = `argument kind must be one of ${CapabilityKind.options.join(', ')}`

export const REQUEST_CAPABILITY_ARGS = z
  .object({
    kind: z.enum(CapabilityKind.options, KIND_MESSAGE),
    want: z.record(z.string(), z.unknown(), 'argument want must be an object'),
    reason: requiredString('reason').max(
      CAPABILITY_REASON_MAX,
      `argument reason must be at most ${CAPABILITY_REASON_MAX} characters`
    )
  })
  .transform((args, ctx) => {
    // Unknown fields are refused, not ignored (§4.2).
    const parsed = CapabilityAsk.safeParse({ kind: args.kind, want: args.want })
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({
          code: 'custom',
          message: `argument want: ${[...issue.path.slice(1), issue.message].join(': ')}`
        })
      return z.NEVER
    }
    return { ask: parsed.data, reason: args.reason.trim() }
  })

export const WITHDRAW_CAPABILITY_REQUEST_ARGS = z.object({
  requestId: requiredString('requestId').max(64, 'argument requestId must be at most 64 characters')
})

export const REQUEST_CAPABILITY_TOOL: ToolDescriptor = {
  name: 'requestCapability',
  description:
    'Ask for something your own setup lacks when it stops you from doing what you were asked, or that someone in ' +
    'this conversation asks you to change about yourself: a setting (your runtime included), a scheduled task, an ' +
    'organization MCP server, a skill, access to a repository, a connection, or a secret. This grants nothing: a ' +
    'person who can change your setup completes or declines it in AgentConnect, and you are woken in this ' +
    'conversation when they do. It returns at once; follow the `message` it returns, then stop the work that needs ' +
    'it and end your turn. Ask only for what the task needs, once; asking again for the same thing returns the open ' +
    'request. A secret is asked for by name and purpose only: never put a secret, token or password in any ' +
    'argument, never ask anyone to paste one into the conversation, and if someone pastes one anyway, tell them to ' +
    'rotate it and to enter the new value through the request link instead. For a credential an HTTP API takes, ' +
    'prefer route `mcp-header` on the MCP server that calls it, so you never see the value. Use route `live` only ' +
    'for a credential your own shell or code needs (a CLI token, a kubeconfig): once set, load it per command with ' +
    '`agentconnect-secrets exec --only NAME -- <command>`, and never print it.',
  inputSchema: obj(
    {
      kind: {
        type: 'string',
        enum: [...CapabilityKind.options],
        description:
          '`agent-settings` (any field of your agent form), `cron` (a scheduled task that runs you), `mcp-server` (an ' +
          'organization MCP server added to your tools), `skill` (a skill added to your setup), `repository` (read ' +
          'or write access to a GitHub or GitLab repository), `connection` (an MCP server signed in, a code host ' +
          'connected, or a chat integration added), or `secret` (a credential set where you need it).'
      },
      want: {
        type: 'object',
        description:
          'What you need, by kind. agent-settings: only the fields to change, among model, reasoningEffort, ' +
          'fastMode, outputMode, permissionMode, runtime, execution, chatActions ("talk" | "approve" | "settings"), ' +
          'introduceOnJoin, showFooter, showStatusBar and displayName, e.g. `{"runtime": "codex-acp", ' +
          '"model": "…"}`; a new runtime continues this conversation from a replay of its history. cron: ' +
          '`{"schedule": "<cron expression>", "timezone": "<IANA zone>", "trigger": "<the prompt it runs>"}`, plus ' +
          '`"cronId"` to change one of your own. Your workspace, visibility and sharing are not asked for. mcp-server: ' +
          '`{"server": "<name as the organization lists it>"}`. skill: `{"skill": "<source>/<skill>"}`. repository: ' +
          '`{"provider": "github" | "gitlab", "repository": "<owner>/<repo>", "access": "read" | "write"}` (add ' +
          '`"host"` for a self-managed GitLab). connection: `{"type": "mcp-oauth", "server": "<name>"}`, ' +
          '`{"type": "code-host", "provider": "github" | "gitlab"}` or `{"type": "chat-integration", "platform": ' +
          '"<platform>"}`. secret: `{"name": "<header or VARIABLE_NAME>", "description": "<what goes in it, never ' +
          'the value>", "use": {"route": "mcp-header", "server": "<MCP server>"}}`, or for a live secret ' +
          '`{"name": "VARIABLE_NAME", "description": "…", "use": {"route": "live"}}`. Other fields are refused.'
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: CAPABILITY_REASON_MAX,
        description: 'One sentence saying why the task needs it, shown to the person who decides. Plain text.'
      }
    },
    ['kind', 'want', 'reason']
  )
}

export const WITHDRAW_CAPABILITY_REQUEST_TOOL: ToolDescriptor = {
  name: 'withdrawCapabilityRequest',
  description:
    'Withdraw an open request you made with requestCapability when you no longer need it. Its card here says so ' +
    'and nobody is woken.',
  inputSchema: obj(
    { requestId: { type: 'string', minLength: 1, description: 'The requestId requestCapability returned.' } },
    ['requestId']
  )
}

export const CAPABILITY_REQUEST_TOOLS: ToolDescriptor[] = [REQUEST_CAPABILITY_TOOL, WITHDRAW_CAPABILITY_REQUEST_TOOL]

/** The tools a session is offered: only an agent in assistant mode, toward a CP that serves them (§5). */
export function capabilityRequestToolsFor(served: boolean, at: { thread: string }): ToolDescriptor[] {
  // A follow-up's check, organization research and a getting-to-know task change nothing through AgentConnect, so they never list it.
  const narrowed =
    isCheckCoordinate(at.thread) || isResearchCoordinate(at.thread) || isGettingToKnowCoordinate(at.thread)
  return served && !narrowed ? CAPABILITY_REQUEST_TOOLS : []
}

function portOf(ctx: SessionContext, deps: CapabilityRequestDeps, name: string) {
  const port = deps.capabilityRequests
  if (!port?.offered(ctx)) throw new Error(`${name} is not available in this session`)
  return port
}

export const requestCapability: ToolHandler<CapabilityRequestDeps> = async (ctx, args, deps) => {
  const { ask, reason } = parseArgs(REQUEST_CAPABILITY_ARGS, args)
  return await portOf(ctx, deps, 'requestCapability').request(ctx, ask, reason)
}

export const withdrawCapabilityRequest: ToolHandler<CapabilityRequestDeps> = async (ctx, args, deps) => {
  const { requestId } = parseArgs(WITHDRAW_CAPABILITY_REQUEST_ARGS, args)
  return await portOf(ctx, deps, 'withdrawCapabilityRequest').withdraw(ctx, requestId)
}
