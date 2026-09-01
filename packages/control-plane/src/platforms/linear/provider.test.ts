/**
 * Linear CpPlatformProvider (linear-integration.md §9.2) — unit, no I/O.
 *
 * Four things carry the design's weight here and each has a suite:
 *
 *  - the credential-paste path is REFUSED, so no member Integration can exist outside a connected
 *    workspace (§9.2) — and the create body still composes the vestigial block, because core's
 *    exactly-one-of rule is platform-agnostic;
 *  - the config slice is the DEPLOYMENT's one app: absent ⇒ the platform self-disables, and the D6
 *    identity it projects is `(that one client id, the workspace)` — an app half that is constant
 *    across rows and therefore cannot come from a per-row column (§4.3);
 *  - `projectIntegrationConfig` is the async projector the contract exists for: it resolves the
 *    grant out of the provider's OWN store by the bot's D6 identity, and answers fail-closed when
 *    there is none (§4.4);
 *  - `projectBotAssign` carries STRICTLY the two opaque bags and NO routing (§6.2).
 */
import { describe, it, expect } from 'vitest'
import {
  createLinearCpProvider,
  linearBotAssignBags,
  LinearCpEnvSchema,
  LinearCreateCredentials,
  LINEAR_CONNECT_WORKSPACE_CODE,
  LINEAR_CONNECT_WORKSPACE_MESSAGE
} from './provider.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import { resolveLinearPlatformAppConfig } from '../../config/linear-platform.js'
import type {
  BotRecord,
  BotSecretMaterial,
  CreateBotInput,
  IntegrationRecord,
  LinearConnectionIdentity,
  LinearTokenMaterial,
  LinearTokenRecord,
  LinearTokenStore
} from '../../persistence/ports.js'
import { AgentId, BotId, IntegrationId, OrgId } from '../../domain/ids.js'
import { IntegrationLinearConfig, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const OTHER_ORG = OrgId('22222222-2222-4222-8222-222222222222')
const AGENT_ID = AgentId('77777777-7777-4777-8777-777777777777')
const APP = { clientId: 'lin_client_id', clientSecret: 'lin_client_secret', signingSecret: 'lin_signing_secret' }
const WORKSPACE = 'org_9f2c'

/** An in-memory `linear_token` store keyed exactly as the real one is (§4.4). */
class MemoryTokens implements LinearTokenStore {
  readonly rows = new Map<string, LinearTokenRecord>()
  private static key(i: LinearConnectionIdentity) {
    return `${i.orgId}\u0000${i.clientId}\u0000${i.organizationId}`
  }
  get(identity: LinearConnectionIdentity): Promise<LinearTokenRecord | null> {
    return Promise.resolve(this.rows.get(MemoryTokens.key(identity)) ?? null)
  }
  put(identity: LinearConnectionIdentity, material: LinearTokenMaterial): Promise<void> {
    this.rows.set(MemoryTokens.key(identity), { ...identity, ...material, updatedAt: new Date() })
    return Promise.resolve()
  }
  delete(identity: LinearConnectionIdentity): Promise<void> {
    this.rows.delete(MemoryTokens.key(identity))
    return Promise.resolve()
  }
  /** The sweeper's selection and its guarded claim are exercised against real Postgres, where their
   *  whole point (SQL-side filtering, row-level serialization) actually exists. */
  listOrphans(): Promise<[]> {
    return Promise.resolve([])
  }
  deleteIfUnchanged(): Promise<null> {
    return Promise.resolve(null)
  }
  /** No lock without Postgres — the fence is the whole point, so these paths are pinned in the
   *  integration suite. Here the answer is "owned", the fail-closed side. */
  withIdentityOwnership<T>(_identity: unknown, act: (owned: boolean) => Promise<T>): Promise<T> {
    return act(true)
  }
}

function bot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BotId('88888888-8888-4888-8888-888888888888'),
    orgId: ORG,
    platform: 'linear',
    name: 'Acme Engineering',
    prebuilt: false,
    slackAppId: null,
    teamId: null,
    workspaceId: WORKSPACE,
    workspaceName: 'Acme Engineering',
    botUserId: 'user_app_1',
    revokedAt: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
    grantedScopes: null,
    externalAppId: APP.clientId,
    externalTenantId: WORKSPACE,
    platformConfig: null,
    discordAppId: null,
    feishuAppId: null,
    feishuRegion: null,
    shareable: true,
    transport: 'http',
    preferredAgentId: null,
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [AGENT_ID],
    inUseByAgentId: AGENT_ID,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

/** The deployment app's credentials as the connect flow stamps them (§7.2): client secret in the
 *  `botToken` slot, webhook signing secret in its own. */
function secrets(over: Partial<BotSecretMaterial> = {}): BotSecretMaterial {
  return { botToken: APP.clientSecret, appToken: null, signingSecret: APP.signingSecret, ...over }
}

function integration(over: Partial<IntegrationRecord> = {}): IntegrationRecord {
  return {
    id: IntegrationId('99999999-9999-4999-8999-999999999999'),
    orgId: ORG,
    agentId: AGENT_ID,
    botId: BotId('88888888-8888-4888-8888-888888888888'),
    platform: 'linear',
    name: 'Acme Engineering',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over
  }
}

const CORE: IntegrationCoreEnvelope = { mode: 'shared', bindRules: [], mutedChannels: [], gated: false }

describe('validateConfig — the credential path is refused, not validated', () => {
  it('points at the connect flow with a definitive 400 and a machine code', async () => {
    const provider = createLinearCpProvider({ app: APP })
    const result = await provider.validateConfig({}, 'http')
    expect(result).toEqual({
      ok: false,
      status: 400,
      code: LINEAR_CONNECT_WORKSPACE_CODE,
      message: LINEAR_CONNECT_WORKSPACE_MESSAGE
    })
  })

  it('refuses on every transport and with the app configured or not — nothing makes it pass', async () => {
    for (const provider of [createLinearCpProvider({}), createLinearCpProvider({ app: APP })]) {
      for (const transport of ['socket', 'http'] as const) {
        const result = await provider.validateConfig({}, transport)
        expect(result.ok).toBe(false)
      }
    }
  })

  it('leaves the create tail unreachable: the pasted block carries no workspace to install', () => {
    // `validateConfig` refuses first, so this can only ever be reached with an identity the OAuth
    // callback derived — and the empty credential block derives none.
    const provider = createLinearCpProvider({ app: APP })
    expect(() =>
      provider.buildNewBotInstall({ credentials: {}, identity: {}, transport: 'http', shareable: true })
    ).toThrow(/organization id/)
  })

  it('still contributes the vestigial block, so core’s exactly-one-of rule keeps its shape', () => {
    // The block exists only because every provider contributes one: a create body naming `linear`
    // must still satisfy exactly-one-of botId/credentials before `validateConfig` refuses it.
    const body = buildCreateIntegrationBody(buildCpPlatformRegistry([createLinearCpProvider({ app: APP })]))
    expect(LinearCreateCredentials.safeParse({}).success).toBe(true)
    expect(body.safeParse({ platform: 'linear', agentId: AGENT_ID, linear: {} }).success).toBe(true)
    expect(body.safeParse({ platform: 'linear', agentId: AGENT_ID }).success).toBe(false)
  })
})

describe('the deployment config slice', () => {
  it('declares the three deployment keys and nothing else', () => {
    expect(Object.keys(LinearCpEnvSchema).sort()).toEqual([
      'LINEAR_PLATFORM_CLIENT_ID',
      'LINEAR_PLATFORM_CLIENT_SECRET',
      'LINEAR_PLATFORM_SIGNING_SECRET'
    ])
  })

  it('resolves all-three, refuses a partial set by name, and reads none as disabled', () => {
    expect(
      resolveLinearPlatformAppConfig({
        LINEAR_PLATFORM_CLIENT_ID: APP.clientId,
        LINEAR_PLATFORM_CLIENT_SECRET: APP.clientSecret,
        LINEAR_PLATFORM_SIGNING_SECRET: APP.signingSecret
      })
    ).toEqual(APP)
    expect(resolveLinearPlatformAppConfig({})).toBeUndefined()
    expect(() => resolveLinearPlatformAppConfig({ LINEAR_PLATFORM_CLIENT_ID: APP.clientId })).toThrow(
      /missing LINEAR_PLATFORM_CLIENT_SECRET, LINEAR_PLATFORM_SIGNING_SECRET/
    )
  })

  it('self-disables the D6 projection when the app is absent', () => {
    const input: CreateBotInput = {
      id: BotId('88888888-8888-4888-8888-888888888888'),
      orgId: ORG,
      platform: 'linear',
      name: 'Acme Engineering',
      workspaceId: WORKSPACE
    }
    expect(createLinearCpProvider({}).projectBotIdentity?.(input)).toEqual({})
  })

  it('reads the app THROUGH the deps bag, so a late-bound composition is observed', () => {
    // The container resolves the slice once, but the test harness swaps it after the app is built.
    const deps: { app?: typeof APP } = {}
    const provider = createLinearCpProvider(deps)
    const input: CreateBotInput = {
      id: BotId('88888888-8888-4888-8888-888888888888'),
      orgId: ORG,
      platform: 'linear',
      name: 'Acme Engineering',
      workspaceId: WORKSPACE
    }
    expect(provider.projectBotIdentity?.(input)).toEqual({})
    deps.app = APP
    expect(provider.projectBotIdentity?.(input)?.externalAppId).toBe(APP.clientId)
  })
})

describe('projectBotIdentity — a constant app half, the workspace as the tenant', () => {
  const project = (over: Partial<CreateBotInput> = {}) =>
    createLinearCpProvider({ app: APP }).projectBotIdentity?.({
      id: BotId('88888888-8888-4888-8888-888888888888'),
      orgId: ORG,
      platform: 'linear',
      name: 'Acme Engineering',
      workspaceId: WORKSPACE,
      workspaceName: 'Acme Engineering',
      ...over
    })

  it('projects the deployment client id + the Linear organization id, with display metadata', () => {
    expect(project()).toEqual({
      externalAppId: APP.clientId,
      externalTenantId: WORKSPACE,
      platformConfig: {
        clientId: APP.clientId,
        organizationId: WORKSPACE,
        workspaceName: 'Acme Engineering'
      }
    })
  })

  it('never writes the tenantless sentinel — Linear always has a workspace, or no identity at all', () => {
    // A row without the workspace captured has nothing to fence on: `'-'` here would claim the ONE
    // app id for the first such row and lock every other workspace out of the composite unique.
    expect(project({ workspaceId: undefined })).toEqual({})
  })

  it('omits the display name when the callback did not capture one', () => {
    expect(project({ workspaceName: undefined })?.platformConfig).toEqual({
      clientId: APP.clientId,
      organizationId: WORKSPACE
    })
  })
})

describe('secretShape — the deployment credentials in the shared row (§7.2)', () => {
  it('labels the two slots it uses and gates an http assign on the signing secret', () => {
    const provider = createLinearCpProvider({ app: APP })
    expect(Object.keys(provider.secretShape.slots).sort()).toEqual(['botToken', 'signingSecret'])
    expect(provider.secretShape.slots.botToken).toMatch(/client secret/i)
    expect(provider.secretShape.slots.signingSecret).toMatch(/signing secret/i)
    expect(provider.secretShape.httpAssignRequires).toEqual(['signingSecret'])
  })
})

describe('backgroundLoops — the deployment-credential re-stamp (§10.6)', () => {
  it('declares the loop so core drives it without naming the platform', () => {
    const started: string[] = []
    const provider = createLinearCpProvider({
      app: APP,
      credentialReconciler: { start: () => started.push('start'), stop: () => started.push('stop') }
    })

    expect(provider.backgroundLoops?.map((loop) => loop.label)).toEqual(['linear-credential-restamp'])
    provider.backgroundLoops?.[0]?.start()
    provider.backgroundLoops?.[0]?.stop()
    expect(started).toEqual(['start', 'stop'])
  })

  it('declares no loop without the reconciler — member presence follows slot presence', () => {
    expect(createLinearCpProvider({ app: APP }).backgroundLoops).toBeUndefined()
  })
})

describe('projectBotAssign — strictly the two opaque bags, no routing (§6.2)', () => {
  it('carries the signing secret and the tenant-scoped demux composite in the generic slots', async () => {
    // The slot NAMES are the contract: relay core indexes `{appId: apiAppId, tenantId: teamId}` and
    // its tenant fence reads `teamId`, so a platform-named key would be dropped and every delivery
    // would fall back to the verify-scan.
    const provider = createLinearCpProvider({ app: APP })
    const bags = await provider.projectBotAssign!(bot(), secrets())
    expect(bags).toEqual({
      secrets: { signingSecret: APP.signingSecret },
      ingress: { apiAppId: APP.clientId, teamId: WORKSPACE, botUserId: 'user_app_1' }
    })
  })

  it('never leaks the client secret or a refresh token to the relay', () => {
    const bags = linearBotAssignBags(bot(), secrets())
    expect(JSON.stringify(bags)).not.toContain(APP.clientSecret)
    expect(Object.keys(bags.secrets)).toEqual(['signingSecret'])
  })

  it('carries no routing — members, rules and the default stay core-assembled', () => {
    const bags = linearBotAssignBags(bot(), secrets())
    for (const routingKey of ['routes', 'members', 'agents', 'defaultAgentId', 'bindRules']) {
      expect(bags.ingress).not.toHaveProperty(routingKey)
      expect(bags.secrets).not.toHaveProperty(routingKey)
    }
  })

  it('omits an unresolved demux half rather than shipping an empty string the relay would index', () => {
    expect(linearBotAssignBags(bot({ externalTenantId: null, botUserId: null }), secrets()).ingress).toEqual({
      apiAppId: APP.clientId
    })
  })
})

describe('projectIntegrationConfig — the async projector the contract exists for (§4.4)', () => {
  const withToken = async (over: Partial<BotRecord> = {}, tokenOrg = ORG) => {
    const tokens = new MemoryTokens()
    await tokens.put(
      { orgId: tokenOrg, clientId: APP.clientId, organizationId: WORKSPACE },
      {
        accessToken: 'lin_oauth_access',
        refreshToken: 'lin_oauth_refresh',
        expiresAt: new Date('2026-01-02T00:00:00.000Z')
      }
    )
    const provider = createLinearCpProvider({ app: APP, tokens })
    return { tokens, config: await provider.projectIntegrationConfig(integration(), bot(over), CORE, secrets()) }
  }

  it('emits the ≤24 h token snapshot plus the workspace metadata the daemon renders', async () => {
    const { config } = await withToken()
    expect(config).toEqual({
      workspaceId: WORKSPACE,
      workspaceName: 'Acme Engineering',
      appUserId: 'user_app_1',
      accessToken: 'lin_oauth_access',
      accessTokenExpiresAt: '2026-01-02T00:00:00.000Z'
    })
    // …and it is what the daemon's schema will read back.
    expect(IntegrationLinearConfig.safeParse(config).success).toBe(true)
  })

  it('never lets the refresh token or the client secret into the spec', async () => {
    const { config } = await withToken()
    expect(JSON.stringify(config)).not.toContain('lin_oauth_refresh')
    expect(JSON.stringify(config)).not.toContain(APP.clientSecret)
  })

  it('resolves by the bot’s D6 identity — a row for another organization is not this bot’s grant', async () => {
    const { config } = await withToken({}, OTHER_ORG)
    expect(config).toBeUndefined()
  })

  it('answers fail-closed when the grant is gone (a dead token awaiting reconnect)', async () => {
    const provider = createLinearCpProvider({ app: APP, tokens: new MemoryTokens() })
    expect(await provider.projectIntegrationConfig(integration(), bot(), CORE, secrets())).toBeUndefined()
  })

  it('answers fail-closed for a row with no complete D6 identity', async () => {
    const tokens = new MemoryTokens()
    await tokens.put(
      { orgId: ORG, clientId: APP.clientId, organizationId: WORKSPACE },
      { accessToken: 'lin_oauth_access', refreshToken: null, expiresAt: new Date('2026-01-02T00:00:00.000Z') }
    )
    const provider = createLinearCpProvider({ app: APP, tokens })
    const config = await provider.projectIntegrationConfig(
      integration(),
      bot({ externalTenantId: null }),
      CORE,
      secrets()
    )
    expect(config).toBeUndefined()
  })

  it('omits the optional display fields a callback did not capture', async () => {
    const { config } = await withToken({ workspaceName: null, botUserId: null })
    expect(config).toEqual({
      workspaceId: WORKSPACE,
      accessToken: 'lin_oauth_access',
      accessTokenExpiresAt: '2026-01-02T00:00:00.000Z'
    })
  })
})

describe('onBotDelete — the disconnect edge the contract grew for this platform (§7.4)', () => {
  it('drops the identity’s grant, which hangs off no bot row and nothing else would collect', async () => {
    const tokens = new MemoryTokens()
    const identity = { orgId: ORG, clientId: APP.clientId, organizationId: WORKSPACE }
    await tokens.put(identity, { accessToken: 'a', refreshToken: 'r', expiresAt: new Date() })
    const provider = createLinearCpProvider({ app: APP, tokens })
    await provider.sideEffects!.onBotDelete!(bot(), secrets())
    expect(await tokens.get(identity)).toBeNull()
  })

  it('leaves another organization’s row for the same workspace alone', async () => {
    const tokens = new MemoryTokens()
    const foreign = { orgId: OTHER_ORG, clientId: APP.clientId, organizationId: WORKSPACE }
    await tokens.put(foreign, { accessToken: 'a', refreshToken: 'r', expiresAt: new Date() })
    const provider = createLinearCpProvider({ app: APP, tokens })
    await provider.sideEffects!.onBotDelete!(bot(), secrets())
    expect(await tokens.get(foreign)).not.toBeNull()
  })

  it('is a no-op for a row with no complete identity, and tolerates an absent secret row', async () => {
    const tokens = new MemoryTokens()
    const provider = createLinearCpProvider({ app: APP, tokens })
    await expect(provider.sideEffects!.onBotDelete!(bot({ externalAppId: null }), null)).resolves.toBeUndefined()
  })

  it('is absent — hence not consulted — when the provider has no store to clean', () => {
    expect(createLinearCpProvider({ app: APP }).sideEffects?.onBotDelete).toBeUndefined()
  })
})

describe('buildNewBotInstall — the rows one connected workspace writes (§7.1 step 2)', () => {
  const built = () =>
    createLinearCpProvider({ app: APP }).buildNewBotInstall({
      credentials: {},
      identity: { workspaceId: WORKSPACE, workspaceName: 'Acme Engineering', botUserId: 'user_app_1' },
      transport: 'http',
      // The caller's request is IGNORED: sharing is structural for this platform.
      shareable: false
    })

  it('claims the D6 identity and the workspace off the deployment client id', () => {
    const install = built()
    expect(install.externalIdentity).toMatchObject({ externalAppId: APP.clientId, externalTenantId: WORKSPACE })
    expect(install.workspaceClaim).toMatchObject({ appId: APP.clientId, tenantId: WORKSPACE })
  })

  it('is shareable by construction, so the second member Integration is admitted', () => {
    expect(built().bot?.shareable).toBe(true)
  })

  it('stamps the deployment app credentials into the workspace bot’s secret row', () => {
    expect(built().secrets).toEqual({
      botToken: APP.clientSecret,
      appToken: null,
      signingSecret: APP.signingSecret
    })
  })

  it('carries the display metadata and the app user id the callback captured', () => {
    expect(built().bot).toMatchObject({
      workspaceId: WORKSPACE,
      workspaceName: 'Acme Engineering',
      botUserId: 'user_app_1'
    })
  })

  it('refuses an identity with no workspace — there would be nothing to key, demux or fence', () => {
    expect(() =>
      createLinearCpProvider({ app: APP }).buildNewBotInstall({
        credentials: {},
        identity: {},
        transport: 'http',
        shareable: true
      })
    ).toThrow(/organization id/)
  })
})

describe('the rest of the §9 surface', () => {
  it('contributes exactly the funnel plugins it was composed with, per scope', () => {
    const org = async () => {}
    const publicCallback = async () => {}
    const provider = createLinearCpProvider({
      app: APP,
      funnelRoutes: { org: [org], publicCallback: [publicCallback] }
    })
    expect(provider.installRoutes('org')).toEqual([org])
    expect(provider.installRoutes('public-callback')).toEqual([publicCallback])
  })

  // Composed with NEITHER loop slot there is no `backgroundLoops` member at all; each loop's own
  // presence-follows-slot-presence pair is covered beside the loop that owns it.
  it('contributes no routes, funnel state or loops when composed without them', () => {
    const provider = createLinearCpProvider({ app: APP, tokens: new MemoryTokens() })
    expect(provider.installRoutes('org')).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])
    expect(provider.refineCreateBody).toBeUndefined()
    expect(provider.providerToolingCredentials).toBeUndefined()
    expect(provider.pendingInstalls).toBeUndefined()
  })

  it('declares one funnel reaper and one background loop when it owns them', () => {
    const sweeper = { label: 'linear-orphan-token', start: () => {}, stop: () => {} }
    const provider = createLinearCpProvider({
      app: APP,
      tokens: new MemoryTokens(),
      pendingInstalls: { installStates: { reapExpired: () => Promise.resolve(0) }, intervalMs: 1000 },
      orphanTokenSweeper: sweeper
    })
    expect(provider.pendingInstalls?.map((d) => d.label)).toEqual(['linear-install-state'])
    expect(provider.backgroundLoops).toEqual([sweeper])
  })
})
