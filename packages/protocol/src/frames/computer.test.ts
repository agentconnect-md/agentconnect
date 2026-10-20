import { describe, expect, it } from 'vitest'
import {
  COMPUTER_CP_FRAME_TYPES,
  ComputerPolicySchema,
  buildComputerCpFrame,
  decodeComputerCpFrame,
  decodeComputerCpFrameTolerant
} from './computer.js'
import { buildRelayCpFrame } from './relay-cp.js'
import { buildEnvelope, decodeEnvelope } from '../codec.js'

const credential = {
  keyId: '1760000000000',
  key: 'A'.repeat(43),
  issuedAt: '2026-10-20T00:00:00.000Z',
  expiresAt: '2026-10-20T00:05:00.000Z'
}

const authOk = {
  computerId: '00000000-0000-4000-8000-000000000001',
  orgId: 'org_1',
  name: 'desk',
  heartbeatSec: 15,
  serverTime: '2026-10-20T00:00:00.000Z',
  credential,
  policy: ComputerPolicySchema.parse({})
}

const lease = {
  leaseId: '00000000-0000-4000-8000-0000000000aa',
  computerId: '00000000-0000-4000-8000-000000000001',
  holder: { sessionId: 'sess-1', agentId: '00000000-0000-4000-8000-0000000000bb', agentName: 'Ops' },
  acquiredAt: '2026-10-20T00:00:00.000Z',
  expiresAt: '2026-10-20T00:30:00.000Z'
}

const roundTrip = (frame: unknown) => decodeComputerCpFrame(JSON.stringify(frame))

describe('computer channel frames', () => {
  it('round-trips every frame type', () => {
    expect(COMPUTER_CP_FRAME_TYPES).toEqual([
      'computer/auth',
      'computer/auth/ok',
      'computer/heartbeat',
      'computer/credential',
      'computer/policy',
      'computer/revoke',
      'computer/lease',
      'computer/relays',
      'error'
    ])
    const frames = [
      buildComputerCpFrame('computer/auth', { apiKey: 'key', desktopDaemonVersion: '0.1.0' }),
      buildComputerCpFrame('computer/auth/ok', authOk),
      buildComputerCpFrame('computer/heartbeat', {
        status: 'online',
        session: 'x11',
        capabilities: { screenshot: true, input: true },
        doctor: { checkedAt: '2026-10-20T00:00:00.000Z', checks: [{ name: 'session', status: 'ok', detail: 'X11' }] }
      }),
      buildComputerCpFrame('computer/credential', { credential }),
      buildComputerCpFrame('computer/policy', { policy: ComputerPolicySchema.parse({ agentMode: 'view' }) }),
      buildComputerCpFrame('computer/revoke', { reason: 'revoked' }),
      buildComputerCpFrame('computer/lease', { lease }),
      buildComputerCpFrame('computer/lease', { lease: null }),
      buildComputerCpFrame('computer/relays', {
        relays: [{ relayId: '00000000-0000-4000-8000-0000000000cc', url: 'wss://relay-0.example.com/rd/ws' }]
      }),
      buildComputerCpFrame('computer/heartbeat', { status: 'busy', lease: { holder: 'sess-1', idleMs: 1200 } }),
      buildComputerCpFrame('error', { code: 'AUTH_FAILED', message: 'no', retryable: false })
    ]
    for (const frame of frames) {
      const decoded = roundTrip(frame)
      expect(decoded.ok, frame.type).toBe(true)
    }
  })

  it('fills capability defaults so a partial report reads complete', () => {
    const decoded = roundTrip(buildComputerCpFrame('computer/heartbeat', { status: 'busy', capabilities: {} }))
    expect(decoded.ok && decoded.frame.type === 'computer/heartbeat' && decoded.frame.payload.capabilities).toEqual({
      screenshot: false,
      input: false,
      textInput: 'full',
      backgroundInput: false,
      accessibilityTree: false,
      viewer: false,
      displays: [],
      permissions: {}
    })
  })

  it('refuses a heartbeat claiming a CP-only status', () => {
    const decoded = roundTrip(buildComputerCpFrame('computer/heartbeat', { status: 'revoked' as never }))
    expect(decoded.ok).toBe(false)
  })

  it('refuses a credential whose key is not 32 base64url bytes', () => {
    const decoded = roundTrip(
      buildComputerCpFrame('computer/credential', { credential: { ...credential, key: 'short' } })
    )
    expect(decoded.ok).toBe(false)
  })

  it('answers a frame from another wire as UNKNOWN_FRAME', () => {
    const decoded = roundTrip(buildRelayCpFrame('rc/heartbeat', {}))
    expect(decoded).toMatchObject({ ok: false, msg: 'UNKNOWN_FRAME' })
  })

  it('reads the CP strictly from the desktop but tolerates a key a newer CP adds', () => {
    const frame = buildComputerCpFrame('computer/auth/ok', authOk) as { payload: Record<string, unknown> }
    frame.payload.futureField = 1
    expect(decodeComputerCpFrameTolerant(JSON.stringify(frame)).ok).toBe(true)
    const extraAuth = buildComputerCpFrame('computer/auth', { apiKey: 'k', desktopDaemonVersion: '1' }) as {
      payload: Record<string, unknown>
    }
    extraAuth.payload.machineId = 'x'
    expect(decodeComputerCpFrame(JSON.stringify(extraAuth)).ok).toBe(false)
  })

  it('keeps the lease refinement when read tolerantly', () => {
    const frame = buildComputerCpFrame('computer/policy', {
      policy: { ...ComputerPolicySchema.parse({}), leaseIdleSeconds: 900, leaseMaxSeconds: 600 }
    })
    expect(decodeComputerCpFrameTolerant(JSON.stringify(frame)).ok).toBe(false)
  })
})

describe('computer control lease frames', () => {
  it('refuses a heartbeat lease report with a negative idle time', () => {
    const decoded = roundTrip(
      buildComputerCpFrame('computer/heartbeat', { status: 'busy', lease: { holder: 's', idleMs: -1 } })
    )
    expect(decoded.ok).toBe(false)
  })

  it('carries a refusal naming the holder on the daemon wire', () => {
    const holder = { sessionId: 'sess-1', agentId: '00000000-0000-4000-8000-0000000000bb' }
    const decoded = decodeEnvelope(
      JSON.stringify(
        buildEnvelope('computer-lease/acquire/result', {
          granted: false,
          code: 'computer_busy',
          message: 'busy',
          holder
        })
      )
    )
    expect(decoded.ok && decoded.frame.payload).toEqual({
      granted: false,
      code: 'computer_busy',
      message: 'busy',
      holder
    })
    const unknownCode = decodeEnvelope(
      JSON.stringify(
        buildEnvelope('computer-lease/acquire/result', { granted: false, code: 'nope' as never, message: 'x' })
      )
    )
    expect(unknownCode.ok).toBe(false)
  })
})
