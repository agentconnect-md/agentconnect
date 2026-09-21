import { describe, expect, it } from 'vitest'
import {
  ExecutorCandidatesReq,
  ExecutorCandidatesResult,
  ExecutorFacts,
  ExecutorPrepareReq,
  ExecutorPrepareResult,
  ExecutorReleaseReq,
  ExecutorReleaseResult,
  SessionStayedHomeReason
} from './executor.js'
import { RegisterReq } from './register.js'
import { EventSession, Heartbeat } from './telemetry.js'
import { buildEnvelope, decodeCpEnvelope, decodeEnvelope, encode, type FrameType } from '../index.js'

const AGENT = '22222222-2222-4222-8222-222222222222'
const EXECUTOR = '33333333-3333-4333-8333-333333333333'
const LAUNCH = '44444444-4444-4444-8444-444444444444'

const FACTS: ExecutorFacts = {
  enabled: true,
  strategies: {
    host: { available: true },
    microsandbox: { available: false, reason: 'microsandbox is not the configured sandbox backend' }
  },
  endpoint: { host: '192.0.2.10', port: 7443 },
  capacity: 32
}

const REGISTER = {
  host: 'member-1',
  capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
  maxAgents: 8,
  localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
}

const HEARTBEAT = { load: { cpu: 0.1, mem: 0.2, agents: 1 }, health: 'ok' as const, activeSessions: 2 }

const SESSION = {
  sessionId: 's-1',
  agentId: AGENT,
  phase: 'start' as const,
  ts: '2026-09-21T00:00:00.000Z'
}

const PREPARE: ExecutorPrepareReq = {
  agentId: AGENT,
  sessionKey: 'slack:C1:1700000000.000100',
  executorDaemonId: EXECUTOR,
  launchId: LAUNCH,
  strategy: 'host'
}

/** Encode, then read as the CP reads a daemon — the strict path. */
function roundTrip(type: FrameType, payload: unknown): unknown {
  const decoded = decodeEnvelope(encode(buildEnvelope(type, payload)))
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
  expect(decoded.frame.type).toBe(type)
  return decoded.frame.payload
}

describe('executor facts on registration', () => {
  it('ride register and capabilities/update through the codec', () => {
    const capabilities = { ...REGISTER.capabilities, executor: FACTS }
    expect(roundTrip('register', { ...REGISTER, capabilities })).toMatchObject({ capabilities })
    expect(roundTrip('capabilities/update', { capabilities })).toEqual({ capabilities })
  })

  it('absent leaves a daemon that does not share parsing exactly as before', () => {
    expect(RegisterReq.parse(REGISTER).capabilities).toEqual(REGISTER.capabilities)
    expect(roundTrip('register', REGISTER)).toEqual(RegisterReq.parse(REGISTER))
  })

  it('an unknown registration key is stripped, not fatal — which is how a CP that predates these facts reads them', () => {
    const capabilities = { ...REGISTER.capabilities, facetFromTheFuture: { enabled: true } }
    expect(RegisterReq.parse({ ...REGISTER, capabilities }).capabilities).toEqual(REGISTER.capabilities)
  })

  it('a facet that is off needs nothing but the switch', () => {
    expect(ExecutorFacts.parse({ enabled: false })).toEqual({ enabled: false })
    expect(ExecutorFacts.safeParse({}).success).toBe(false)
  })

  it('the strategy table takes a strategy this build has never heard of, and an unavailable one must say why', () => {
    expect(ExecutorFacts.safeParse({ enabled: true, strategies: { srt: { available: true } } }).success).toBe(true)
    expect(ExecutorFacts.safeParse({ enabled: true, strategies: { host: { available: false } } }).success).toBe(false)
    expect(ExecutorFacts.safeParse({ enabled: true, strategies: { 'Not A Slug': { available: true } } }).success).toBe(
      false
    )
  })

  it('an endpoint is a host and a real port', () => {
    expect(ExecutorFacts.safeParse({ enabled: true, endpoint: { host: '192.0.2.10', port: 0 } }).success).toBe(false)
    expect(ExecutorFacts.safeParse({ enabled: true, endpoint: { host: '', port: 7443 } }).success).toBe(false)
  })
})

describe('hostedSessions on the heartbeat', () => {
  it('round-trips beside activeSessions, which keeps its meaning', () => {
    expect(roundTrip('heartbeat', { ...HEARTBEAT, hostedSessions: 5 })).toMatchObject({
      activeSessions: 2,
      hostedSessions: 5
    })
  })

  it('absent keeps an older daemon parsing exactly as before', () => {
    expect(Heartbeat.parse(HEARTBEAT).hostedSessions).toBeUndefined()
    expect(roundTrip('heartbeat', HEARTBEAT)).toEqual(Heartbeat.parse(HEARTBEAT))
    expect(Heartbeat.safeParse({ ...HEARTBEAT, hostedSessions: -1 }).success).toBe(false)
  })
})

describe('the birth verdict on the session metadata report', () => {
  it('names the executor on both the event and the acknowledged sync', () => {
    for (const type of ['event/session', 'event/session-sync'] as const) {
      expect(roundTrip(type, { ...SESSION, executorDaemonId: EXECUTOR })).toEqual({
        ...SESSION,
        executorDaemonId: EXECUTOR
      })
    }
  })

  it('or says why the session stayed home, from a closed vocabulary', () => {
    expect(roundTrip('event/session', { ...SESSION, stayedHomeReason: 'group_switch_off' })).toEqual({
      ...SESSION,
      stayedHomeReason: 'group_switch_off'
    })
    expect(EventSession.safeParse({ ...SESSION, stayedHomeReason: 'the machine felt busy' }).success).toBe(false)
    expect(EventSession.safeParse({ ...SESSION, executorDaemonId: 'daemon-b' }).success).toBe(false)
    expect(SessionStayedHomeReason.options).toEqual([
      'not_on_group',
      'group_switch_off',
      'shared_session',
      'memory_daemon_homed',
      'no_candidate',
      'candidates_full',
      'control_plane_unreachable',
      'holder_least_loaded'
    ])
  })

  it('absent leaves an older daemon’s report unchanged', () => {
    expect(roundTrip('event/session', SESSION)).toEqual(SESSION)
  })
})

describe('executor/candidates', () => {
  it('the request names the agent, and the session only when the holder wants to know where it last ran', () => {
    expect(roundTrip('executor/candidates', { agentId: AGENT })).toEqual({ agentId: AGENT })
    const asked = { agentId: AGENT, sessionKey: PREPARE.sessionKey }
    expect(roundTrip('executor/candidates', asked)).toEqual(asked)
    expect(ExecutorCandidatesReq.safeParse({}).success).toBe(false)
    expect(ExecutorCandidatesReq.safeParse({ agentId: 'not-a-uuid' }).success).toBe(false)
    expect(ExecutorCandidatesReq.safeParse({ agentId: AGENT, sessionKey: '' }).success).toBe(false)
  })

  it('the hint rides any answer, an empty one included, and is a daemon id or nothing', () => {
    const hinted = { candidates: [], reason: 'no_member_shares', currentExecutorDaemonId: EXECUTOR }
    expect(roundTrip('executor/candidates/result', hinted)).toEqual(hinted)
    expect(ExecutorCandidatesResult.safeParse({ candidates: [], currentExecutorDaemonId: 'daemon-b' }).success).toBe(
      false
    )
  })

  it('the answer carries each candidate’s facts through the codec', () => {
    const payload: ExecutorCandidatesResult = {
      candidates: [
        {
          daemonId: EXECUTOR,
          strategies: FACTS.strategies!,
          endpoint: FACTS.endpoint,
          capacity: 32,
          hostedSessions: 3,
          runtimes: [
            { runtime: 'claude', authRequired: false },
            { runtime: 'codex', authRequired: true }
          ]
        }
      ]
    }
    expect(roundTrip('executor/candidates/result', payload)).toEqual(payload)
  })

  it('an empty answer says why, from a closed vocabulary', () => {
    const payload = { candidates: [], reason: 'group_switch_off' }
    expect(roundTrip('executor/candidates/result', payload)).toEqual(payload)
    expect(ExecutorCandidatesResult.safeParse({ candidates: [], reason: 'nobody home' }).success).toBe(false)
  })
})

describe('executor/prepare', () => {
  it('round-trips with and without the microsandbox-only fields', () => {
    expect(roundTrip('executor/prepare', PREPARE)).toEqual(PREPARE)
    const vm = {
      ...PREPARE,
      strategy: 'microsandbox',
      resources: { cpus: 2, memoryMiB: 4096 },
      image: 'registry.example.test/runtime:1'
    }
    expect(roundTrip('executor/prepare', vm)).toEqual(vm)
  })

  it('names the runtime the session starts, and a ready reply says how that machine starts it', () => {
    const named = { ...PREPARE, runtime: 'codex-acp' }
    expect(roundTrip('executor/prepare', named)).toEqual(named)
    const ready: ExecutorPrepareResult = {
      status: 'ready',
      generation: 2,
      endpoint: { host: '192.0.2.10', port: 7443 },
      psk: 'c2VjcmV0LXBpcGUta2V5',
      runtimeRoot: '/home/agent/.agentconnect/hs/0a1b2c3d4e5f',
      runtimeLaunch: {
        command: '/usr/bin/node',
        args: ['/home/agent/.agentconnect/runtimes/@example/acp@1.2.3/node_modules/@example/acp/dist/index.js']
      },
      liveCount: 1
    }
    expect(roundTrip('executor/prepare/result', ready)).toEqual(ready)
    expect(ExecutorPrepareReq.safeParse({ ...PREPARE, runtime: '' }).success).toBe(false)
    expect(ExecutorPrepareResult.safeParse({ ...ready, runtimeLaunch: { command: '', args: [] } }).success).toBe(false)
  })

  it('a resent request is the same bytes, launch id included, so whoever dedupes by launch can', () => {
    const frame = buildEnvelope('executor/prepare', PREPARE)
    expect(encode(frame)).toBe(encode(frame))
    expect(roundTrip('executor/prepare', PREPARE)).toMatchObject({ launchId: LAUNCH })
  })

  it('refuses a launch that names none, carries no generation of its own, and takes a strategy this build has never heard of', () => {
    const { launchId: _launchId, ...unnamed } = PREPARE
    expect(ExecutorPrepareReq.safeParse(unnamed).success).toBe(false)
    expect(ExecutorPrepareReq.safeParse({ ...PREPARE, launchId: 'launch-7' }).success).toBe(false)
    // The executor allocates the generation: one a holder sends is not part of the request.
    expect(ExecutorPrepareReq.parse({ ...PREPARE, generation: 7 })).toEqual(PREPARE)
    expect(ExecutorPrepareReq.safeParse({ ...PREPARE, strategy: 'docker' }).success).toBe(true)
  })

  it('every arm of the reply round-trips', () => {
    const arms: ExecutorPrepareResult[] = [
      {
        status: 'ready',
        generation: 8,
        endpoint: { host: '192.0.2.10', port: 7443 },
        psk: 'c2VjcmV0LXBpcGUta2V5',
        runtimeRoot: '/home/agent/workspace/hs/0a1b2c3d4e5f',
        helperRoot: '/opt/agentconnect',
        missingHelpers: ['ghWrapperDir'],
        liveCount: 4
      },
      { status: 'full', liveCount: 32 },
      { status: 'full' },
      { status: 'refused', reason: 'launch_retired' },
      { status: 'offline', lastSeenAt: '2026-09-21T00:00:00.000Z' },
      { status: 'offline', lastSeenAt: null }
    ]
    for (const arm of arms) expect(roundTrip('executor/prepare/result', arm)).toEqual(arm)
  })

  it('a refusal reason is a slug from the closed list, never prose, and a generation is never refused as stale', () => {
    expect(ExecutorPrepareResult.safeParse({ status: 'refused', reason: 'the executor is busy' }).success).toBe(false)
    expect(ExecutorPrepareResult.safeParse({ status: 'refused', reason: 'stale_generation' }).success).toBe(false)
    expect(ExecutorPrepareResult.safeParse({ status: 'refused' }).success).toBe(false)
    expect(ExecutorPrepareResult.safeParse({ status: 'ready', psk: 'k' }).success).toBe(false)
  })

  it('a ready reply names the generation the executor allocated, which the holder binds at', () => {
    const ready = {
      status: 'ready',
      endpoint: { host: '192.0.2.10', port: 7443 },
      psk: 'c2VjcmV0LXBpcGUta2V5',
      runtimeRoot: '/home/agent/workspace/hs/0a1b2c3d4e5f',
      liveCount: 1
    }
    expect(ExecutorPrepareResult.safeParse(ready).success).toBe(false)
    expect(ExecutorPrepareResult.safeParse({ ...ready, generation: 0 }).success).toBe(false)
    expect(ExecutorPrepareResult.safeParse({ ...ready, generation: 1 }).success).toBe(true)
  })

  it('a daemon reads a reply field it predates as absent, not as a failed request', () => {
    const frame = buildEnvelope('executor/prepare/result', { status: 'full', liveCount: 1, queueDepth: 9 })
    const decoded = decodeCpEnvelope(encode(frame))
    if (!decoded.ok) throw new Error(`decode failed: ${decoded.msg}`)
    expect(decoded.frame.payload).toEqual({ status: 'full', liveCount: 1 })
  })
})

describe('executor/release', () => {
  const RELEASE: ExecutorReleaseReq = {
    agentId: AGENT,
    sessionKey: PREPARE.sessionKey,
    executorDaemonId: EXECUTOR,
    launchId: LAUNCH
  }

  it('names the session, the machine and the launch it retires', () => {
    expect(roundTrip('executor/release', RELEASE)).toEqual(RELEASE)
    expect(ExecutorReleaseReq.safeParse({ agentId: AGENT, sessionKey: PREPARE.sessionKey }).success).toBe(false)
    expect(ExecutorReleaseReq.safeParse({ ...RELEASE, sessionKey: '' }).success).toBe(false)
    // A session key outlives its launches, so a release that names none could cross a launch boundary.
    const { launchId: _launchId, ...unfenced } = RELEASE
    expect(ExecutorReleaseReq.safeParse(unfenced).success).toBe(false)
    expect(ExecutorReleaseReq.safeParse({ ...RELEASE, launchId: 'launch-1' }).success).toBe(false)
  })

  it('every arm of the reply round-trips, and a refusal is a slug from its own closed list', () => {
    const arms: ExecutorReleaseResult[] = [
      { status: 'released' },
      { status: 'unknown' },
      { status: 'refused', reason: 'not_holder' },
      { status: 'refused', reason: 'not_member' },
      { status: 'offline', lastSeenAt: '2026-09-21T00:00:00.000Z' },
      { status: 'offline', lastSeenAt: null }
    ]
    for (const arm of arms) expect(roundTrip('executor/release/result', arm)).toEqual(arm)
    // Neither consent gates a release, so neither is a reason to refuse one.
    for (const reason of ['group_switch_off', 'facet_off', 'draining']) {
      expect(ExecutorReleaseResult.safeParse({ status: 'refused', reason }).success).toBe(false)
    }
  })
})
