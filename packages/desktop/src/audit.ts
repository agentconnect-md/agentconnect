import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface AuditRecord {
  client: string
  tool: string
  args: Record<string, unknown>
  outcome: 'ok' | 'error'
  code?: string
  ms: number
}

export type AuditSink = (record: AuditRecord) => void

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
