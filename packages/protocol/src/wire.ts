import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { Envelope, NIL_UUID, type ControlExt } from './envelope.js'

/**
 * Generic envelope codec — the schema-map-agnostic core shared by every wire.
 *
 * The daemon↔CP wire (`codec.ts` over `FRAME_SCHEMAS`) and the two relay wires
 * (`frames/relay-cp.ts` / `frames/relay-daemon.ts` over their OWN maps) all
 * decode the same envelope shape but accept disjoint frame families — a relay
 * socket must answer a daemon↔CP frame with `UNKNOWN_FRAME`, and vice versa
 * (shared-bot-relay.md §8 "standalone frame union, not mixed into the daemon protocol").
 */

/** Soft cap per frame — 256 KiB (protocol §1). Over this → FRAME_TOO_LARGE. */
export const MAX_FRAME_BYTES = 256 * 1024

/**
 * The optional fencing block read off an inbound frame. Extracted on EVERY
 * wire (the decode core is shared), but only MEANINGFUL on the daemon↔CP wire
 * — the relay wires carry no fencing (dedup is (sessionKey, msgId), design
 * §12), so their dispatch ignores a surfaced `ext` rather than rejecting it.
 */
export interface InboundControlExt {
  epoch?: number
  agentId?: string
  launchId?: string
}

/** Decode verdict for a wire whose fully-validated frame union is `TFrame`. */
export type DecodeResultOf<TFrame> =
  { ok: true; frame: TFrame; ext?: InboundControlExt } | { ok: false; id: string; msg: string; corr?: string }

const textEncoder = new TextEncoder()
function byteLength(text: string): number {
  return textEncoder.encode(text).length
}

function extractControlExt(json: unknown): InboundControlExt | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const o = json as Record<string, unknown>
  const ext: InboundControlExt = {}
  if (typeof o.epoch === 'number') ext.epoch = o.epoch
  if (typeof o.agentId === 'string') ext.agentId = o.agentId
  if (typeof o.launchId === 'string') ext.launchId = o.launchId
  return Object.keys(ext).length > 0 ? ext : undefined
}

/**
 * Decode one wire frame against `schemas` (the wire's `type` → payload map).
 * Two-step parse: envelope first, then the per-type payload schema — an unknown
 * `type` is a typed `UNKNOWN_FRAME` failure (a REP, never a hard close).
 */
export function decodeEnvelopeWith<TFrame>(
  schemas: Record<string, z.ZodTypeAny>,
  text: string
): DecodeResultOf<TFrame> {
  if (byteLength(text) > MAX_FRAME_BYTES) {
    return { ok: false, id: NIL_UUID, msg: 'FRAME_TOO_LARGE' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, id: NIL_UUID, msg: 'invalid json' }
  }
  const env = Envelope.safeParse(json)
  if (!env.success) {
    const id =
      typeof json === 'object' && json !== null && typeof (json as { id?: unknown }).id === 'string'
        ? (json as { id: string }).id
        : NIL_UUID
    return { ok: false, id, msg: env.error.message }
  }
  const schema = Object.hasOwn(schemas, env.data.type) ? schemas[env.data.type] : undefined
  if (!schema) {
    return {
      ok: false,
      id: env.data.id,
      msg: 'UNKNOWN_FRAME',
      ...(env.data.corr ? { corr: env.data.corr } : {})
    }
  }
  const payload = schema.safeParse(env.data.payload)
  if (!payload.success) {
    return {
      ok: false,
      id: env.data.id,
      msg: payload.error.message,
      ...(env.data.corr ? { corr: env.data.corr } : {})
    }
  }
  const ext = extractControlExt(json)
  return {
    ok: true,
    frame: { ...env.data, payload: payload.data } as TFrame,
    ...(ext ? { ext } : {})
  }
}

export interface BuildOpts {
  corr?: string
  id?: string
  ts?: string
  orgId?: string
  ext?: ControlExt
}

/**
 * Wrap a payload in the wire envelope. Untyped core — each wire exports a typed
 * wrapper (`buildEnvelope` / `buildRelayCpFrame` / `buildRelayDaemonFrame`) that
 * pins `type` to its own union and casts the result.
 */
export function buildEnvelopeRaw(type: string, payload: unknown, opts: BuildOpts = {}): unknown {
  return {
    v: 1 as const,
    id: opts.id ?? randomUUID(),
    ts: opts.ts ?? new Date().toISOString(),
    type,
    payload,
    ...(opts.corr ? { corr: opts.corr } : {}),
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
    ...(opts.ext ?? {})
  }
}
