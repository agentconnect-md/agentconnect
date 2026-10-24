import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ComputerApprovalResult } from '@agentconnect.md/protocol/computer'

/** Who a call came from beyond its lease holder name, and how its agent daemon approved it (computer-use.md §4.2). */
export interface CallContext {
  agentId?: string
  sessionId?: string
  approval?: ComputerApprovalResult
}

const callContext = new AsyncLocalStorage<CallContext>()

/** Run one tool call with its caller's context, which every audit record it writes carries. */
export const withCallContext = <T>(context: CallContext, fn: () => T): T => callContext.run(context, fn)

/** The context of the tool call running now, or an empty one outside any call. */
export const currentCallContext = (): CallContext => callContext.getStore() ?? {}

export interface AuditRecord extends CallContext {
  client: string
  tool: string
  args: Record<string, unknown>
  outcome: 'ok' | 'error'
  code?: string
  ms: number
  // The stored screenshot this call returned (computer-use.md §9).
  screenshotRef?: string
}

export type AuditSink = (record: AuditRecord) => void

/** Fan one record out to several sinks, each with the context of the call that wrote it. */
export function auditSinks(...sinks: AuditSink[]): AuditSink {
  return (record) => {
    const full = { ...callContext.getStore(), ...record }
    for (const sink of sinks) sink(full)
  }
}

// Typed text and clipboard values are recorded by length only.
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = (key === 'text' || key === 'value') && typeof value === 'string' ? `<${value.length} chars>` : value
  }
  return out
}

export function fileAuditSink(path: string): AuditSink {
  mkdirSync(dirname(path), { recursive: true })
  return (record) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record, args: redactArgs(record.args) })
    try {
      appendFileSync(path, `${line}\n`)
    } catch (error) {
      console.error(`audit write failed: ${(error as Error).message}`)
    }
  }
}
