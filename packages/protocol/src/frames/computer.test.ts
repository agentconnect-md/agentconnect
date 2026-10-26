import { describe, expect, it } from 'vitest'
import {
  COMPUTER_AUDIT_FEATURE,
  COMPUTER_SCREENSHOT_FEATURE,
  computerScreenshotRef,
  parseComputerScreenshotRef,
  COMPUTER_CP_FRAME_TYPES,
  computerAuditArgs,
  computerAuditText,
  ComputerPolicySchema,
  agentAccessGrants,
  normalizeAgentAccess,
  buildComputerCpFrame,
  decodeComputerCpFrame,
  decodeComputerCpFrameTolerant,
  ComputerEgress
} from './computer.js'
import { buildRelayCpFrame } from './relay-cp.js'
import {
  AGENT_COMPUTERS_MAX,
  AgentComputerSetting,
  AgentComputerUse,
  agentComputerUseOf
} from '../agent-computer-use.js'
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

const auditEntry = {
  id: '00000000-0000-4000-8000-0000000000dd',
  at: '2026-10-20T00:00:01.000Z',
  tool: 'computer_type',
  client: '00000000-0000-4000-8000-0000000000bb/sess-1',
  agentId: '00000000-0000-4000-8000-0000000000bb',
  sessionId: 'sess-1',
  outcome: 'ok' as const,
  approval: 'allowed' as const,
  args: {},
  textLength: 6,
  ms: 40
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
      'computer/stop',
      'computer/egress',
      'computer/admin-prompts',
      'computer/admin-prompts/ok',
      'computer/audit',
      'computer/audit/ok',
      'computer/screenshot/put',
      'computer/screenshot/put/ok',
      'computer/screenshot/commit',
      'computer/screenshot/commit/ok',
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
      buildComputerCpFrame('computer/policy', {
        policy: ComputerPolicySchema.parse({ screenshotRetentionDays: 7 }),
        screenshotRetentionDays: 7
      }),
      buildComputerCpFrame('computer/revoke', { reason: 'revoked' }),
      buildComputerCpFrame('computer/lease', { lease }),
      buildComputerCpFrame('computer/lease', { lease: null }),
      buildComputerCpFrame('computer/relays', {
        relays: [{ relayId: '00000000-0000-4000-8000-0000000000cc', url: 'wss://relay-0.example.com/rd/ws' }]
      }),
      buildComputerCpFrame('computer/stop', { stop: { at: '2026-10-20T00:00:00.000Z' } }),
      buildComputerCpFrame('computer/stop', { stop: null }),
      buildComputerCpFrame('computer/egress', { egress: { mode: 'direct' } }),
      buildComputerCpFrame('computer/egress', {
        egress: { mode: 'proxy', url: 'http://proxy.example.com:8080', username: 'u', password: 'p' }
      }),
      buildComputerCpFrame('computer/admin-prompts', { mode: 'agent' }),
      buildComputerCpFrame('computer/admin-prompts/ok', { mode: 'agent' }),
      buildComputerCpFrame('computer/policy', {
        policy: ComputerPolicySchema.parse({ approvals: { firstInputPerSession: true, adminPrompts: 'deny' } })
      }),
      buildComputerCpFrame('computer/heartbeat', { status: 'busy', lease: { holder: 'sess-1', idleMs: 1200 } }),
      buildComputerCpFrame('computer/auth/ok', { ...authOk, features: [COMPUTER_AUDIT_FEATURE] }),
      buildComputerCpFrame('computer/auth/ok', {
        ...authOk,
        features: [COMPUTER_SCREENSHOT_FEATURE],
        screenshotRetentionDays: 30
      }),
      buildComputerCpFrame('computer/audit', { entries: [auditEntry] }),
      buildComputerCpFrame('computer/audit/ok', { stored: 1 }),
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

describe('computer audit frames', () => {
  it('keeps typed text by its length only', () => {
    expect(computerAuditArgs({ text: 'héllo\n' })).toEqual({ args: {}, textLength: 6 })
    expect(computerAuditArgs({ element_token: 'e1', value: 'secret' })).toEqual({
      args: { element_token: 'e1' },
      textLength: 6
    })
    expect(computerAuditArgs({ keys: ['ctrl', 's'] })).toEqual({ args: { keys: ['ctrl', 's'] } })
  })

  it('bounds the argument summary', () => {
    expect(computerAuditArgs({ app: 'a'.repeat(600) }).args).toEqual({ app: 'a'.repeat(256) })
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(100)]))
    expect(computerAuditArgs(many).args).toEqual({ truncated: true })
  })

  it('cleans every string a store could refuse, keys and nested values included', () => {
    expect(
      computerAuditArgs({ 'a\u0000pp': 'fire\u0000fox', keys: [' re\u0007turn'], deep: { x: ['\udc00y'] } }).args
    ).toEqual({
      app: 'firefox',
      keys: [' return'],
      deep: { x: ['\ufffdy'] }
    })
    expect(computerAuditText('tab\tand\nline\u007f')).toBe('tab\tand\nline')
  })

  it('refuses an entry with an unknown field or an empty batch', () => {
    const extra = buildComputerCpFrame('computer/audit', { entries: [{ ...auditEntry, text: 'hi' } as never] })
    expect(roundTrip(extra).ok).toBe(false)
    expect(roundTrip(buildComputerCpFrame('computer/audit', { entries: [] })).ok).toBe(false)
  })
})

describe('computer screenshot frames', () => {
  const sha256 = 'ab'.repeat(32)
  const put = {
    sessionId: 'ses-1',
    agentId: '11111111-1111-4111-8111-111111111111',
    sha256,
    bytes: 1024,
    contentType: 'image/png' as const,
    takenAt: '2026-10-20T00:00:00.000Z'
  }

  it('names a screenshot by its content hash', () => {
    expect(COMPUTER_SCREENSHOT_FEATURE).toBe('computer-screenshot-v1')
    expect(parseComputerScreenshotRef(computerScreenshotRef(sha256))).toBe(sha256)
    expect(parseComputerScreenshotRef(`sha256:${'AB'.repeat(32)}`)).toBeUndefined()
    expect(parseComputerScreenshotRef('obj://x')).toBeUndefined()
    expect(parseComputerScreenshotRef(undefined)).toBeUndefined()
  })

  it('round-trips the put and commit exchange', () => {
    expect(roundTrip(buildComputerCpFrame('computer/screenshot/put', put)).ok).toBe(true)
    const ok = buildComputerCpFrame('computer/screenshot/put/ok', {
      status: 'upload',
      url: 'https://bucket.example/key?X-Amz-Signature=x',
      headers: { 'content-length': '1024' },
      expiresAt: '2026-10-20T00:05:00.000Z'
    })
    expect(roundTrip(ok).ok).toBe(true)
    expect(roundTrip(buildComputerCpFrame('computer/screenshot/commit', { sessionId: 'ses-1', sha256 })).ok).toBe(true)
    expect(roundTrip(buildComputerCpFrame('computer/screenshot/commit/ok', { stored: true })).ok).toBe(true)
  })

  it('refuses a put with a malformed hash, an unknown type or an unknown field', () => {
    expect(roundTrip(buildComputerCpFrame('computer/screenshot/put', { ...put, sha256: 'x' })).ok).toBe(false)
    expect(
      roundTrip(buildComputerCpFrame('computer/screenshot/put', { ...put, contentType: 'image/gif' as never })).ok
    ).toBe(false)
    expect(roundTrip(buildComputerCpFrame('computer/screenshot/put', { ...put, key: 'x' } as never)).ok).toBe(false)
  })

  it('bounds the policy retention', () => {
    expect(ComputerPolicySchema.parse({}).screenshotRetentionDays).toBeUndefined()
    expect(ComputerPolicySchema.parse({ screenshotRetentionDays: 0 }).screenshotRetentionDays).toBe(0)
    expect(ComputerPolicySchema.safeParse({ screenshotRetentionDays: 4000 }).success).toBe(false)
  })
})

describe('Computer agent access (computer-use.md §4.1)', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'

  it('stores agents only under Selected and reads an empty selection as none', () => {
    expect(normalizeAgentAccess({ mode: 'selected', agents: [A, A, B] })).toEqual({ mode: 'selected', agents: [A, B] })
    expect(normalizeAgentAccess({ mode: 'selected', agents: [] })).toEqual({ mode: 'none', agents: [] })
    expect(normalizeAgentAccess({ mode: 'all', agents: [A] })).toEqual({ mode: 'all', agents: [] })
    expect(normalizeAgentAccess({ mode: 'none', agents: [A] })).toEqual({ mode: 'none', agents: [] })
  })

  it('grants the listed agents under Selected, every agent under All, and none by default', () => {
    expect(agentAccessGrants({ mode: 'selected', agents: [A] }, A)).toBe(true)
    expect(agentAccessGrants({ mode: 'selected', agents: [A] }, B)).toBe(false)
    expect(agentAccessGrants({ mode: 'all', agents: [] }, B)).toBe(true)
    expect(agentAccessGrants({ mode: 'none', agents: [] }, A)).toBe(false)
  })

  it('no longer carries allowed agents in the policy', () => {
    expect(ComputerPolicySchema.parse({ allowedAgents: [A] })).not.toHaveProperty('allowedAgents')
  })

  it('derives the spec value an older daemon reads from the derived Computers and the managed mode', () => {
    expect(agentComputerUseOf(undefined, [])).toBeNull()
    expect(agentComputerUseOf({}, [A])).toEqual({ enabled: true, computers: [A] })
    expect(agentComputerUseOf({ managed: { mode: 'per-agent' } }, [])).toEqual({
      enabled: true,
      computers: [],
      managed: { mode: 'per-agent' }
    })
    const many = Array.from(
      { length: AGENT_COMPUTERS_MAX + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    )
    expect(AgentComputerUse.parse(agentComputerUseOf({}, many)).computers).toHaveLength(AGENT_COMPUTERS_MAX)
  })

  it('takes only the managed mode from an agent', () => {
    expect(AgentComputerSetting.parse({ managed: { mode: 'ephemeral' } })).toEqual({ managed: { mode: 'ephemeral' } })
    expect(AgentComputerSetting.safeParse({ enabled: true, computers: [A] }).success).toBe(false)
  })
})

describe('managed computer egress (computer-use.md §15.4)', () => {
  it('takes an http or https proxy with a port and keeps its credentials apart', () => {
    for (const url of ['http://proxy.example.com:3128', 'https://10.0.0.5:8443', 'http://proxy.example.com/']) {
      expect(ComputerEgress.safeParse({ mode: 'proxy', url }).success).toBe(true)
    }
    for (const url of [
      'socks5://proxy.example.com:1080',
      'http://user:pass@proxy.example.com:3128',
      'http://proxy.example.com:3128/path',
      'http://proxy.example.com:3128?x=1',
      'not a url'
    ]) {
      expect(ComputerEgress.safeParse({ mode: 'proxy', url }).success).toBe(false)
    }
  })

  it('reaches an older desktop as an auth/ok field it drops', () => {
    const frame = buildComputerCpFrame('computer/auth/ok', {
      ...authOk,
      egress: { mode: 'proxy', url: 'http://proxy.example.com:3128', password: 'secret' }
    })
    const decoded = decodeComputerCpFrameTolerant(JSON.stringify(frame))
    expect(decoded.ok && decoded.frame.type === 'computer/auth/ok' && decoded.frame.payload.egress).toEqual({
      mode: 'proxy',
      url: 'http://proxy.example.com:3128',
      password: 'secret'
    })
  })
})
