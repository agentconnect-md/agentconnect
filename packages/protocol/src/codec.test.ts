import { describe, it, expect } from 'vitest'
import {
  IntegrationSlackConfig,
  IntegrationTelegramConfig,
  IntegrationDiscordConfig,
  IntegrationFeishuConfig,
  AuthReq,
  ControlExt,
  isFrame,
  type AnyFrame,
  decodeEnvelope,
  buildEnvelope,
  encode,
  MAX_FRAME_BYTES,
  MAX_WORKSPACE_COMMIT_AUTHOR,
  MAX_WORKSPACE_COMMIT_SUBJECT,
  MAX_WORKSPACE_LOG_COMMITS,
  MAX_WORKSPACE_COMMIT_MESSAGE,
  MAX_WORKSPACE_STAGE_PATHS,
  MAX_WORKSPACE_STAGE_PATH_BYTES,
  MAX_TASK_DESCRIPTION,
  MAX_TASK_DETAIL,
  MAX_TASK_LIST_TASKS,
  TaskErrorReason,
  TaskState,
  WorkspaceErrorReason,
  WorkspaceGitWriteReason,
  FRAME_SCHEMAS,
  FRAME_TYPES
} from './index.js'

const ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const LAUNCH_ID = '44444444-4444-4444-8444-444444444444'
const MOVE_ID = '55555555-5555-4555-8555-555555555555'
const HOOK_ID = '66666666-6666-4666-8666-666666666666'
const CONNECTION_ID = '77777777-7777-4777-8777-777777777777'
const LOCAL_CONNECTION_ID = '88888888-8888-4888-8888-888888888888'
const TS = '2026-06-24T00:00:00.000Z'

const remoteMemoryConnection = {
  connectionId: CONNECTION_ID,
  revision: 1,
  transport: 'streamable-http' as const,
  relayUrl: `https://relay.example/memory/${CONNECTION_ID}`,
  grantKey: 'daemon-private-grant',
  config: { projectId: 'p1' },
  secretKeys: ['apiKey'],
  pin: {
    pluginId: 'ai.example.memory',
    profileMajor: 1 as const,
    secretHeaders: [{ name: 'apiKey', header: 'X-Api-Key', required: true }]
  }
}

const localMemoryConnection = {
  connectionId: LOCAL_CONNECTION_ID,
  revision: 1,
  transport: 'stdio' as const,
  commandRef: 'mem0-oss',
  config: {},
  secretKeys: ['apiKey'],
  secretLease: { values: { apiKey: 'daemon-private-value' } },
  pin: {
    pluginId: 'ai.mem0.memory.oss',
    profileMajor: 1 as const,
    secretHeaders: [{ name: 'apiKey', header: 'X-Mem0-Api-Key', required: true }]
  }
}

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, id: ID, ts: TS, type, payload, ...extra })
}

const validAuthPayload = {
  apiKey: 'testsecret0000aBcD',
  daemonId: DAEMON_ID,
  agentVersion: '1.2.3'
}

describe('decodeEnvelope — first failing test (design §6 Phase 0)', () => {
  it('returns a typed AuthReq for a valid auth frame', () => {
    const r = decodeEnvelope(envelope('auth', validAuthPayload))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.frame.type).toBe('auth')
    // payload is narrowed to AuthReq (via the protocol guard) and re-validates
    if (!isFrame('auth')(r.frame)) throw new Error('expected an auth frame')
    expect(r.frame.payload.daemonId).toBe(DAEMON_ID)
    expect(r.frame.payload.agentVersion).toBe('1.2.3')
    expect(AuthReq.safeParse(r.frame.payload).success).toBe(true)
  })

  it('round-trips frame-scoped organization authority in the envelope', () => {
    const built = buildEnvelope('channel/agents', { platform: 'slack', requesterAgentId: AGENT_ID }, { orgId: 'org-a' })
    expect(built.orgId).toBe('org-a')
    const decoded = decodeEnvelope(encode(built))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    expect(decoded.frame.orgId).toBe('org-a')
  })

  it('round-trips the frozen auth-time bootstrap upgrade contract', () => {
    const auth = decodeEnvelope(envelope('auth', { ...validAuthPayload, bootstrapProtocolVersion: 1 }))
    expect(auth.ok).toBe(true)
    if (!auth.ok || !isFrame('auth')(auth.frame)) throw new Error('expected auth')
    expect(auth.frame.payload.bootstrapProtocolVersion).toBe(1)

    const ok = decodeEnvelope(
      envelope('auth/ok', {
        daemonId: DAEMON_ID,
        sessionEpoch: 2,
        heartbeatSec: 15,
        serverTime: TS,
        lifecycle: { operationId: 'op-1', action: 'upgrade', targetVersion: '2.0.0' }
      })
    )
    expect(ok.ok).toBe(true)
    if (!ok.ok || !isFrame('auth/ok')(ok.frame)) throw new Error('expected auth/ok')
    expect(ok.frame.payload.lifecycle?.targetVersion).toBe('2.0.0')

    const result = decodeEnvelope(envelope('daemon/bootstrap/result', { operationId: 'op-1', status: 'installed' }))
    expect(result.ok).toBe(true)
    if (!result.ok || !isFrame('daemon/bootstrap/result')(result.frame)) {
      throw new Error('expected bootstrap result')
    }
    expect(result.frame.payload.status).toBe('installed')
  })

  it('rejects an unknown type with UNKNOWN_FRAME (a REP, not a close)', () => {
    const r = decodeEnvelope(envelope('totally/unknown', { whatever: true }))
    expect(r).toEqual({ ok: false, id: ID, msg: 'UNKNOWN_FRAME' })
  })

  it('rejects inherited schema-map keys with UNKNOWN_FRAME', () => {
    for (const type of ['__proto__', 'constructor', 'toString']) {
      expect(decodeEnvelope(envelope(type, {}))).toEqual({ ok: false, id: ID, msg: 'UNKNOWN_FRAME' })
    }
  })

  it('rejects a frame larger than 256 KiB with FRAME_TOO_LARGE', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES + 1)
    const r = decodeEnvelope(envelope('auth', { ...validAuthPayload, agentVersion: big }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.msg).toBe('FRAME_TOO_LARGE')
  })
})

describe('decodeEnvelope — additional codec/frame units', () => {
  it('decodes a valid register frame', () => {
    const payload = {
      host: 'host-1',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
      maxAgents: 4,
      localState: { assignments: [], crons: [], leases: [] }
    }
    const r = decodeEnvelope(envelope('register', payload))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    expect(r.frame.type).toBe('register')
    if (!isFrame('register')(r.frame)) throw new Error('expected a register frame')
    // zod default fills capabilities.features
    expect(r.frame.payload.capabilities.features).toEqual([])
    // Rolling upgrade: older daemons omit replica inventories.
    expect(r.frame.payload.localState.agents).toEqual([])
    expect(r.frame.payload.localState.integrations).toEqual([])
    expect(r.frame.payload.localState.stagedAgents).toEqual([])
  })

  it('register accepts discord in capabilities.platforms (handshake regression)', () => {
    // A daemon that runs a Discord adapter advertises platforms: ['slack','discord'].
    // The register schema validates capabilities.platforms via the shared Platform enum,
    // so 'discord' must be accepted — else the CP rejects the handshake.
    const r = decodeEnvelope(
      envelope('register', {
        host: 'host-1',
        capabilities: { platforms: ['slack', 'discord'], runtimes: ['claude'], acp: true },
        maxAgents: 4,
        localState: { assignments: [], crons: [], leases: [] }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('register')(r.frame)) throw new Error('expected a register frame')
    expect(r.frame.payload.capabilities.platforms).toEqual(['slack', 'discord'])
  })

  it('register accepts a fail-closed staged tombstone without a recoverable token', () => {
    const r = decodeEnvelope(
      envelope('register', {
        host: 'host-1',
        capabilities: { platforms: [], runtimes: [], acp: true },
        maxAgents: 4,
        localState: {
          assignments: [],
          crons: [],
          leases: [],
          stagedAgents: [{ agentId: AGENT_ID }]
        }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('register')(r.frame)) throw new Error('expected a register frame')
    expect(r.frame.payload.localState.stagedAgents).toEqual([{ agentId: AGENT_ID }])
  })

  it('round-trips an error frame through build → encode → decode', () => {
    const errFrame = buildEnvelope('error', {
      code: 'STALE_LAUNCH',
      message: 'stale launch',
      retryable: true,
      details: { launchId: LAUNCH_ID }
    })
    const decoded = decodeEnvelope(encode(errFrame))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    // narrow via the protocol guard so `payload` is typed as ErrorFrame
    if (!isFrame('error')(decoded.frame)) throw new Error('expected an error frame')
    expect(decoded.frame.payload.code).toBe('STALE_LAUNCH')
    expect(decoded.frame.payload.details).toEqual({ launchId: LAUNCH_ID })
  })

  it('fails a frame whose payload violates its schema (BAD_PAYLOAD-ish: validation error surfaced)', () => {
    // missing required agentVersion
    const corr = '99999999-9999-4999-8999-999999999999'
    const r = decodeEnvelope(envelope('auth', { apiKey: 'testkey', daemonId: DAEMON_ID }, { corr }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    // not UNKNOWN_FRAME / FRAME_TOO_LARGE — a real payload validation message
    expect(r.msg).not.toBe('UNKNOWN_FRAME')
    expect(r.msg).not.toBe('FRAME_TOO_LARGE')
    expect(r.id).toBe(ID)
    // A malformed REP must retain its valid envelope correlation so the caller
    // can reject the pending request immediately instead of timing out.
    expect(r.corr).toBe(corr)
  })

  it('fails invalid JSON with id = NIL_UUID', () => {
    const r = decodeEnvelope('{not json')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected failure')
    expect(r.id).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('parses a ControlExt block (epoch/agentId/launchId)', () => {
    const ext = ControlExt.parse({ epoch: 5, agentId: AGENT_ID, launchId: LAUNCH_ID })
    expect(ext.epoch).toBe(5)
    expect(ext.agentId).toBe(AGENT_ID)
    expect(ext.launchId).toBe(LAUNCH_ID)
    // epoch-only is also valid (fenced-but-not-agent-scoped frame)
    expect(ControlExt.safeParse({ epoch: 1 }).success).toBe(true)
    // missing epoch is invalid
    expect(ControlExt.safeParse({ agentId: AGENT_ID }).success).toBe(false)
  })

  it('register/ok defaults additive server features and the relay roster for rolling compatibility', () => {
    const base = {
      routingEpoch: 1,
      assignments: [],
      crons: [],
      leases: [],
      drop: { assignments: [], crons: [] }
    }
    const r = decodeEnvelope(envelope('register/ok', base))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (!isFrame('register/ok')(r.frame)) throw new Error('expected register/ok')
    expect(r.frame.payload.serverFeatures).toEqual([])
    expect(r.frame.payload.relays).toEqual([])
    expect(r.frame.payload.gitCommitIdentity).toBeUndefined()
    expect(r.frame.payload.drop.agents).toEqual([])
    expect(r.frame.payload.drop.integrations).toEqual([])

    const relayId = '55555555-5555-4555-8555-555555555555'
    const withRoster = decodeEnvelope(
      envelope('register/ok', { ...base, relays: [{ relayId, url: 'wss://relay-0.example' }] })
    )
    if (!withRoster.ok || !isFrame('register/ok')(withRoster.frame)) throw new Error('expected register/ok')
    expect(withRoster.frame.payload.relays).toEqual([{ relayId, url: 'wss://relay-0.example' }])

    const withFeature = decodeEnvelope(envelope('register/ok', { ...base, serverFeatures: ['gitcred-actions-v1'] }))
    if (!withFeature.ok || !isFrame('register/ok')(withFeature.frame)) throw new Error('expected register/ok')
    expect(withFeature.frame.payload.serverFeatures).toEqual(['gitcred-actions-v1'])

    const gitCommitIdentity = {
      name: 'agentconnect-example[bot]',
      email: '123456+agentconnect-example[bot]@users.noreply.github.com'
    }
    const withIdentity = decodeEnvelope(envelope('register/ok', { ...base, gitCommitIdentity }))
    if (!withIdentity.ok || !isFrame('register/ok')(withIdentity.frame)) throw new Error('expected register/ok')
    expect(withIdentity.frame.payload.gitCommitIdentity).toEqual(gitCommitIdentity)
  })

  it('round-trips a remote memory upsert with its transport discriminator intact', () => {
    const frame = buildEnvelope('memoryconnection/upsert', remoteMemoryConnection, { ext: { epoch: 1 } })
    const encoded = encode(frame)
    const wire = JSON.parse(encoded) as { payload: Record<string, unknown> }
    expect(wire.payload.transport).toBe('streamable-http')

    const decoded = decodeEnvelope(encoded)
    if (!decoded.ok || !isFrame('memoryconnection/upsert')(decoded.frame)) {
      throw new Error('expected memoryconnection/upsert')
    }
    expect(decoded.frame.payload).toEqual(remoteMemoryConnection)
  })

  it('round-trips both memory transports in a reconnect snapshot', () => {
    const frame = buildEnvelope('register/ok', {
      routingEpoch: 1,
      assignments: [],
      crons: [],
      leases: [],
      memoryConnections: [remoteMemoryConnection, localMemoryConnection],
      drop: { assignments: [], crons: [] }
    })
    const encoded = encode(frame)
    const wire = JSON.parse(encoded) as {
      payload: { memoryConnections: Array<Record<string, unknown>> }
    }
    expect(wire.payload.memoryConnections[0]?.transport).toBe('streamable-http')
    expect(wire.payload.memoryConnections[1]?.transport).toBe('stdio')

    const decoded = decodeEnvelope(encoded)
    if (!decoded.ok || !isFrame('register/ok')(decoded.frame)) throw new Error('expected register/ok')
    expect(decoded.frame.payload.memoryConnections).toEqual([remoteMemoryConnection, localMemoryConnection])
  })

  it('relay/roster (C→D hot update) carries the whole desired set', () => {
    const relayId = '55555555-5555-4555-8555-555555555555'
    const r = decodeEnvelope(envelope('relay/roster', { relays: [{ relayId, url: 'wss://relay-0.example' }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (!isFrame('relay/roster')(r.frame)) throw new Error('expected relay/roster')
    expect(r.frame.payload.relays[0]?.relayId).toBe(relayId)
    // converge-don't-diff: an empty set is a legal "drop every relay" update
    expect(decodeEnvelope(envelope('relay/roster', { relays: [] })).ok).toBe(true)
  })

  it('buildEnvelope stamps v:1, a uuid id, an RFC3339 ts, and corr when given', () => {
    const f: AnyFrame = buildEnvelope('heartbeat', {
      load: { cpu: 0.1, mem: 0.2, agents: 1 },
      health: 'ok',
      activeSessions: 1
    })
    expect(f.v).toBe(1)
    expect(f.type).toBe('heartbeat')
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof f.ts).toBe('string')
    const withCorr = buildEnvelope(
      'auth/ok',
      {
        daemonId: DAEMON_ID,
        sessionEpoch: 1,
        heartbeatSec: 15,
        serverTime: TS
      },
      { corr: ID }
    )
    expect(withCorr.corr).toBe(ID)
  })
})

describe('agent spec / CRUD frames (CP→daemon spec sync)', () => {
  it('agent/launch carries the spec (prompt = description); mode defaults long_lived', () => {
    const r = decodeEnvelope(
      envelope('agent/launch', {
        agentId: AGENT_ID,
        runtime: 'claude',
        workspaceId: '55555555-5555-4555-8555-555555555555',
        capabilities: ['fs.read'],
        spec: { name: 'helper', description: 'You are a helper.', model: 'opus' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (!isFrame('agent/launch')(r.frame)) throw new Error('expected agent/launch')
    expect(r.frame.payload.spec.description).toBe('You are a helper.')
    expect(r.frame.payload.spec.model).toBe('opus')
    expect(r.frame.payload.mode).toBe('long_lived') // zod default
  })

  it('spec.workspace carries the github mode (repo/branch/agentDir; branch defaults main)', () => {
    const r = decodeEnvelope(
      envelope('agent/launch', {
        agentId: AGENT_ID,
        runtime: 'claude',
        workspaceId: '55555555-5555-4555-8555-555555555555',
        capabilities: [],
        spec: {
          name: 'deploy-bot',
          workspace: { mode: 'github', gitRepo: 'github.com/acme/infra', agentDir: './services/api' }
        }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('agent/launch')(r.frame)) throw new Error('expected agent/launch')
    const ws = r.frame.payload.spec.workspace
    if (ws?.mode !== 'github') throw new Error('expected github workspace')
    expect(ws.gitRepo).toBe('github.com/acme/infra')
    expect(ws.agentDir).toBe('./services/api')
    expect(ws.branch).toBe('main') // zod default
    expect(ws.isolation).toBe('shared')
    expect(ws.additionalRepos).toEqual([]) // zod default
  })

  it('spec.workspace accepts scratch with explicit-repo GitHub credentials', () => {
    const r = decodeEnvelope(
      envelope('agent/upsert', {
        agentId: AGENT_ID,
        spec: { name: 'fresh', workspace: { mode: 'scratch', gitCredential: 'github-app' } }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('agent/upsert')(r.frame)) throw new Error('expected agent/upsert')
    expect(r.frame.payload.spec.workspace).toEqual({
      mode: 'scratch',
      isolation: 'shared',
      gitCredential: 'github-app',
      additionalRepos: []
    })
  })

  it('spec.workspace round-trips the additional-repository allowlist on both modes', () => {
    // A provider-less entry is what a pre-GitLab control plane sends, and it means
    // github — the tolerant-reader default the two hosts' independent numbering needs.
    const additionalRepos = [
      { repoFullName: 'acme/infra', repoId: '4711' },
      { repoFullName: 'example-group/example-project', repoId: '815', provider: 'gitlab' }
    ]
    const qualified = [
      { repoFullName: 'acme/infra', repoId: '4711', provider: 'github' },
      { repoFullName: 'example-group/example-project', repoId: '815', provider: 'gitlab' }
    ]
    const scratch = decodeEnvelope(
      envelope('agent/upsert', {
        agentId: AGENT_ID,
        spec: { name: 'fresh', workspace: { mode: 'scratch', gitCredential: 'github-app', additionalRepos } }
      })
    )
    if (!scratch.ok || !isFrame('agent/upsert')(scratch.frame)) throw new Error('expected agent/upsert')
    expect(scratch.frame.payload.spec.workspace?.additionalRepos).toEqual(qualified)

    const github = decodeEnvelope(
      envelope('agent/upsert', {
        agentId: AGENT_ID,
        spec: {
          name: 'deploy-bot',
          workspace: { mode: 'github', gitRepo: 'https://github.com/acme/primary-service', additionalRepos }
        }
      })
    )
    if (!github.ok || !isFrame('agent/upsert')(github.frame)) throw new Error('expected agent/upsert')
    expect(github.frame.payload.spec.workspace?.additionalRepos).toEqual(qualified)
  })

  it('agent/upsert and agent/remove decode for live CRUD', () => {
    const up = decodeEnvelope(
      envelope('agent/upsert', {
        agentId: AGENT_ID,
        spec: { name: 'helper', displayName: 'Helper Bot', description: 'edited prompt' }
      })
    )
    expect(up.ok).toBe(true)
    if (up.ok && isFrame('agent/upsert')(up.frame)) {
      expect(up.frame.payload.spec.description).toBe('edited prompt')
      expect(up.frame.payload.spec.displayName).toBe('Helper Bot')
      expect(up.frame.payload.spec).not.toHaveProperty('outboundPolicy')
      expect(up.frame.payload.spec).not.toHaveProperty('allowedTargetAgentIds')
    }

    const clearDisplayName = decodeEnvelope(
      envelope('agent/upsert', { agentId: AGENT_ID, spec: { name: 'helper', displayName: null } })
    )
    expect(clearDisplayName.ok).toBe(true)
    if (clearDisplayName.ok && isFrame('agent/upsert')(clearDisplayName.frame)) {
      expect(clearDisplayName.frame.payload.spec).toHaveProperty('displayName', null)
    }

    const rm = decodeEnvelope(envelope('agent/remove', { agentId: AGENT_ID }))
    expect(rm.ok).toBe(true)
    if (rm.ok && isFrame('agent/remove')(rm.frame)) expect(rm.frame.payload.agentId).toBe(AGENT_ID)
  })

  it('agent/detach and agent/activate decode for acknowledged moves', () => {
    const detach = decodeEnvelope(
      envelope('agent/detach', {
        agentId: AGENT_ID,
        moveId: MOVE_ID,
        discardActiveTurns: true,
        requireEmptyWorkspace: true
      })
    )
    expect(detach.ok).toBe(true)
    if (!detach.ok || !isFrame('agent/detach')(detach.frame)) throw new Error('expected agent/detach')
    expect(detach.frame.payload.discardActiveTurns).toBe(true)
    expect(detach.frame.payload.agentId).toBe(AGENT_ID)
    expect(detach.frame.payload.requireEmptyWorkspace).toBe(true)

    const activate = decodeEnvelope(
      envelope('agent/activate', {
        agentId: AGENT_ID,
        moveId: MOVE_ID,
        spec: { name: 'helper' },
        integrations: [],
        crons: [],
        prepareWorkspace: true,
        reconcileWorkspace: true
      })
    )
    expect(activate.ok).toBe(true)
    if (!activate.ok || !isFrame('agent/activate')(activate.frame)) throw new Error('expected agent/activate')
    expect(activate.frame.payload.agentId).toBe(AGENT_ID)
    expect(activate.frame.payload.moveId).toBe(MOVE_ID)
    expect(activate.frame.payload.spec.name).toBe('helper')
    expect(activate.frame.payload.integrations).toEqual([])
    expect(activate.frame.payload.crons).toEqual([])
    expect(activate.frame.payload.prepareWorkspace).toBe(true)
    expect(activate.frame.payload.reconcileWorkspace).toBe(true)
  })
})

describe('integration frames (CP→daemon platform config distribution)', () => {
  const INTEGRATION_ID = '66666666-6666-4666-8666-666666666666'
  const CORE = { mode: 'direct', bindRules: [], mutedChannels: [], gated: false }

  // §6.4 FINAL SHAPE (S3 flatten): one flat object — open `platform`, REQUIRED
  // `core`, opaque `config`. The frame layer applies no per-platform zod
  // defaults — the CONSUMER (the daemon platform module, resolved through
  // `platforms/integration-config.ts`) parses `config` through its own schema,
  // so these tests validate at that layer, exactly as the daemon reader does.
  it('integration/upsert carries the slack config incl. tokens through the opaque envelope', () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'slack',
        core: CORE,
        config: { botToken: 'xoxb-abc', appToken: 'xapp-1-def', appId: 'A123' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.platform).toBe('slack')
    const cfg = IntegrationSlackConfig.parse(r.frame.payload.config)
    expect(cfg.botToken).toBe('xoxb-abc')
    expect(cfg.appToken).toBe('xapp-1-def')
    expect(cfg.appId).toBe('A123')
    expect(cfg.shareable).toBe(false) // zod default at the consumer parse
  })

  it('integration/upsert STRIPS a stale legacy nested block and keeps envelope + config', () => {
    // The retired pre-S3 nested member is an unknown key — stripped by the
    // non-strict object, never a decode failure.
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'slack',
        core: CORE,
        slack: { botToken: 'xoxb-abc', appToken: 'xapp-1-def' },
        config: { botToken: 'xoxb-abc', appToken: 'xapp-1-def' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect('slack' in r.frame.payload).toBe(false)
    expect(IntegrationSlackConfig.parse(r.frame.payload.config).botToken).toBe('xoxb-abc')
  })

  it('integration/upsert REQUIRES the core envelope (the dual-shape tolerance is retired)', () => {
    // A core-less spec was the S1b dual-shape wire; defaulting it now would
    // silently mint a rule-less integration, so the frame fails instead.
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'slack',
        config: { botToken: 'xoxb-abc', appToken: 'xapp-1-def' }
      })
    )
    expect(r.ok).toBe(false)
  })

  it('integration/upsert carries the telegram config (single botToken, no appToken)', () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'telegram',
        core: CORE,
        config: { botToken: '123456:ABC-def' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.platform).toBe('telegram')
    const cfg = IntegrationTelegramConfig.parse(r.frame.payload.config)
    expect(cfg.botToken).toBe('123456:ABC-def')
  })

  it('integration/upsert carries the discord config (single botToken, optional applicationId)', () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'discord',
        core: CORE,
        config: { botToken: 'MTA-bot-token', applicationId: '112233445566' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.platform).toBe('discord')
    const cfg = IntegrationDiscordConfig.parse(r.frame.payload.config)
    expect(cfg.botToken).toBe('MTA-bot-token')
    expect(cfg.applicationId).toBe('112233445566')
  })

  it('integration/upsert carries the feishu config (appId + appSecret pair, no appToken)', () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'feishu',
        core: CORE,
        config: { appId: 'cli_abc123', appSecret: 'secret-xyz' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.platform).toBe('feishu')
    const cfg = IntegrationFeishuConfig.parse(r.frame.payload.config)
    expect(cfg.appId).toBe('cli_abc123')
    expect(cfg.appSecret).toBe('secret-xyz')
    expect(cfg.region).toBe('feishu') // zod default — China gateway
  })

  it('integration/upsert carries feishu SHARED mode on the core envelope (send-only API access)', () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'feishu',
        core: { ...CORE, mode: 'shared' },
        config: { appId: 'cli_abc123', appSecret: 'secret-xyz', botOpenId: 'ou_bot' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.core.mode).toBe('shared')
    expect(IntegrationFeishuConfig.parse(r.frame.payload.config)).toMatchObject({ botOpenId: 'ou_bot' })
  })

  it("integration/upsert preserves an explicit feishu region 'lark' (international gateway)", () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'feishu',
        core: CORE,
        config: { appId: 'cli_abc123', appSecret: 'secret-xyz', region: 'lark' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(IntegrationFeishuConfig.parse(r.frame.payload.config).region).toBe('lark')
  })

  it('integration/upsert DECODES an unknown platform id (S1a open reader — refusal is the reader’s)', () => {
    // Pre-flatten, the closed union made this a decode failure. The open
    // `platform` decodes it; the daemon reader (platform registry lookup)
    // refuses the SPEC — skip + warn — never the frame or the socket.
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'mastodon',
        core: CORE,
        config: { botToken: 'x' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.platform).toBe('mastodon')
  })

  it('integration/upsert accepts bindRules with a keyword match', () => {
    const r = decodeEnvelope(
      envelope('integration/upsert', {
        integrationId: INTEGRATION_ID,
        agentId: AGENT_ID,
        platform: 'slack',
        core: {
          mode: 'direct',
          bindRules: [{ channel: 'C123', match: { kind: 'keyword', value: 'deploy' } }],
          mutedChannels: [],
          gated: false
        },
        config: { botToken: 'xoxb-abc', appToken: 'xapp-1-def' }
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/upsert')(r.frame)) throw new Error('expected integration/upsert')
    expect(r.frame.payload.platform).toBe('slack')
    const rule = r.frame.payload.core.bindRules[0]!
    expect(rule.channel).toBe('C123')
    expect(rule.match).toEqual({ kind: 'keyword', value: 'deploy' })
  })

  it('integration/remove round-trips the integrationId', () => {
    const rm = decodeEnvelope(envelope('integration/remove', { integrationId: INTEGRATION_ID }))
    expect(rm.ok).toBe(true)
    if (!rm.ok || !isFrame('integration/remove')(rm.frame)) throw new Error('expected integration/remove')
    expect(rm.frame.payload.integrationId).toBe(INTEGRATION_ID)
  })

  it('integration/channels (D→C) round-trips the membership snapshot', () => {
    const r = decodeEnvelope(
      envelope('integration/channels', {
        integrationId: INTEGRATION_ID,
        channels: [{ id: 'C123', name: 'deploys' }, { id: 'C456', name: 'ops', isPrivate: true }, { id: 'C789' }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/channels')(r.frame)) throw new Error('expected integration/channels')
    expect(r.frame.payload.integrationId).toBe(INTEGRATION_ID)
    expect(r.frame.payload.channels).toHaveLength(3)
    expect(r.frame.payload.channels[1]).toEqual({ id: 'C456', name: 'ops', isPrivate: true })
    expect(r.frame.payload.channels[2]).toEqual({ id: 'C789' }) // name optional (lookup may fail)
  })

  it('integration/channels round-trips a DM (kind im) row; kind is optional for wire compat (§14)', () => {
    const r = decodeEnvelope(
      envelope('integration/channels', {
        integrationId: INTEGRATION_ID,
        channels: [{ id: 'D111', name: '@alice', kind: 'im' }, { id: 'C123' }],
        authoritative: false
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('integration/channels')(r.frame)) throw new Error('expected integration/channels')
    expect(r.frame.payload.authoritative).toBe(false)
    expect(r.frame.payload.channels[0]).toEqual({ id: 'D111', name: '@alice', kind: 'im' })
    expect(r.frame.payload.channels[1]).toEqual({ id: 'C123' }) // absent kind = channel
  })

  it('register/ok defaults integrations[] to [] and round-trips a delivered integration', () => {
    const empty = decodeEnvelope(
      envelope('register/ok', {
        routingEpoch: 1,
        assignments: [],
        crons: [],
        leases: [],
        drop: { assignments: [], crons: [] }
      })
    )
    expect(empty.ok).toBe(true)
    if (!empty.ok || !isFrame('register/ok')(empty.frame)) throw new Error('expected register/ok')
    expect(empty.frame.payload.integrations).toEqual([]) // zod default

    const withInt = decodeEnvelope(
      envelope('register/ok', {
        routingEpoch: 1,
        assignments: [],
        crons: [],
        leases: [],
        integrations: [
          {
            integrationId: INTEGRATION_ID,
            agentId: AGENT_ID,
            platform: 'slack',
            core: CORE,
            config: { botToken: 'xoxb-abc', appToken: 'xapp-1-def' }
          }
        ],
        drop: { assignments: [], crons: [] }
      })
    )
    expect(withInt.ok).toBe(true)
    if (!withInt.ok || !isFrame('register/ok')(withInt.frame)) throw new Error('expected register/ok')
    const int0 = withInt.frame.payload.integrations[0]!
    expect(int0.platform).toBe('slack')
    expect(IntegrationSlackConfig.parse(int0.config).appToken).toBe('xapp-1-def')
  })
})

describe('mcp provider frames (CP→daemon proxied MCP def distribution)', () => {
  it('mcpserver/upsert round-trips a proxied http def (relay url + bearer grant header); zod defaults fill lists', () => {
    const r = decodeEnvelope(
      envelope('mcpserver/upsert', {
        name: 'notion',
        transport: 'http',
        url: 'https://relay.example.com/mcp/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        headers: [{ name: 'Authorization', value: 'Bearer oct_grant_key' }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('mcpserver/upsert')(r.frame)) throw new Error('expected mcpserver/upsert')
    expect(r.frame.payload.name).toBe('notion')
    expect(r.frame.payload.transport).toBe('http')
    expect(r.frame.payload.headers[0]).toEqual({ name: 'Authorization', value: 'Bearer oct_grant_key' })
    expect(r.frame.payload.args).toEqual([]) // zod default
    expect(r.frame.payload.env).toEqual([]) // zod default
  })

  it('mcpserver/upsert rejects an http def with no url, and a stdio def with no command (superRefine)', () => {
    expect(decodeEnvelope(envelope('mcpserver/upsert', { name: 'x', transport: 'http' })).ok).toBe(false)
    expect(decodeEnvelope(envelope('mcpserver/upsert', { name: 'x', transport: 'stdio' })).ok).toBe(false)
  })

  it('mcpserver/remove round-trips the name', () => {
    const rm = decodeEnvelope(envelope('mcpserver/remove', { name: 'notion' }))
    expect(rm.ok).toBe(true)
    if (!rm.ok || !isFrame('mcpserver/remove')(rm.frame)) throw new Error('expected mcpserver/remove')
    expect(rm.frame.payload.name).toBe('notion')
  })

  it('register/ok defaults mcpServers[] to [] and round-trips a pushed proxied def', () => {
    const empty = decodeEnvelope(
      envelope('register/ok', {
        routingEpoch: 1,
        assignments: [],
        crons: [],
        leases: [],
        drop: { assignments: [], crons: [] }
      })
    )
    expect(empty.ok).toBe(true)
    if (!empty.ok || !isFrame('register/ok')(empty.frame)) throw new Error('expected register/ok')
    expect(empty.frame.payload.mcpServers).toEqual([]) // zod default

    const withMcp = decodeEnvelope(
      envelope('register/ok', {
        routingEpoch: 1,
        assignments: [],
        crons: [],
        leases: [],
        mcpServers: [{ name: 'notion', transport: 'http', url: 'https://relay.example.com/mcp/p1', headers: [] }],
        drop: { assignments: [], crons: [] }
      })
    )
    expect(withMcp.ok).toBe(true)
    if (!withMcp.ok || !isFrame('register/ok')(withMcp.frame)) throw new Error('expected register/ok')
    expect(withMcp.frame.payload.mcpServers[0]!.name).toBe('notion')
  })
})

describe('session read-back frames (console history pull)', () => {
  const SESSION_ID = '55555555-5555-4555-8555-555555555555'

  it('session/list REQ (agentId optional); session/list/page round-trips items with sessionKey + metrics', () => {
    const req = decodeEnvelope(envelope('session/list', {}))
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('session/list')(req.frame)) throw new Error('expected session/list')

    const page = decodeEnvelope(
      envelope('session/list/page', {
        sessions: [
          {
            sessionId: SESSION_ID,
            sessionKey: { platform: 'slack', channel: '#deploys' },
            agentId: AGENT_ID,
            title: 'Roll out api@1.4.2',
            status: 'completed',
            usage: { totalTokens: 4820, inputTokens: 3600, outputTokens: 1220, cachedReadTokens: 512 },
            triggeredBy: 'U-DANA',
            channelName: 'deploys',
            triggeredByName: 'Dana Reyes',
            threadUrl: 'https://slack.example/archives/C1/p1'
          }
        ]
      })
    )
    expect(page.ok).toBe(true)
    if (!page.ok || !isFrame('session/list/page')(page.frame)) throw new Error('expected list page')
    const s = page.frame.payload.sessions[0]!
    expect(s.sessionKey.channel).toBe('#deploys')
    expect(s.usage?.totalTokens).toBe(4820)
    expect(s.usage?.inputTokens).toBe(3600)
    expect(s.usage?.cachedReadTokens).toBe(512)
    expect(s.triggeredBy).toBe('U-DANA')
    expect(s.channelName).toBe('deploys')
    expect(s.triggeredByName).toBe('Dana Reyes')
    expect(s.threadUrl).toBe('https://slack.example/archives/C1/p1')
  })

  it('session/history REQ defaults limit to 50; session/history/page round-trips messages + cursor', () => {
    const req = decodeEnvelope(
      envelope('session/history', { agentId: AGENT_ID, sessionId: SESSION_ID, cursor: 'c-100' })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('session/history')(req.frame)) throw new Error('expected session/history')
    expect(req.frame.payload.agentId).toBe(AGENT_ID)
    expect(req.frame.payload.limit).toBe(50) // zod default
    expect(req.frame.payload.cursor).toBe('c-100')
    const legacyReq = decodeEnvelope(envelope('session/history', { sessionId: SESSION_ID }))
    expect(legacyReq.ok).toBe(true)
    if (!legacyReq.ok || !isFrame('session/history')(legacyReq.frame))
      throw new Error('expected legacy session/history')
    expect(legacyReq.frame.payload.agentId).toBeUndefined()
    const tailReq = decodeEnvelope(
      envelope('session/history', { agentId: AGENT_ID, sessionId: SESSION_ID, after: '42' })
    )
    expect(tailReq.ok).toBe(true)
    if (!tailReq.ok || !isFrame('session/history')(tailReq.frame)) throw new Error('expected tail request')
    expect(tailReq.frame.payload.after).toBe('42')
    expect(
      decodeEnvelope(
        envelope('session/history', {
          agentId: AGENT_ID,
          sessionId: SESSION_ID,
          cursor: 'older',
          after: '42'
        })
      ).ok
    ).toBe(false)

    const page = decodeEnvelope(
      envelope('session/history/page', {
        sessionId: SESSION_ID,
        messages: [
          {
            seq: 1,
            sender: '@dana',
            trustedAgentBot: true,
            ts: '1718000000.000100',
            kind: 'text',
            text: 'ship it',
            attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: 'aW1hZ2U=' }]
          }
        ],
        nextCursor: 'c-50',
        liveCursor: '42',
        liveMore: true
      })
    )
    expect(page.ok).toBe(true)
    if (!page.ok || !isFrame('session/history/page')(page.frame)) throw new Error('expected page')
    expect(page.frame.payload.messages[0]!.text).toBe('ship it')
    expect(page.frame.payload.messages[0]!.trustedAgentBot).toBe(true)
    expect(page.frame.payload.messages[0]!.attachments?.[0]?.name).toBe('screen.webp')
    expect(page.frame.payload.nextCursor).toBe('c-50')
    expect(page.frame.payload.liveCursor).toBe('42')
    expect(page.frame.payload.liveMore).toBe(true)
  })

  it('session/history/page carries an enriched tool row (body + tool metadata)', () => {
    const body = JSON.stringify({
      toolCallId: 'tc-1',
      kind: 'read',
      status: 'completed',
      rawInput: { path: 'README.md' },
      rawOutput: '# AgentConnect',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      locations: [{ path: 'README.md', line: 1 }]
    })
    const page = decodeEnvelope(
      envelope('session/history/page', {
        sessionId: SESSION_ID,
        messages: [
          {
            seq: 2,
            sender: 'agent',
            ts: '1718000001.000200',
            kind: 'tool',
            text: 'Read README.md',
            toolCallId: 'tc-1',
            toolStatus: 'completed',
            toolKind: 'read',
            body,
            bodyTruncated: true,
            bodyBytes: 123456
          }
        ]
      })
    )
    expect(page.ok).toBe(true)
    if (!page.ok || !isFrame('session/history/page')(page.frame)) throw new Error('expected page')
    const m = page.frame.payload.messages[0]!
    expect(m.toolCallId).toBe('tc-1')
    expect(m.toolStatus).toBe('completed')
    expect(m.toolKind).toBe('read')
    expect(m.bodyTruncated).toBe(true)
    expect(m.bodyBytes).toBe(123456)
    // the inline preview must be parseable JSON (the web calls JSON.parse on it)
    expect(JSON.parse(m.body!).rawInput).toEqual({ path: 'README.md' })
  })

  it('session/tool-body REQ defaults offset to 0; session/tool-body/chunk round-trips with nextOffset', () => {
    const req = decodeEnvelope(
      envelope('session/tool-body', { agentId: AGENT_ID, sessionId: SESSION_ID, toolCallId: 'tc-1' })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('session/tool-body')(req.frame)) throw new Error('expected session/tool-body')
    expect(req.frame.payload.agentId).toBe(AGENT_ID)
    expect(req.frame.payload.offset).toBe(0) // zod default
    const legacyReq = decodeEnvelope(envelope('session/tool-body', { sessionId: SESSION_ID, toolCallId: 'tc-1' }))
    expect(legacyReq.ok).toBe(true)
    if (!legacyReq.ok || !isFrame('session/tool-body')(legacyReq.frame))
      throw new Error('expected legacy session/tool-body')
    expect(legacyReq.frame.payload.agentId).toBeUndefined()

    const chunk = decodeEnvelope(
      envelope(
        'session/tool-body/chunk',
        { sessionId: SESSION_ID, toolCallId: 'tc-1', data: '{"toolCallId":"tc', totalBytes: 4096, nextOffset: 2048 },
        { corr: ID }
      )
    )
    expect(chunk.ok).toBe(true)
    if (!chunk.ok || !isFrame('session/tool-body/chunk')(chunk.frame)) throw new Error('expected chunk')
    expect(chunk.frame.corr).toBe(ID)
    expect(chunk.frame.payload.data).toBe('{"toolCallId":"tc')
    expect(chunk.frame.payload.totalBytes).toBe(4096)
    expect(chunk.frame.payload.nextOffset).toBe(2048)

    // last chunk omits nextOffset
    const last = decodeEnvelope(
      envelope('session/tool-body/chunk', { sessionId: SESSION_ID, toolCallId: 'tc-1', data: '"}', totalBytes: 4096 })
    )
    expect(last.ok).toBe(true)
    if (!last.ok || !isFrame('session/tool-body/chunk')(last.frame)) throw new Error('expected chunk')
    expect(last.frame.payload.nextOffset).toBeUndefined()
  })
})

describe('milestone A4 gate — the CP is off the webchat hot path', () => {
  it('the daemon↔CP frame registry carries NO webchat content frame type', () => {
    // Webchat content rides the relay `rd/*` wire. Metadata and secret grant
    // lifecycle frames are the only allowlisted webchat namespace on the control
    // WebSocket; no message body or ACP stream may appear here.
    const allowedWebchatControlTypes = [
      'webchat/mcp-grant/issue',
      'webchat/mcp-grant/issued',
      'webchat/mcp-grant/accept',
      'webchat/mcp-grant/activate',
      'webchat/mcp-grant/revoke',
      'webchat/mcp-grant/revoked'
    ] as const
    const unexpectedWebchatTypes = (types: readonly string[]) =>
      types.filter(
        (type) => type.startsWith('webchat/') && !allowedWebchatControlTypes.some((allowed) => type === allowed)
      )

    expect(FRAME_TYPES.filter((type) => type.startsWith('webchat/'))).toEqual(allowedWebchatControlTypes)
    expect(Object.keys(FRAME_SCHEMAS).filter((type) => type.startsWith('webchat/'))).toEqual(allowedWebchatControlTypes)
    expect(unexpectedWebchatTypes(FRAME_TYPES)).toEqual([])
    expect(unexpectedWebchatTypes([...FRAME_TYPES, 'webchat/stream'])).toEqual(['webchat/stream'])
  })
})

describe('workspace file access frames (console live proxy)', () => {
  it('workspace/list REQ round-trips with the CP epoch ext (no seq/launchId)', () => {
    const r = decodeEnvelope(
      envelope(
        'workspace/list',
        { agentId: 'local-agent-1', sessionId: 'session-a', path: 'src/frames', cursor: 'c-1', limit: 100 },
        { epoch: 3 }
      )
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('workspace/list')(r.frame)) throw new Error('expected workspace/list')
    expect(r.frame.payload.agentId).toBe('local-agent-1') // plain string, NOT a uuid
    expect(r.frame.payload.sessionId).toBe('session-a')
    expect(r.frame.payload.path).toBe('src/frames')
    expect(r.frame.payload.cursor).toBe('c-1')
    expect(r.frame.payload.limit).toBe(100)
    expect(r.ext).toEqual({ epoch: 3 }) // fenced like session/list — epoch only
  })

  it('every workspace REQ round-trips the secondary-root repo scope, and omits it by default', () => {
    // One `owner/repo` names the secondary root each frame reads or writes; absent ⇒ the primary.
    const scoped: [string, Record<string, unknown>][] = [
      ['workspace/list', { agentId: 'a', path: 'src' }],
      ['workspace/read', { agentId: 'a', path: 'README.md' }],
      ['workspace/gitstatus', { agentId: 'a' }],
      ['workspace/gitdiff', { agentId: 'a', path: 'README.md' }],
      ['workspace/gitlog', { agentId: 'a' }],
      ['workspace/gitpull', { agentId: 'a' }],
      ['workspace/gitstage', { agentId: 'a', paths: ['README.md'] }],
      ['workspace/gitunstage', { agentId: 'a', paths: ['README.md'] }],
      ['workspace/gitcommit', { agentId: 'a', message: 'chore: touch' }],
      ['workspace/gitpush', { agentId: 'a' }],
      ['workspace/gitmessage', { agentId: 'a' }]
    ]
    for (const [type, payload] of scoped) {
      const withRepo = decodeEnvelope(envelope(type, { ...payload, repo: 'acme/infra' }))
      expect(withRepo.ok, type).toBe(true)
      if (!withRepo.ok) throw new Error(`expected ${type}`)
      expect((withRepo.frame.payload as { repo?: string }).repo, type).toBe('acme/infra')

      const primary = decodeEnvelope(envelope(type, payload))
      expect(primary.ok, type).toBe(true)
      if (!primary.ok) throw new Error(`expected ${type}`)
      expect((primary.frame.payload as { repo?: string }).repo, type).toBeUndefined()

      // An empty scope is a bad request, not "the primary" — the caller must simply omit it.
      expect(decodeEnvelope(envelope(type, { ...payload, repo: '' })).ok, type).toBe(false)
    }
  })

  it('workspace/list/page REP (corr = req id) round-trips entries + cursor and exists:false', () => {
    const page = decodeEnvelope(
      envelope(
        'workspace/list/page',
        {
          agentId: 'local-agent-1',
          path: 'src/frames',
          exists: true,
          entries: [
            { name: 'session.ts', type: 'file', size: 4096, mtime: '2026-06-24T00:00:00.000Z' },
            { name: 'fixtures', type: 'dir' },
            { name: 'link', type: 'symlink' }
          ],
          nextCursor: 'c-2'
        },
        { corr: ID }
      )
    )
    expect(page.ok).toBe(true)
    if (!page.ok || !isFrame('workspace/list/page')(page.frame)) throw new Error('expected list page')
    expect(page.frame.corr).toBe(ID)
    expect(page.frame.payload.entries).toHaveLength(3)
    expect(page.frame.payload.entries[0]).toEqual({
      name: 'session.ts',
      type: 'file',
      size: 4096,
      mtime: '2026-06-24T00:00:00.000Z'
    })
    expect(page.frame.payload.entries[1]).toEqual({ name: 'fixtures', type: 'dir' }) // size/mtime optional
    expect(page.frame.payload.nextCursor).toBe('c-2')

    // missing dir is DATA, not an error frame
    const missing = decodeEnvelope(
      envelope('workspace/list/page', { agentId: 'local-agent-1', path: 'no/such/dir', exists: false, entries: [] })
    )
    expect(missing.ok).toBe(true)
    if (!missing.ok || !isFrame('workspace/list/page')(missing.frame)) throw new Error('expected list page')
    expect(missing.frame.payload.exists).toBe(false)
    expect(missing.frame.payload.entries).toEqual([])
  })

  it('workspace/read REQ round-trips an offset slice request', () => {
    const r = decodeEnvelope(
      envelope('workspace/read', { agentId: 'local-agent-1', path: 'README.md', offset: 65536, limit: 1024 })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('workspace/read')(r.frame)) throw new Error('expected workspace/read')
    expect(r.frame.payload.path).toBe('README.md')
    expect(r.frame.payload.offset).toBe(65536)
    expect(r.frame.payload.limit).toBe(1024)
    // slice cap is 64 KiB — over ⇒ payload validation failure
    const over = decodeEnvelope(
      envelope('workspace/read', { agentId: 'local-agent-1', path: 'README.md', limit: 65537 })
    )
    expect(over.ok).toBe(false)
  })

  it('workspace/read/content REP (corr = req id) round-trips a utf8 slice, binary, and exists:false', () => {
    const utf8 = decodeEnvelope(
      envelope(
        'workspace/read/content',
        {
          agentId: 'local-agent-1',
          path: 'README.md',
          exists: true,
          size: 131072,
          mtime: '2026-06-24T00:00:00.000Z',
          encoding: 'utf8',
          content: '# AgentConnect',
          offset: 0,
          truncated: true
        },
        { corr: ID }
      )
    )
    expect(utf8.ok).toBe(true)
    if (!utf8.ok || !isFrame('workspace/read/content')(utf8.frame)) throw new Error('expected read content')
    expect(utf8.frame.corr).toBe(ID)
    expect(utf8.frame.payload.content).toBe('# AgentConnect')
    expect(utf8.frame.payload.truncated).toBe(true) // offset+slice < size

    // binary detected ⇒ encoding 'none', content omitted
    const binary = decodeEnvelope(
      envelope('workspace/read/content', {
        agentId: 'local-agent-1',
        path: 'logo.png',
        exists: true,
        size: 2048,
        encoding: 'none'
      })
    )
    expect(binary.ok).toBe(true)
    if (!binary.ok || !isFrame('workspace/read/content')(binary.frame)) throw new Error('expected read content')
    expect(binary.frame.payload.encoding).toBe('none')
    expect(binary.frame.payload.content).toBeUndefined()

    // missing file is DATA, not an error frame
    const missing = decodeEnvelope(
      envelope('workspace/read/content', { agentId: 'local-agent-1', path: 'gone.txt', exists: false })
    )
    expect(missing.ok).toBe(true)
    if (!missing.ok || !isFrame('workspace/read/content')(missing.frame)) throw new Error('expected read content')
    expect(missing.frame.payload.exists).toBe(false)
  })

  it('workspace REQs apply zod defaults (list path/limit, read offset/limit)', () => {
    const list = decodeEnvelope(envelope('workspace/list', { agentId: 'local-agent-1' }))
    expect(list.ok).toBe(true)
    if (!list.ok || !isFrame('workspace/list')(list.frame)) throw new Error('expected workspace/list')
    expect(list.frame.payload.path).toBe('') // zod default ⇒ workspace root
    expect(list.frame.payload.limit).toBe(200) // zod default

    const read = decodeEnvelope(envelope('workspace/read', { agentId: 'local-agent-1', path: 'README.md' }))
    expect(read.ok).toBe(true)
    if (!read.ok || !isFrame('workspace/read')(read.frame)) throw new Error('expected workspace/read')
    expect(read.frame.payload.offset).toBe(0) // zod default
    expect(read.frame.payload.limit).toBe(65536) // zod default (64 KiB slice)
  })

  it('workspace/delete REQ and REP round-trip the optimistic file identity', () => {
    const req = decodeEnvelope(
      envelope(
        'workspace/delete',
        {
          agentId: 'local-agent-1',
          path: 'notes/todo.md',
          ifMatchMtime: '2026-07-25T00:00:00.000Z'
        },
        { epoch: 3 }
      )
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/delete')(req.frame)) throw new Error('expected workspace/delete')
    expect(req.frame.payload.path).toBe('notes/todo.md')

    const rep = decodeEnvelope(
      envelope('workspace/delete/ok', { agentId: 'local-agent-1', path: 'notes/todo.md' }, { corr: ID })
    )
    expect(rep.ok).toBe(true)
    if (!rep.ok || !isFrame('workspace/delete/ok')(rep.frame)) throw new Error('expected workspace/delete/ok')
    expect(rep.frame.corr).toBe(ID)
  })

  it('workspace/read/content REP carries a not-a-regular-file path as DATA (type, no content)', () => {
    const dir = decodeEnvelope(
      envelope(
        'workspace/read/content',
        { agentId: 'local-agent-1', path: 'src', exists: true, type: 'dir', mtime: '2026-06-24T00:00:00.000Z' },
        { corr: ID }
      )
    )
    expect(dir.ok).toBe(true)
    if (!dir.ok || !isFrame('workspace/read/content')(dir.frame)) throw new Error('expected read content')
    expect(dir.frame.corr).toBe(ID)
    expect(dir.frame.payload.exists).toBe(true) // a directory is a fact about the path, not an error frame
    expect(dir.frame.payload.type).toBe('dir')
    expect(dir.frame.payload.encoding).toBeUndefined()
    expect(dir.frame.payload.content).toBeUndefined()

    // `type` is a closed vocabulary, and absent from an older daemon's slice.
    const bogus = decodeEnvelope(
      envelope('workspace/read/content', { agentId: 'local-agent-1', path: 'src', exists: true, type: 'symlink' })
    )
    expect(bogus.ok).toBe(false)
    const legacy = decodeEnvelope(
      envelope('workspace/read/content', {
        agentId: 'local-agent-1',
        path: 'README.md',
        exists: true,
        size: 12,
        encoding: 'utf8',
        content: '# hi',
        offset: 0,
        nextOffset: 4,
        truncated: true
      })
    )
    expect(legacy.ok).toBe(true)
    if (!legacy.ok || !isFrame('workspace/read/content')(legacy.frame)) throw new Error('expected read content')
    expect(legacy.frame.payload.type).toBeUndefined()
  })
})

describe('workspace git review frames (status counts, diff, log)', () => {
  it('workspace/gitstatus REQ/REP round-trip, and numstat counts are per-file OPTIONAL', () => {
    const req = decodeEnvelope(
      envelope('workspace/gitstatus', { agentId: 'local-agent-1', sessionId: 'session-a' }, { epoch: 3 })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitstatus')(req.frame)) throw new Error('expected workspace/gitstatus')
    expect(req.frame.payload.sessionId).toBe('session-a')
    expect(req.ext).toEqual({ epoch: 3 }) // fenced epoch-only like the rest of the family

    const rep = decodeEnvelope(
      envelope(
        'workspace/gitstatus/result',
        {
          agentId: 'local-agent-1',
          isRepo: true,
          clean: false,
          branch: 'main',
          tracking: 'origin/main',
          ahead: 1,
          behind: 0,
          files: [
            { path: 'src/a.ts', index: 'M', workingDir: ' ', additions: 128, deletions: 12 },
            { path: 'new.txt', index: '?', workingDir: '?' }
          ]
        },
        { corr: ID }
      )
    )
    expect(rep.ok).toBe(true)
    if (!rep.ok || !isFrame('workspace/gitstatus/result')(rep.frame)) throw new Error('expected gitstatus result')
    expect(rep.frame.corr).toBe(ID)
    expect(rep.frame.payload.files?.[0]).toEqual({
      path: 'src/a.ts',
      index: 'M',
      workingDir: ' ',
      additions: 128,
      deletions: 12
    })
    // An older daemon (and an untracked file) send no counts — absent stays absent, never 0.
    expect(rep.frame.payload.files?.[1]).toEqual({ path: 'new.txt', index: '?', workingDir: '?' })
    expect(rep.frame.payload.files?.[1]?.additions).toBeUndefined()
    expect(rep.frame.payload.files?.[1]?.deletions).toBeUndefined()

    // Counts are line counts, never negative.
    const negative = decodeEnvelope(
      envelope('workspace/gitstatus/result', {
        agentId: 'local-agent-1',
        isRepo: true,
        clean: false,
        files: [{ path: 'src/a.ts', index: 'M', workingDir: ' ', additions: -1 }]
      })
    )
    expect(negative.ok).toBe(false)
  })

  it('workspace/gitdiff REQ round-trips the scope, defaults staged:false, and bounds the path', () => {
    const req = decodeEnvelope(
      envelope(
        'workspace/gitdiff',
        { agentId: 'local-agent-1', sessionId: 'session-a', path: 'src/a.ts', staged: true },
        { epoch: 3 }
      )
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitdiff')(req.frame)) throw new Error('expected workspace/gitdiff')
    expect(req.frame.payload.path).toBe('src/a.ts')
    expect(req.frame.payload.staged).toBe(true)
    expect(req.ext).toEqual({ epoch: 3 })

    const bare = decodeEnvelope(envelope('workspace/gitdiff', { agentId: 'local-agent-1', path: 'src/a.ts' }))
    expect(bare.ok).toBe(true)
    if (!bare.ok || !isFrame('workspace/gitdiff')(bare.frame)) throw new Error('expected workspace/gitdiff')
    expect(bare.frame.payload.staged).toBe(false) // zod default ⇒ worktree vs index
    expect(bare.frame.payload.sessionId).toBeUndefined() // primary checkout

    const over = decodeEnvelope(envelope('workspace/gitdiff', { agentId: 'local-agent-1', path: 'x'.repeat(4097) }))
    expect(over.ok).toBe(false) // path cap is 4096, as on write/delete
  })

  it('workspace/gitdiff/result REP round-trips a diff, and binary / unchanged / non-repo as DATA', () => {
    const text = decodeEnvelope(
      envelope(
        'workspace/gitdiff/result',
        {
          agentId: 'local-agent-1',
          path: 'src/a.ts',
          isRepo: true,
          exists: true,
          diff: '@@ -1,2 +1,2 @@\n-old\n+new\n',
          truncated: true
        },
        { corr: ID }
      )
    )
    expect(text.ok).toBe(true)
    if (!text.ok || !isFrame('workspace/gitdiff/result')(text.frame)) throw new Error('expected gitdiff result')
    expect(text.frame.corr).toBe(ID)
    expect(text.frame.payload.diff).toBe('@@ -1,2 +1,2 @@\n-old\n+new\n')
    expect(text.frame.payload.truncated).toBe(true)
    expect(text.frame.payload.binary).toBeUndefined()

    // binary change ⇒ no text to show, still a normal REP
    const binary = decodeEnvelope(
      envelope('workspace/gitdiff/result', {
        agentId: 'local-agent-1',
        path: 'logo.png',
        isRepo: true,
        exists: true,
        binary: true
      })
    )
    expect(binary.ok).toBe(true)
    if (!binary.ok || !isFrame('workspace/gitdiff/result')(binary.frame)) throw new Error('expected gitdiff result')
    expect(binary.frame.payload.binary).toBe(true)
    expect(binary.frame.payload.diff).toBeUndefined()

    // unchanged path: exists, no diff, not binary
    const unchanged = decodeEnvelope(
      envelope('workspace/gitdiff/result', {
        agentId: 'local-agent-1',
        path: 'src/a.ts',
        isRepo: true,
        exists: true
      })
    )
    expect(unchanged.ok).toBe(true)
    if (!unchanged.ok || !isFrame('workspace/gitdiff/result')(unchanged.frame)) {
      throw new Error('expected gitdiff result')
    }
    expect(unchanged.frame.payload.diff).toBeUndefined()
    expect(unchanged.frame.payload.exists).toBe(true)

    // from-scratch workspace: isRepo:false is DATA, not an error frame
    const scratch = decodeEnvelope(
      envelope('workspace/gitdiff/result', {
        agentId: 'local-agent-1',
        path: 'src/a.ts',
        isRepo: false,
        exists: false
      })
    )
    expect(scratch.ok).toBe(true)
    if (!scratch.ok || !isFrame('workspace/gitdiff/result')(scratch.frame)) throw new Error('expected gitdiff result')
    expect(scratch.frame.payload.isRepo).toBe(false)
  })

  it('workspace/gitlog REQ defaults its limit and rejects one over the 50-commit cap', () => {
    const req = decodeEnvelope(envelope('workspace/gitlog', { agentId: 'local-agent-1', limit: 50 }, { epoch: 3 }))
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitlog')(req.frame)) throw new Error('expected workspace/gitlog')
    expect(req.frame.payload.limit).toBe(50)
    expect(req.ext).toEqual({ epoch: 3 })

    const bare = decodeEnvelope(envelope('workspace/gitlog', { agentId: 'local-agent-1' }))
    expect(bare.ok).toBe(true)
    if (!bare.ok || !isFrame('workspace/gitlog')(bare.frame)) throw new Error('expected workspace/gitlog')
    expect(bare.frame.payload.limit).toBe(20) // zod default

    expect(decodeEnvelope(envelope('workspace/gitlog', { agentId: 'local-agent-1', limit: 51 })).ok).toBe(false)
    expect(decodeEnvelope(envelope('workspace/gitlog', { agentId: 'local-agent-1', limit: 0 })).ok).toBe(false)
  })

  it('workspace/gitlog/result REP round-trips pushed markers, an untracked branch, and an empty repo', () => {
    const rep = decodeEnvelope(
      envelope(
        'workspace/gitlog/result',
        {
          agentId: 'local-agent-1',
          isRepo: true,
          truncated: true,
          tracking: 'origin/main',
          commits: [
            {
              sha: 'a3f9c21deadbeef0000000000000000000000000',
              shortSha: 'a3f9c21',
              subject: 'Pin deploy image',
              author: 'Ada Lovelace',
              committedAt: '2026-07-02T07:00:00+00:00',
              pushed: false
            },
            {
              sha: 'b0b0b0b0deadbeef0000000000000000000000000',
              shortSha: 'b0b0b0b',
              subject: 'Add the dock',
              author: 'Ada Lovelace',
              committedAt: '2026-07-01T07:00:00+00:00',
              pushed: true
            }
          ]
        },
        { corr: ID }
      )
    )
    expect(rep.ok).toBe(true)
    if (!rep.ok || !isFrame('workspace/gitlog/result')(rep.frame)) throw new Error('expected gitlog result')
    expect(rep.frame.corr).toBe(ID)
    expect(rep.frame.payload.commits.map((c) => c.pushed)).toEqual([false, true])
    expect(rep.frame.payload.tracking).toBe('origin/main')
    expect(rep.frame.payload.truncated).toBe(true)

    // A branch that tracks nothing: no `tracking`, so `pushed:false` means "no upstream to be on".
    const untracked = decodeEnvelope(
      envelope('workspace/gitlog/result', {
        agentId: 'local-agent-1',
        isRepo: true,
        truncated: false,
        commits: [
          {
            sha: 'a3f9c21deadbeef0000000000000000000000000',
            shortSha: 'a3f9c21',
            subject: 'Initial import',
            author: 'Ada Lovelace',
            committedAt: '2026-07-02T07:00:00+00:00',
            pushed: false
          }
        ]
      })
    )
    expect(untracked.ok).toBe(true)
    if (!untracked.ok || !isFrame('workspace/gitlog/result')(untracked.frame)) {
      throw new Error('expected gitlog result')
    }
    expect(untracked.frame.payload.tracking).toBeUndefined()

    // An empty repo (no commits yet) is DATA, and a page over the cap is not decodable.
    const empty = decodeEnvelope(
      envelope('workspace/gitlog/result', { agentId: 'local-agent-1', isRepo: true, commits: [], truncated: false })
    )
    expect(empty.ok).toBe(true)
    const commit = {
      sha: 'a3f9c21deadbeef0000000000000000000000000',
      shortSha: 'a3f9c21',
      subject: 's',
      author: 'a',
      committedAt: '2026-07-02T07:00:00+00:00',
      pushed: true
    }
    const overCap = decodeEnvelope(
      envelope('workspace/gitlog/result', {
        agentId: 'local-agent-1',
        isRepo: true,
        truncated: true,
        commits: Array.from({ length: 51 }, () => commit)
      })
    )
    expect(overCap.ok).toBe(false)
  })

  it('keeps a worst-case escaped gitlog page below the wire cap', () => {
    // NUL is the largest ordinary JSON string expansion (`\\u0000`, six wire bytes per
    // input character), so filling every display cap with it covers the maxima.
    const escaped = '\u0000'
    const commit = {
      sha: 'a3f9c21deadbeef0000000000000000000000000',
      shortSha: 'a3f9c21',
      subject: escaped.repeat(MAX_WORKSPACE_COMMIT_SUBJECT),
      author: escaped.repeat(MAX_WORKSPACE_COMMIT_AUTHOR),
      committedAt: '2026-07-02T07:00:00+00:00',
      pushed: false
    }
    const encoded = encode(
      buildEnvelope('workspace/gitlog/result', {
        agentId: escaped.repeat(255),
        isRepo: true,
        truncated: true,
        tracking: escaped.repeat(255),
        commits: Array.from({ length: MAX_WORKSPACE_LOG_COMMITS }, () => commit)
      })
    )
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const decoded = decodeEnvelope(encoded)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('workspace/gitlog/result')(decoded.frame)) throw new Error('expected gitlog result')
    expect(decoded.frame.payload.commits).toHaveLength(MAX_WORKSPACE_LOG_COMMITS)
  })

  it('workspace/gitstage REQ round-trips paths, accepts an empty list, and bounds count + bytes', () => {
    const req = decodeEnvelope(
      envelope(
        'workspace/gitstage',
        { agentId: 'local-agent-1', sessionId: 'session-a', paths: ['src/a.ts', 'src/b.ts'] },
        { epoch: 3 }
      )
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitstage')(req.frame)) throw new Error('expected workspace/gitstage')
    expect(req.frame.payload.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(req.ext).toEqual({ epoch: 3 })

    // Staging nothing is DATA, so an empty selection must DECODE — the daemon answers with the
    // fresh status rather than a BAD_PAYLOAD.
    const empty = decodeEnvelope(envelope('workspace/gitstage', { agentId: 'local-agent-1', paths: [] }))
    expect(empty.ok).toBe(true)
    if (!empty.ok || !isFrame('workspace/gitstage')(empty.frame)) throw new Error('expected workspace/gitstage')
    expect(empty.frame.payload.paths).toEqual([])
    expect(empty.frame.payload.sessionId).toBeUndefined() // primary checkout

    const overCount = decodeEnvelope(
      envelope('workspace/gitstage', {
        agentId: 'local-agent-1',
        paths: Array.from({ length: MAX_WORKSPACE_STAGE_PATHS + 1 }, (_, index) => `f${index}.ts`)
      })
    )
    expect(overCount.ok).toBe(false)

    // Under the count cap but over the byte total — the bound that keeps the REQ frame-safe.
    const overBytes = decodeEnvelope(
      envelope('workspace/gitstage', {
        agentId: 'local-agent-1',
        paths: Array.from({ length: 20 }, () => 'x'.repeat(Math.ceil(MAX_WORKSPACE_STAGE_PATH_BYTES / 20) + 1))
      })
    )
    expect(overBytes.ok).toBe(false)

    const overPath = decodeEnvelope(
      envelope('workspace/gitstage', { agentId: 'local-agent-1', paths: ['x'.repeat(4097)] })
    )
    expect(overPath.ok).toBe(false) // per-path cap is 4096, as on write/delete
  })

  it('workspace/gitunstage shares the stage REQ shape and answers with a status', () => {
    const req = decodeEnvelope(envelope('workspace/gitunstage', { agentId: 'local-agent-1', paths: ['src/a.ts'] }))
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitunstage')(req.frame)) throw new Error('expected workspace/gitunstage')
    expect(req.frame.payload.paths).toEqual(['src/a.ts'])

    // Both write REPs are the FRESH status, so the panel never re-polls for its own action.
    for (const type of ['workspace/gitstage/result', 'workspace/gitunstage/result'] as const) {
      const rep = decodeEnvelope(
        envelope(
          type,
          {
            agentId: 'local-agent-1',
            isRepo: true,
            clean: false,
            branch: 'main',
            files: [{ path: 'src/a.ts', index: 'M', workingDir: ' ', additions: 4, deletions: 1 }]
          },
          { corr: ID }
        )
      )
      expect(rep.ok).toBe(true)
      if (!rep.ok || !isFrame(type)(rep.frame)) throw new Error(`expected ${type}`)
      expect(rep.frame.corr).toBe(ID)
      expect(rep.frame.payload.files?.[0]).toEqual({
        path: 'src/a.ts',
        index: 'M',
        workingDir: ' ',
        additions: 4,
        deletions: 1
      })
    }
  })

  it('keeps a worst-case escaped gitstage REQ below the wire cap', () => {
    // NUL is the largest ordinary JSON string expansion (six wire bytes per input character) and
    // a path may legally contain one, so the byte cap has to hold at that expansion.
    const escaped = '\u0000'
    const perPath = Math.floor(MAX_WORKSPACE_STAGE_PATH_BYTES / MAX_WORKSPACE_STAGE_PATHS)
    const encoded = encode(
      buildEnvelope('workspace/gitstage', {
        agentId: escaped.repeat(255),
        sessionId: escaped.repeat(255),
        paths: Array.from({ length: MAX_WORKSPACE_STAGE_PATHS }, () => escaped.repeat(perPath))
      })
    )
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const decoded = decodeEnvelope(encoded)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('workspace/gitstage')(decoded.frame)) throw new Error('expected workspace/gitstage')
    expect(decoded.frame.payload.paths).toHaveLength(MAX_WORKSPACE_STAGE_PATHS)
  })

  it('workspace/gitcommit round-trips the message, bounds it, and carries a refusal as DATA', () => {
    const req = decodeEnvelope(
      envelope(
        'workspace/gitcommit',
        { agentId: 'local-agent-1', sessionId: 'session-a', message: 'feat: add the dock\n\nBody line.' },
        { epoch: 3 }
      )
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitcommit')(req.frame)) throw new Error('expected workspace/gitcommit')
    expect(req.frame.payload.message).toBe('feat: add the dock\n\nBody line.')

    expect(decodeEnvelope(envelope('workspace/gitcommit', { agentId: 'local-agent-1', message: '' })).ok).toBe(false)
    expect(
      decodeEnvelope(
        envelope('workspace/gitcommit', {
          agentId: 'local-agent-1',
          message: 'x'.repeat(MAX_WORKSPACE_COMMIT_MESSAGE + 1)
        })
      ).ok
    ).toBe(false)

    const made = decodeEnvelope(
      envelope(
        'workspace/gitcommit/result',
        {
          agentId: 'local-agent-1',
          isRepo: true,
          ok: true,
          sha: 'a3f9c21deadbeef0000000000000000000000000',
          detail: 'Committed a3f9c21 — 2 files.'
        },
        { corr: ID }
      )
    )
    expect(made.ok).toBe(true)
    if (!made.ok || !isFrame('workspace/gitcommit/result')(made.frame)) throw new Error('expected gitcommit result')
    expect(made.frame.payload.sha).toBe('a3f9c21deadbeef0000000000000000000000000')
    expect(made.frame.payload.reason).toBeUndefined() // `reason` rides along only with ok:false

    // Nothing staged, and a daemon with no registered identity, are both ordinary REPs.
    for (const reason of ['nothing-staged', 'no-identity'] as const) {
      const refused = decodeEnvelope(
        envelope('workspace/gitcommit/result', {
          agentId: 'local-agent-1',
          isRepo: true,
          ok: false,
          reason,
          detail: 'refused'
        })
      )
      expect(refused.ok).toBe(true)
      if (!refused.ok || !isFrame('workspace/gitcommit/result')(refused.frame)) throw new Error('expected result')
      expect(refused.frame.payload.reason).toBe(reason)
      expect(refused.frame.payload.sha).toBeUndefined()
    }

    const scratch = decodeEnvelope(
      envelope('workspace/gitcommit/result', {
        agentId: 'local-agent-1',
        isRepo: false,
        ok: false,
        reason: 'not-a-repo'
      })
    )
    expect(scratch.ok).toBe(true)
  })

  it('workspace/gitpush round-trips a push, and diverged / no-upstream / detached HEAD as DATA', () => {
    const req = decodeEnvelope(
      envelope('workspace/gitpush', { agentId: 'local-agent-1', sessionId: 'session-a' }, { epoch: 3 })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitpush')(req.frame)) throw new Error('expected workspace/gitpush')
    expect(req.frame.payload.sessionId).toBe('session-a')

    const pushed = decodeEnvelope(
      envelope(
        'workspace/gitpush/result',
        { agentId: 'local-agent-1', isRepo: true, ok: true, ahead: 0, detail: 'Pushed 2 commits to main.' },
        { corr: ID }
      )
    )
    expect(pushed.ok).toBe(true)
    if (!pushed.ok || !isFrame('workspace/gitpush/result')(pushed.frame)) throw new Error('expected gitpush result')
    expect(pushed.frame.payload.ahead).toBe(0)
    expect(pushed.frame.payload.reason).toBeUndefined()

    // The three refusals the console offers a different next action for.
    for (const reason of ['diverged', 'no-upstream', 'detached-head'] as const) {
      const refused = decodeEnvelope(
        envelope('workspace/gitpush/result', {
          agentId: 'local-agent-1',
          isRepo: true,
          ok: false,
          ahead: 2,
          reason,
          detail: 'refused'
        })
      )
      expect(refused.ok).toBe(true)
      if (!refused.ok || !isFrame('workspace/gitpush/result')(refused.frame)) throw new Error('expected result')
      expect(refused.frame.payload.reason).toBe(reason)
      expect(refused.frame.payload.ahead).toBe(2) // what did NOT land
    }

    expect(
      decodeEnvelope(
        envelope('workspace/gitpush/result', { agentId: 'local-agent-1', isRepo: true, ok: false, ahead: -1 })
      ).ok
    ).toBe(false)
  })

  it('workspace/gitmessage round-trips a drafted message and carries a refusal as DATA', () => {
    const req = decodeEnvelope(
      envelope('workspace/gitmessage', { agentId: 'local-agent-1', sessionId: 'session-a' }, { epoch: 3 })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('workspace/gitmessage')(req.frame)) throw new Error('expected workspace/gitmessage')
    expect(req.frame.payload.sessionId).toBe('session-a')

    const drafted = decodeEnvelope(
      envelope(
        'workspace/gitmessage/result',
        { agentId: 'local-agent-1', ok: true, message: 'feat(dock): stage files from the git panel\n\nWhy.' },
        { corr: ID }
      )
    )
    expect(drafted.ok).toBe(true)
    if (!drafted.ok || !isFrame('workspace/gitmessage/result')(drafted.frame)) throw new Error('expected result')
    expect(drafted.frame.payload.message).toContain('feat(dock):')
    expect(drafted.frame.payload.detail).toBeUndefined()

    // A runtime that declines is a RESULT, so the console shows the reason instead of an error.
    const declined = decodeEnvelope(
      envelope('workspace/gitmessage/result', {
        agentId: 'local-agent-1',
        ok: false,
        detail: 'Nothing is staged, so there is nothing to describe.'
      })
    )
    expect(declined.ok).toBe(true)

    // The drafted message must fit the commit REQ that will carry it back.
    expect(
      decodeEnvelope(
        envelope('workspace/gitmessage/result', {
          agentId: 'local-agent-1',
          ok: true,
          message: 'x'.repeat(MAX_WORKSPACE_COMMIT_MESSAGE + 1)
        })
      ).ok
    ).toBe(false)
  })

  it('the git write-reason vocabulary is closed', () => {
    expect(WorkspaceGitWriteReason.options).toContain('diverged')
    expect(WorkspaceGitWriteReason.safeParse('no-identity').success).toBe(true)
    expect(WorkspaceGitWriteReason.safeParse('offline').success).toBe(false)
  })

  it('the workspace error-reason vocabulary is closed', () => {
    expect(WorkspaceErrorReason.options).toContain('path-escape')
    expect(WorkspaceErrorReason.safeParse('not-a-file').success).toBe(true)
    expect(WorkspaceErrorReason.safeParse('offline').success).toBe(false)
  })
})

describe('background-task frames (console Tasks panel)', () => {
  it('task/list REQ requires the ACP session id — the lease is per (agent, ACP session)', () => {
    const req = decodeEnvelope(envelope('task/list', { agentId: 'local-agent-1', sessionId: 'acp-1' }, { epoch: 3 }))
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('task/list')(req.frame)) throw new Error('expected task/list')
    expect(req.frame.payload.sessionId).toBe('acp-1')
    expect(req.ext).toEqual({ epoch: 3 })

    // Unlike the workspace reads, `sessionId` is not optional: there is no per-agent lease to fall
    // back to, only a boolean rollup, so an agent-wide task list would be a different question.
    expect(decodeEnvelope(envelope('task/list', { agentId: 'local-agent-1' })).ok).toBe(false)
    expect(decodeEnvelope(envelope('task/list', { agentId: 'local-agent-1', sessionId: '' })).ok).toBe(false)
  })

  it('task/list/result round-trips running / done / failed, a subagent row, and an untracked session', () => {
    const rep = decodeEnvelope(
      envelope(
        'task/list/result',
        {
          agentId: 'local-agent-1',
          sessionId: 'acp-1',
          tracked: true,
          truncated: true,
          tasks: [
            { id: 't1', description: 'Sleep for 15 seconds', state: 'running', subagent: false, startedAt: TS },
            { id: 't2', state: 'done', subagent: false, startedAt: TS, endedAt: TS },
            { id: 't3', state: 'failed', subagent: false, startedAt: TS, endedAt: TS, detail: 'killed' },
            { id: 't4', description: 'general', state: 'running', subagent: true, startedAt: TS }
          ]
        },
        { corr: ID }
      )
    )
    expect(rep.ok).toBe(true)
    if (!rep.ok || !isFrame('task/list/result')(rep.frame)) throw new Error('expected task/list/result')
    expect(rep.frame.corr).toBe(ID)
    expect(rep.frame.payload.tasks.map((t) => t.state)).toEqual(['running', 'done', 'failed', 'running'])
    expect(rep.frame.payload.tasks[0]!.endedAt).toBeUndefined() // a live task has not ended
    expect(rep.frame.payload.tasks[1]!.description).toBeUndefined() // the runtime omitted it
    expect(rep.frame.payload.tasks[3]!.subagent).toBe(true) // carried, not filtered at the source
    expect(rep.frame.payload.truncated).toBe(true)

    // No lease for the session is DATA and is NOT the same statement as "no tasks".
    const untracked = decodeEnvelope(
      envelope('task/list/result', {
        agentId: 'local-agent-1',
        sessionId: 'acp-1',
        tracked: false,
        tasks: [],
        truncated: false
      })
    )
    expect(untracked.ok).toBe(true)
    if (!untracked.ok || !isFrame('task/list/result')(untracked.frame)) throw new Error('expected result')
    expect(untracked.frame.payload.tracked).toBe(false)
  })

  it('bounds the task page, the description and the detail', () => {
    const task = { id: 't', state: 'done' as const, subagent: false, startedAt: TS, endedAt: TS }
    const base = { agentId: 'local-agent-1', sessionId: 'acp-1', tracked: true, truncated: true }
    expect(
      decodeEnvelope(
        envelope('task/list/result', { ...base, tasks: Array.from({ length: MAX_TASK_LIST_TASKS }, () => task) })
      ).ok
    ).toBe(true)
    expect(
      decodeEnvelope(
        envelope('task/list/result', { ...base, tasks: Array.from({ length: MAX_TASK_LIST_TASKS + 1 }, () => task) })
      ).ok
    ).toBe(false)
    expect(
      decodeEnvelope(
        envelope('task/list/result', {
          ...base,
          tasks: [{ ...task, description: 'x'.repeat(MAX_TASK_DESCRIPTION + 1) }]
        })
      ).ok
    ).toBe(false)
    expect(
      decodeEnvelope(
        envelope('task/list/result', { ...base, tasks: [{ ...task, detail: 'x'.repeat(MAX_TASK_DETAIL + 1) }] })
      ).ok
    ).toBe(false)
  })

  it('the task state vocabulary is closed and carries NO `queued`', () => {
    expect(TaskState.options).toEqual(['running', 'done', 'failed'])
    // `task_started` is the feed's only start edge, so nothing upstream can report a queued task.
    expect(TaskState.safeParse('queued').success).toBe(false)
    expect(TaskErrorReason.options).toEqual(['unknown-agent'])
  })

  it('registers no task/cancel — no ACP primitive can address one background task', () => {
    // `session/cancel` carries only `{ sessionId }` and the only hard stop is killing the agent's
    // shared adapter, so a per-task cancel could only cancel unrelated work or lie about having
    // acted. The absence is the design decision, and this is where it is pinned.
    expect(FRAME_TYPES.some((t) => t.startsWith('task/'))).toBe(true)
    expect(FRAME_TYPES.filter((t) => t.startsWith('task/'))).toEqual(['task/list', 'task/list/result'])
  })

  it('keeps a worst-case escaped task page below the wire cap', () => {
    // NUL is the largest ordinary JSON string expansion (six wire bytes per input character), so
    // filling every display cap with it covers the maxima of a full page.
    const escaped = '\u0000'
    const task = {
      id: escaped.repeat(64),
      description: escaped.repeat(MAX_TASK_DESCRIPTION),
      state: 'failed' as const,
      subagent: false,
      startedAt: TS,
      endedAt: TS,
      detail: escaped.repeat(MAX_TASK_DETAIL)
    }
    const encoded = encode(
      buildEnvelope('task/list/result', {
        agentId: escaped.repeat(255),
        sessionId: escaped.repeat(255),
        tracked: true,
        truncated: true,
        tasks: Array.from({ length: MAX_TASK_LIST_TASKS }, () => task)
      })
    )
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const decoded = decodeEnvelope(encoded)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('task/list/result')(decoded.frame)) throw new Error('expected task/list/result')
    expect(decoded.frame.payload.tasks).toHaveLength(MAX_TASK_LIST_TASKS)
  })
})

describe('channel agent directory frames (agent collaboration)', () => {
  it('session/child-status legs round-trip, and reject an unknown status value', () => {
    const req = decodeEnvelope(
      envelope('session/child-status', {
        parentSessionId: 'acp-parent-1',
        childSessionId: 'slack:C1:100.1:peer',
        childAgentId: AGENT_ID
      })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('session/child-status')(req.frame)) throw new Error('expected session/child-status')
    expect(req.frame.payload.childAgentId).toBe(AGENT_ID)

    // The forwarded leg drops childAgentId — placement is already resolved by the CP.
    const probe = decodeEnvelope(
      envelope('session/child-status/probe', {
        parentSessionId: 'acp-parent-1',
        childSessionId: 'slack:C1:100.1:peer'
      })
    )
    expect(probe.ok).toBe(true)

    const ok = decodeEnvelope(
      envelope('session/child-status/ok', {
        found: true,
        agentId: AGENT_ID,
        status: 'in-progress',
        state: 'prompting',
        updatedAt: 17,
        reply: { requested: true, state: 'queued-for-parent' },
        nextAction: 'finish-turn-and-wait',
        message: 'The agent replied. End this turn and wait.'
      })
    )
    expect(ok.ok).toBe(true)
    if (!ok.ok || !isFrame('session/child-status/ok')(ok.frame)) throw new Error('expected session/child-status/ok')
    expect(ok.frame.payload.status).toBe('in-progress')
    expect(ok.frame.payload.reply?.state).toBe('queued-for-parent')

    // A negative verdict carries nothing but `found` (plus a transport reason when applicable).
    expect(decodeEnvelope(envelope('session/child-status/ok', { found: false })).ok).toBe(true)
    expect(decodeEnvelope(envelope('session/child-status/ok', { found: false, reason: 'offline' })).ok).toBe(true)
    // The status vocabulary is closed — a typo must not reach an agent as a valid state.
    expect(decodeEnvelope(envelope('session/child-status/ok', { found: true, status: 'finished' })).ok).toBe(false)
    expect(
      decodeEnvelope(
        envelope('session/child-status/ok', {
          found: true,
          reply: { requested: true, state: 'invented' }
        })
      ).ok
    ).toBe(false)
  })

  it('channel/agents REQ + channel/agents/ok REP round-trip the roster', () => {
    const req = decodeEnvelope(
      envelope('channel/agents', { platform: 'slack', channel: 'C123', requesterAgentId: AGENT_ID })
    )
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('channel/agents')(req.frame)) throw new Error('expected channel/agents')
    expect(req.frame.payload.channel).toBe('C123')
    expect(req.frame.payload.requesterAgentId).toBe(AGENT_ID)

    const ok = decodeEnvelope(
      envelope('channel/agents/ok', {
        platform: 'slack',
        channel: 'C123',
        agents: [
          {
            agentId: AGENT_ID,
            name: 'deploy-bot',
            displayName: 'Deploy Bot',
            description: 'ships deploys',
            status: 'active'
          },
          { agentId: '44444444-4444-4444-8444-444444444444', name: 'triager', status: 'inactive' }
        ]
      })
    )
    expect(ok.ok).toBe(true)
    if (!ok.ok || !isFrame('channel/agents/ok')(ok.frame)) throw new Error('expected channel/agents/ok')
    expect(ok.frame.payload.agents).toHaveLength(2)
    expect(ok.frame.payload.agents[0]!.description).toBe('ships deploys')
    expect(ok.frame.payload.agents[1]!.displayName).toBeUndefined()
  })

  // Channel is a filter, not a gate: the channel-less form is what a session with no IM
  // integration (webchat / hook / dream) sends, and it must decode on both legs.
  it('channel/agents REQ + REP round-trip with NO channel (org-wide directory)', () => {
    const req = decodeEnvelope(envelope('channel/agents', { platform: 'webchat', requesterAgentId: AGENT_ID }))
    expect(req.ok).toBe(true)
    if (!req.ok || !isFrame('channel/agents')(req.frame)) throw new Error('expected channel/agents')
    expect(req.frame.payload.channel).toBeUndefined()

    const ok = decodeEnvelope(
      envelope('channel/agents/ok', {
        platform: 'webchat',
        agents: [{ agentId: AGENT_ID, name: 'deploy-bot', status: 'active' }]
      })
    )
    expect(ok.ok).toBe(true)
    if (!ok.ok || !isFrame('channel/agents/ok')(ok.frame)) throw new Error('expected channel/agents/ok')
    expect(ok.frame.payload.channel).toBeUndefined()
    expect(ok.frame.payload.agents).toHaveLength(1)
  })
})

describe('collaboration/routes snapshot', () => {
  const ORG_ID = 'org_default000000000000000'

  it('round-trips the flat org-scoped agents[] alongside channels[]', () => {
    const r = decodeEnvelope(
      envelope('collaboration/routes', {
        generation: 7,
        channels: [
          {
            orgId: ORG_ID,
            platform: 'slack',
            channelId: 'C123',
            agents: [{ agentId: AGENT_ID, daemonId: DAEMON_ID }]
          }
        ],
        // The integration-less agent exists ONLY here — no channels[] entry can carry it.
        agents: [
          {
            agentId: LAUNCH_ID,
            daemonId: DAEMON_ID,
            orgId: ORG_ID,
            outboundPolicy: 'selected',
            allowedTargetAgentIds: [AGENT_ID],
            name: 'dreamer'
          }
        ]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('collaboration/routes')(r.frame)) throw new Error('expected collaboration/routes')
    expect(r.frame.payload.channels).toHaveLength(1)
    expect(r.frame.payload.agents).toHaveLength(1)
    expect(r.frame.payload.agents[0]!.orgId).toBe(ORG_ID)
    expect(r.frame.payload.agents[0]!.allowedTargetAgentIds).toEqual([AGENT_ID])
    // Placement defaults still apply through the .extend()
    expect(r.frame.payload.agents[0]!.callPolicy).toBe('all')
    expect(r.frame.payload.agents[0]!.allowedCallerAgentIds).toEqual([])
  })

  // An older CP emits no `agents` at all — the snapshot must still decode (default []).
  it('decodes an old-shape snapshot with no agents[]', () => {
    const r = decodeEnvelope(
      envelope('collaboration/routes', {
        generation: 1,
        channels: [{ orgId: ORG_ID, platform: 'slack', channelId: 'C1', agents: [] }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('collaboration/routes')(r.frame)) throw new Error('expected collaboration/routes')
    expect(r.frame.payload.agents).toEqual([])
  })

  // A PENDING entry: the agent exists and its policy is authoritative, but no member is
  // addressable for it yet (an unconfirmed pool grant / a lapsed lease). Only the flat
  // directory may carry one; a channel row still names its daemon.
  it('decodes a flat agent entry with no daemonId as pending, and keeps channel rows strict', () => {
    const r = decodeEnvelope(
      envelope('collaboration/routes', {
        agents: [{ agentId: AGENT_ID, orgId: ORG_ID, callPolicy: 'selected', allowedCallerAgentIds: [LAUNCH_ID] }]
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('collaboration/routes')(r.frame)) throw new Error('expected collaboration/routes')
    expect(r.frame.payload.agents[0]!.daemonId).toBeUndefined()
    expect(r.frame.payload.agents[0]!.allowedCallerAgentIds).toEqual([LAUNCH_ID])
    const channelRow = decodeEnvelope(
      envelope('collaboration/routes', {
        channels: [{ orgId: ORG_ID, platform: 'slack', channelId: 'C1', agents: [{ agentId: AGENT_ID }] }]
      })
    )
    expect(channelRow.ok).toBe(false)
  })

  // orgId is required on a flat entry — cross-org authorization has no fallback scope.
  it('rejects a flat agent entry without orgId', () => {
    const r = decodeEnvelope(envelope('collaboration/routes', { agents: [{ agentId: AGENT_ID, daemonId: DAEMON_ID }] }))
    expect(r.ok).toBe(false)
  })
})

describe('event/session sessionKey (session-metadata sync)', () => {
  it('carries platform/channel/thread + a non-UUID ACP session id (matches usage/report)', () => {
    const r = decodeEnvelope(
      envelope('event/session', {
        sessionId: 'acp-sess-01H9', // ACP session id — a free string, NOT a UUID
        parentSessionId: 'acp-parent-01H8',
        agentId: AGENT_ID,
        launchId: LAUNCH_ID,
        phase: 'plan',
        platform: 'slack',
        channel: 'C123',
        thread: 'T9',
        summary: 'drafted a plan',
        title: 'Roll out api@1.4.2',
        status: 'prompting',
        lastActivityAt: '2026-07-05T00:00:01.000Z',
        triggeredBy: 'U-DANA',
        channelName: 'deploys',
        triggeredByName: 'Dana Reyes',
        threadUrl: 'https://slack.example/archives/C123/pT9',
        observedModel: null,
        ts: '2026-07-05T00:00:00.000Z'
      })
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !isFrame('event/session')(r.frame)) throw new Error('expected event/session')
    expect(r.frame.payload.sessionId).toBe('acp-sess-01H9') // accepted (no uuid constraint)
    expect(r.frame.payload.parentSessionId).toBe('acp-parent-01H8')
    expect(r.frame.payload.platform).toBe('slack')
    expect(r.frame.payload.channel).toBe('C123')
    expect(r.frame.payload.thread).toBe('T9')
    expect(r.frame.payload.title).toBe('Roll out api@1.4.2')
    expect(r.frame.payload.status).toBe('prompting')
    expect(r.frame.payload.observedModel).toBeNull()
    expect(r.frame.payload.lastActivityAt).toBe('2026-07-05T00:00:01.000Z')
    expect(r.frame.payload.triggeredBy).toBe('U-DANA')
    expect(r.frame.payload.channelName).toBe('deploys')
    expect(r.frame.payload.triggeredByName).toBe('Dana Reyes')
    expect(r.frame.payload.threadUrl).toBe('https://slack.example/archives/C123/pT9')
  })

  it('accepts a metadata-only session activity cursor', () => {
    const decoded = decodeEnvelope(
      envelope('event/session-activity', {
        sessionId: 'acp-sess-01H9',
        agentId: AGENT_ID,
        revision: '43',
        ts: '2026-07-05T00:00:02.000Z'
      })
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('event/session-activity')(decoded.frame))
      throw new Error('expected event/session-activity')
    expect(decoded.frame.payload.revision).toBe('43')
  })

  it('round-trips a retention-GC purge receipt (#485)', () => {
    const decoded = decodeEnvelope(
      encode(
        buildEnvelope('event/session-purged', {
          agentId: AGENT_ID,
          sessionIds: ['acp-sess-01H9', 'acp-sess-01HA'],
          reason: 'retention',
          ts: '2026-08-04T09:00:00.000Z'
        })
      )
    )
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('event/session-purged')(decoded.frame)) throw new Error('expected event/session-purged')
    expect(decoded.frame.payload.sessionIds).toEqual(['acp-sess-01H9', 'acp-sess-01HA'])
    expect(decoded.frame.payload.reason).toBe('retention')
  })

  it('rejects a purge receipt with no sessions — an empty report is never a valid claim', () => {
    const decoded = decodeEnvelope(
      envelope('event/session-purged', {
        agentId: AGENT_ID,
        sessionIds: [],
        reason: 'retention',
        ts: '2026-08-04T09:00:00.000Z'
      })
    )
    expect(decoded.ok).toBe(false)
  })
})

describe('gitcred frames (github-app workspace credentials)', () => {
  it('round-trips a gitcred/request through build → encode → decode and narrows', () => {
    const f = buildEnvelope('gitcred/request', { agentId: AGENT_ID, reason: 'clone' })
    const decoded = decodeEnvelope(encode(f))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (!isFrame('gitcred/request')(decoded.frame)) throw new Error('expected a gitcred/request frame')
    expect(decoded.frame.payload.agentId).toBe(AGENT_ID)
    expect(decoded.frame.payload.reason).toBe('clone')
  })

  it('round-trips a gitcred/request with a repoFullName (multi-repo authorization)', () => {
    const f = buildEnvelope('gitcred/request', {
      agentId: AGENT_ID,
      reason: 'helper',
      capabilities: ['contents', 'issues', 'pull_requests', 'actions'],
      repoFullName: 'acme/infra'
    })
    const decoded = decodeEnvelope(encode(f))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (!isFrame('gitcred/request')(decoded.frame)) throw new Error('expected a gitcred/request frame')
    expect(decoded.frame.payload.repoFullName).toBe('acme/infra')
    expect(decoded.frame.payload.capabilities).toEqual(['contents', 'issues', 'pull_requests', 'actions'])
    // Absent field stays absent (pre-multi-repo daemons keep byte-identical frames).
    const bare = decodeEnvelope(encode(buildEnvelope('gitcred/request', { agentId: AGENT_ID })))
    if (!bare.ok || !isFrame('gitcred/request')(bare.frame)) throw new Error('expected a gitcred/request frame')
    expect(bare.frame.payload.repoFullName).toBeUndefined()
  })

  it('round-trips the daemon-owned GitHub hook reply purpose', () => {
    const f = buildEnvelope('gitcred/request', {
      agentId: AGENT_ID,
      reason: 'helper',
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/infra',
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      forceRefresh: true
    })
    const decoded = decodeEnvelope(encode(f))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('gitcred/request')(decoded.frame)) {
      throw new Error('expected a gitcred/request frame')
    }
    expect(decoded.frame.payload.purpose).toBe('github_hook_reply')
    expect(decoded.frame.payload.hookId).toBe(HOOK_ID)
    expect(decoded.frame.payload.forceRefresh).toBe(true)
  })

  it('round-trips a gitcred/grant and preserves a long stateless-format token verbatim', () => {
    // New-format installation tokens (ghs_APPID_JWT) run ~520 chars — no length assumptions.
    const token = `ghs_2345678_${'a'.repeat(500)}.${'b'.repeat(20)}`
    const f = buildEnvelope(
      'gitcred/grant',
      {
        username: 'x-access-token',
        token,
        ttlSec: 3540,
        expiresAt: '2026-07-06T13:00:00.000Z',
        repoFullName: 'acme/infra',
        access: 'write'
      },
      { corr: f0Id() }
    )
    const decoded = decodeEnvelope(encode(f))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (!isFrame('gitcred/grant')(decoded.frame)) throw new Error('expected a gitcred/grant frame')
    expect(decoded.frame.payload.token).toBe(token)
    expect(decoded.frame.payload.username).toBe('x-access-token')
    expect(decoded.frame.payload.ttlSec).toBe(3540)
    expect(decoded.frame.payload.access).toBe('write')
    expect(decoded.frame.corr).toBeDefined()
  })

  it('rejects a gitcred/grant with a foreign username on the GitHub branch (v2 opens it per provider only)', () => {
    const f = buildEnvelope('gitcred/grant', {
      username: 'x-access-token',
      token: 'ghs_x',
      ttlSec: 60,
      expiresAt: '2026-07-06T13:00:00.000Z',
      repoFullName: 'a/b',
      access: 'read'
    })
    const raw = JSON.parse(encode(f)) as Record<string, unknown>
    ;(raw.payload as Record<string, unknown>).username = 'oauth2'
    const decoded = decodeEnvelope(JSON.stringify(raw))
    expect(decoded.ok).toBe(false)
  })
})

describe('memory frames (CP↔daemon agent memory dir)', () => {
  it('round-trips memory/list → memory/list/page', () => {
    const req = buildEnvelope('memory/list', { agentId: 'bot-a' })
    const dReq = decodeEnvelope(encode(req))
    if (!dReq.ok || !isFrame('memory/list')(dReq.frame)) throw new Error('expected memory/list')
    expect(dReq.frame.payload.agentId).toBe('bot-a')

    const rep = buildEnvelope('memory/list/page', {
      agentId: 'bot-a',
      exists: true,
      entries: [
        { name: 'MEMORY.md', size: 42, mtime: TS },
        { name: 'deploys.md', size: 100, mtime: TS }
      ]
    })
    const dRep = decodeEnvelope(encode(rep))
    if (!dRep.ok || !isFrame('memory/list/page')(dRep.frame)) throw new Error('expected memory/list/page')
    expect(dRep.frame.payload.entries).toHaveLength(2)
    expect(dRep.frame.payload.entries[0]!.name).toBe('MEMORY.md')
  })

  it('round-trips memory/read → memory/read/content (path defaults to MEMORY.md)', () => {
    const req = buildEnvelope('memory/read', { agentId: 'bot-a' }) // path/offset/limit default
    const dReq = decodeEnvelope(encode(req))
    if (!dReq.ok || !isFrame('memory/read')(dReq.frame)) throw new Error('expected memory/read')
    expect(dReq.frame.payload.agentId).toBe('bot-a')
    expect(dReq.frame.payload.path).toBe('MEMORY.md')
    expect(dReq.frame.payload.offset).toBe(0)
    expect(dReq.frame.payload.limit).toBe(65536)

    const rep = buildEnvelope('memory/read/content', {
      agentId: 'bot-a',
      path: 'MEMORY.md',
      exists: true,
      size: 12,
      mtime: TS,
      content: '# bot-a memo',
      offset: 0,
      nextOffset: 12,
      truncated: false
    })
    const dRep = decodeEnvelope(encode(rep))
    if (!dRep.ok || !isFrame('memory/read/content')(dRep.frame)) throw new Error('expected memory/read/content')
    expect(dRep.frame.payload.exists).toBe(true)
    expect(dRep.frame.payload.content).toBe('# bot-a memo')
    expect(dRep.frame.payload.nextOffset).toBe(12)
  })

  it('reads a named topic file via path', () => {
    const req = buildEnvelope('memory/read', { agentId: 'bot-a', path: 'deploys.md' })
    const d = decodeEnvelope(encode(req))
    if (!d.ok || !isFrame('memory/read')(d.frame)) throw new Error('expected memory/read')
    expect(d.frame.payload.path).toBe('deploys.md')
  })

  it('encodes a not-yet-created memory file as exists:false (data, not error)', () => {
    const rep = buildEnvelope('memory/read/content', { agentId: 'bot-a', path: 'MEMORY.md', exists: false })
    const d = decodeEnvelope(encode(rep))
    if (!d.ok || !isFrame('memory/read/content')(d.frame)) throw new Error('expected memory/read/content')
    expect(d.frame.payload.exists).toBe(false)
    expect(d.frame.payload.content).toBeUndefined()
  })

  it('round-trips memory/write → memory/write/ok (path defaults to MEMORY.md)', () => {
    const req = buildEnvelope('memory/write', { agentId: 'bot-a', content: '# new memory\n- learned X' })
    const dReq = decodeEnvelope(encode(req))
    if (!dReq.ok || !isFrame('memory/write')(dReq.frame)) throw new Error('expected memory/write')
    expect(dReq.frame.payload.path).toBe('MEMORY.md')
    expect(dReq.frame.payload.content).toContain('learned X')

    const rep = buildEnvelope('memory/write/ok', { agentId: 'bot-a', path: 'deploys.md', size: 24, mtime: TS })
    const dRep = decodeEnvelope(encode(rep))
    if (!dRep.ok || !isFrame('memory/write/ok')(dRep.frame)) throw new Error('expected memory/write/ok')
    expect(dRep.frame.payload.path).toBe('deploys.md')
    expect(dRep.frame.payload.size).toBe(24)
    expect(dRep.frame.payload.mtime).toBe(TS)
  })

  it('rejects memory/write with a missing agentId', () => {
    const raw = envelope('memory/write', { content: 'x' }) // no agentId
    expect(decodeEnvelope(raw).ok).toBe(false)
  })

  it('round-trips newest-first managed memory history pages', () => {
    const cursor = '11111111-1111-4111-8111-111111111111'
    const nextCursor = '22222222-2222-4222-8222-222222222222'
    const req = decodeEnvelope(
      encode(buildEnvelope('memory/history', { agentId: 'bot-a', path: 'deploys.md', cursor }))
    )
    if (!req.ok || !isFrame('memory/history')(req.frame)) throw new Error('expected memory/history')
    expect(req.frame.payload).toMatchObject({ agentId: 'bot-a', path: 'deploys.md', cursor, limit: 5 })

    const rep = decodeEnvelope(
      encode(
        buildEnvelope('memory/history/page', {
          agentId: 'bot-a',
          path: 'deploys.md',
          events: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              path: 'deploys.md',
              event: 'update',
              before: 'v1',
              after: 'v2',
              at: TS,
              scope: 'agent',
              source: 'console'
            }
          ],
          nextCursor
        })
      )
    )
    if (!rep.ok || !isFrame('memory/history/page')(rep.frame)) throw new Error('expected memory/history/page')
    expect(rep.frame.payload.events[0]).toMatchObject({ before: 'v1', after: 'v2', source: 'console' })
    expect(rep.frame.payload.nextCursor).toBe(nextCursor)
  })

  it('keeps a five-event worst-case escaped history page below the wire cap', () => {
    // NUL has the largest ordinary JSON string expansion (`\\u0000`, six wire
    // bytes per input character), so this covers the schema maxima rather than
    // only representative prose snapshots.
    const escaped = '\u0000'
    const event = {
      id: '33333333-3333-4333-8333-333333333333',
      path: escaped.repeat(255),
      event: 'update' as const,
      before: escaped.repeat(4001),
      after: escaped.repeat(4001),
      at: TS,
      scope: 'agent' as const,
      source: 'dream' as const,
      truncated: true
    }
    const encoded = encode(
      buildEnvelope('memory/history/page', {
        agentId: escaped.repeat(255),
        path: escaped.repeat(255),
        events: Array.from({ length: 5 }, () => event),
        nextCursor: '22222222-2222-4222-8222-222222222222'
      })
    )

    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const decoded = decodeEnvelope(encoded)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('memory/history/page')(decoded.frame)) {
      throw new Error('expected memory/history/page')
    }
    expect(decoded.frame.payload.events).toHaveLength(5)
  })

  it('round-trips the provider-neutral memory surface without backend identity', () => {
    const req = decodeEnvelope(encode(buildEnvelope('memory/surface', { agentId: 'bot-a' })))
    if (!req.ok || !isFrame('memory/surface')(req.frame)) throw new Error('expected memory/surface')
    expect(req.frame.payload.agentId).toBe('bot-a')

    const rep = decodeEnvelope(
      encode(
        buildEnvelope('memory/surface/info', {
          agentId: 'bot-a',
          shape: 'records',
          capabilities: ['recall', 'list', 'get', 'create', 'update', 'delete', 'history']
        })
      )
    )
    if (!rep.ok || !isFrame('memory/surface/info')(rep.frame)) throw new Error('expected memory/surface/info')
    expect(rep.frame.payload).toEqual({
      agentId: 'bot-a',
      shape: 'records',
      capabilities: ['recall', 'list', 'get', 'create', 'update', 'delete', 'history']
    })
  })

  it('round-trips canonical record list/mutations/history with optimistic version', () => {
    const record = {
      id: 'mem-1',
      text: 'Deploy in sea.',
      scope: { kind: 'agent' as const, key: 'ac:agent:bot-a' },
      metadata: { source: 'console' },
      updatedAt: TS,
      provenance: { pluginId: 'example.memory' },
      version: 'etag-1'
    }
    const list = decodeEnvelope(
      encode(buildEnvelope('memory/record/list/page', { agentId: 'bot-a', records: [record], nextCursor: 'next' }))
    )
    if (!list.ok || !isFrame('memory/record/list/page')(list.frame)) throw new Error('expected record list page')
    expect(list.frame.payload.records[0]?.id).toBe('mem-1')

    const update = decodeEnvelope(
      encode(
        buildEnvelope('memory/record/update', {
          agentId: 'bot-a',
          operationId: 'op-1',
          id: 'mem-1',
          text: 'Deploy in sea, then verify.',
          version: 'etag-1'
        })
      )
    )
    if (!update.ok || !isFrame('memory/record/update')(update.frame)) throw new Error('expected record update')
    expect(update.frame.payload.version).toBe('etag-1')

    const history = decodeEnvelope(
      encode(
        buildEnvelope('memory/record/history/page', {
          agentId: 'bot-a',
          events: [{ id: 'event-1', event: 'update', at: TS, record }]
        })
      )
    )
    if (!history.ok || !isFrame('memory/record/history/page')(history.frame)) {
      throw new Error('expected record history page')
    }
    expect(history.frame.payload.events[0]?.record?.version).toBe('etag-1')
  })
})

function f0Id(): string {
  return '99999999-9999-4999-8999-999999999999'
}
