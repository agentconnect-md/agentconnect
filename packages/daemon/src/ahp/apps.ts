import { z } from 'zod'
import {
  AhpMessageText,
  McpAppCard,
  McpAppOutcome,
  McpAppRpc,
  McpAppRpcResult,
  type AhpAttachmentAuthorization,
  type AhpSessionBinding
} from '@agentconnect.md/protocol'
import { AhpErrorCodes, JsonRpcErrorCodes } from '@microsoft/agent-host-protocol'
import type { ChatEvent, ChatOutput } from '../session/chat-turn.js'
import { AhpProtocolError } from './connection.js'

const MAX_CARDS = 16
const MAX_META_BYTES = 16 * 1024
const id = z.string().min(1).max(200)
const channel = z.string().min(1).max(1024)
const rpcRequest = z.strictObject({ channel, appId: id, callId: z.string().min(1).max(64), rpc: McpAppRpc })
const closeRequest = z.strictObject({ channel, appId: id })
export interface AhpAppEntry {
  turnId: string
  card: Omit<McpAppCard, 'html'>
  html?: string
  outcome?: McpAppOutcome
}
interface Template {
  next: number
  expected: number
  text: string
}

// Optional presentation state; the existing Apps host remains the authority for every RPC.
export class AhpAppsProjection {
  private entries: AhpAppEntry[] = []
  private readonly templates = new Map<string, Template>()
  constructor(initial: readonly AhpAppEntry[] = []) {
    for (const entry of initial) {
      this.update(entry.turnId, { kind: 'app', ...entry.card, ...(entry.html ? { html: entry.html } : {}) })
      if (entry.outcome)
        this.update(entry.turnId, { kind: 'app_resolved', appId: entry.card.appId, outcome: entry.outcome })
    }
  }
  snapshot(): AhpAppEntry[] {
    return structuredClone(this.entries)
  }
  update(turnId: string, event: ChatEvent): { apps: AhpAppEntry[] } | undefined {
    if (event.kind !== 'app' && event.kind !== 'app_template' && event.kind !== 'app_resolved') return
    const next = this.snapshot()
    const index = next.findIndex((entry) => entry.card.appId === event.appId)
    if (event.kind === 'app') {
      const parsed = McpAppCard.safeParse(event)
      if (!parsed.success || !turnId || turnId.length > 256) throw invalid('Invalid MCP App card')
      const { html, ...card } = parsed.data
      if (card.htmlBytes && card.htmlBytes > MAX_META_BYTES) throw invalid('MCP App template exceeds the AHP limit')
      if (html && card.htmlBytes !== undefined && html.length !== card.htmlBytes)
        throw invalid('Incomplete MCP App template')
      const entry = { turnId, card, ...(html ? { html } : {}) }
      if (index >= 0) next[index] = entry
      else next.push(entry)
      while (next.length > MAX_CARDS) {
        const settled = next.findIndex((item) => item.outcome !== undefined)
        if (settled < 0) throw invalid('Too many MCP App cards')
        next.splice(settled, 1)
      }
      this.assertBounded(next, event.appId)
      this.templates.delete(card.appId)
      if (html === undefined && card.htmlBytes !== undefined)
        this.templates.set(card.appId, { next: 0, expected: card.htmlBytes, text: '' })
    } else {
      const entry = next[index]
      if (!entry) return
      if (event.kind === 'app_resolved') {
        const parsed = McpAppOutcome.safeParse(event.outcome)
        if (!parsed.success) throw invalid('Invalid MCP App outcome')
        entry.outcome = parsed.data
        this.templates.delete(event.appId)
      } else {
        if (entry.outcome !== undefined) return
        const template = this.templates.get(event.appId)
        if (!template) {
          if (entry.html !== undefined) return
          throw invalid('MCP App template was not announced')
        }
        if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw invalid('Invalid MCP App template sequence')
        if (event.seq < template.next) return
        if (event.seq !== template.next) throw invalid('MCP App template sequence gap')
        const html = template.text + event.chunk
        if (html.length > template.expected) throw invalid('MCP App template exceeds its declared length')
        entry.html = html
        this.assertBounded(next, event.appId)
        // Incomplete HTML remains private until the declared character length is present.
        if (html.length < template.expected) {
          this.templates.set(event.appId, { ...template, next: template.next + 1, text: html })
          return
        }
        this.templates.delete(event.appId)
      }
      this.assertBounded(next, event.appId)
    }
    this.entries = next
    return { apps: this.snapshot() }
  }
  // Settled cards give way, oldest first, before the byte budget refuses a live one.
  private assertBounded(entries: AhpAppEntry[], updating: string): void {
    const bytes = () =>
      Buffer.byteLength(
        JSON.stringify({
          apps: entries.map((entry) => {
            const pending = entry.card.appId === updating ? undefined : this.templates.get(entry.card.appId)
            return pending ? { ...entry, html: pending.text } : entry
          })
        })
      )
    while (bytes() > MAX_META_BYTES) {
      const settled = entries.findIndex((item) => item.outcome !== undefined && item.card.appId !== updating)
      if (settled < 0) throw invalid('MCP App metadata exceeds the AHP limit')
      entries.splice(settled, 1)
    }
  }
}

export interface AhpAppsScope {
  authorization: AhpAttachmentAuthorization
  binding: AhpSessionBinding & { sessionId: string }
  isCurrent(): boolean
}
export interface AhpAppsCallbacks {
  rpc(
    scope: AhpAppsScope,
    input: { appId: string; callId: string; rpc: McpAppRpc },
    emit: (output: ChatOutput) => void
  ): Promise<void>
  close(scope: AhpAppsScope, input: { appId: string }): Promise<void>
}
// The connection prepares the channel through the registry before supplying this verified scope.
export async function dispatchAhpAppRequest(
  method: 'agentconnect/appRpc' | 'agentconnect/appClose',
  params: unknown,
  scope: AhpAppsScope,
  callbacks: AhpAppsCallbacks
): Promise<McpAppRpcResult | null> {
  if (method !== 'agentconnect/appRpc' && method !== 'agentconnect/appClose')
    throw new AhpProtocolError(JsonRpcErrorCodes.MethodNotFound, 'Method not supported')
  if (method === 'agentconnect/appClose') {
    const parsed = closeRequest.safeParse(params)
    if (!parsed.success) throw invalid('Invalid MCP App request')
    assertCurrent(scope, parsed.data.channel)
    await callbacks.close(scope, { appId: parsed.data.appId })
    assertCurrent(scope, parsed.data.channel)
    return null
  }
  const parsed = rpcRequest.safeParse(params)
  if (!parsed.success) throw invalid('Invalid MCP App request')
  const request = parsed.data
  assertCurrent(scope, request.channel)
  let answer: McpAppRpcResult | undefined
  await callbacks.rpc(scope, { appId: request.appId, callId: request.callId, rpc: request.rpc }, (output) => {
    const event = output.event
    if (
      answer !== undefined ||
      output.conversationId !== scope.binding.conversationId ||
      event?.kind !== 'app_rpc_result' ||
      event.appId !== request.appId ||
      event.callId !== request.callId
    )
      return
    const result = McpAppRpcResult.safeParse(event.outcome)
    if (!result.success) throw invalid('Invalid MCP App response')
    if (!AhpMessageText.safeParse(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(256), result: result.data })).success)
      throw invalid('MCP App response exceeds the AHP limit')
    answer = result.data
  })
  assertCurrent(scope, request.channel)
  if (answer === undefined) throw new AhpProtocolError(JsonRpcErrorCodes.InternalError, 'MCP App did not answer')
  return answer
}
function assertCurrent(scope: AhpAppsScope, requested: string): void {
  const { authorization, binding } = scope
  const chat = `ahp-chat:${binding.sessionUri.slice('ahp-session:'.length)}/main`
  if (
    !scope.isCurrent() ||
    (requested !== binding.sessionUri && requested !== chat) ||
    (authorization.conversationId !== undefined && authorization.conversationId !== binding.conversationId) ||
    (authorization.targetSessionId !== undefined && authorization.targetSessionId !== binding.sessionId)
  )
    throw new AhpProtocolError(AhpErrorCodes.PermissionDenied, 'MCP App access denied')
}
function invalid(message: string): AhpProtocolError {
  return new AhpProtocolError(JsonRpcErrorCodes.InvalidParams, message)
}
