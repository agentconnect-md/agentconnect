import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MATTERMOST_PLATFORM } from '@agentconnect.md/protocol'
import { CpCollabRoutes } from '../src/cp/cp-collab-routes.js'
import { Daemon } from '../src/daemon.js'
import { compoundMentionAddressesFor } from '../src/platforms/mention-address.js'
import { FakeMattermostServer } from './fakes/mattermost-server.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const ORG = 'org_mm_test'
const DAEMON_LOCAL = '11111111-1111-4111-8111-111111111111'
const DAEMON_REMOTE = '22222222-2222-4222-8222-222222222222'
const AGENT_LOCAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGENT_REMOTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT_SHARED_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT_SHARED_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INT_LOCAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const INT_REMOTE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MM_CHANNEL = 'mmchan1234567890abcdefghij'

const tempRoots: string[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scaffoldDaemonRoot(server: FakeMattermostServer): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-mm-mentions-'))
  tempRoots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', AGENT_LOCAL)
  const workspace = join(agentDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT_LOCAL,
      name: 'local-agent',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: workspace },
      output: { mode: 'low' },
      integrations: [
        {
          id: INT_LOCAL,
          platform: MATTERMOST_PLATFORM,
          core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }], mutedChannels: [], gated: false },
          config: {
            serverUrl: server.serverUrl,
            botToken: server.botToken,
            botUserId: server.botUser.id,
            botUsername: server.botUser.username
          }
        }
      ]
    })
  )
  return root
}

const placement = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  daemonId: DAEMON_LOCAL,
  integrationId: INT_LOCAL,
  callPolicy: 'all' as const,
  allowedCallerAgentIds: [] as string[],
  outboundPolicy: 'all' as const,
  allowedTargetAgentIds: [] as string[],
  ...over
})

describe('CpCollabRoutes Mattermost mention directory & address', () => {
  it('renders @botUsername (not <@botUserId>) for Mattermost and preserves Slack behavior', () => {
    const routes = new CpCollabRoutes()
    routes.replace({
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'mattermost',
          channelId: MM_CHANNEL,
          agents: [
            placement(AGENT_LOCAL, {
              botUserId: 'mmuserlocal000000000000001',
              botUsername: 'localbot',
              name: 'local-agent'
            }),
            placement(AGENT_REMOTE, {
              daemonId: DAEMON_REMOTE,
              integrationId: INT_REMOTE,
              botUserId: 'mmuserremote00000000000002',
              botUsername: '@peerbot',
              name: 'remote-slug'
            })
          ]
        },
        {
          orgId: ORG,
          platform: 'slack',
          channelId: 'C1',
          agents: [placement(AGENT_LOCAL, { botUserId: 'U01SLACK', name: 'local-agent' })]
        }
      ],
      agents: [
        { ...placement(AGENT_LOCAL), orgId: ORG },
        { ...placement(AGENT_REMOTE, { daemonId: DAEMON_REMOTE }), orgId: ORG }
      ],
      platformKinds: []
    })

    expect(routes.mentionDirectory(ORG, 'mattermost', MM_CHANNEL)).toEqual([
      {
        agentId: AGENT_LOCAL,
        botUserId: 'mmuserlocal000000000000001',
        botUsername: 'localbot',
        name: 'local-agent'
      },
      {
        agentId: AGENT_REMOTE,
        botUserId: 'mmuserremote00000000000002',
        botUsername: '@peerbot',
        name: 'remote-slug'
      }
    ])
    expect(routes.mentionAddress(ORG, 'mattermost', MM_CHANNEL, AGENT_LOCAL)).toBe('@localbot')
    expect(routes.mentionAddress(ORG, 'mattermost', MM_CHANNEL, AGENT_REMOTE)).toBe('@peerbot')
    expect(routes.mentionAddress(ORG, 'mattermost', MM_CHANNEL, 'missing')).toBeUndefined()
    expect(routes.mentionAddress(ORG, 'slack', 'C1', AGENT_LOCAL)).toBe('<@U01SLACK>')
  })

  it('groups shared Mattermost counts by botUserId ?? botUsername and omits address if slug is missing', () => {
    const routes = new CpCollabRoutes()
    routes.replace({
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'mattermost',
          channelId: MM_CHANNEL,
          agents: [
            placement(AGENT_SHARED_1, { botUsername: 'sharedbot', name: 'reviewer' }),
            placement(AGENT_SHARED_2, { botUsername: 'SharedBot', name: 'planner' }),
            placement(AGENT_REMOTE, { botUsername: 'sharedbot' })
          ]
        }
      ],
      agents: [],
      platformKinds: []
    })

    expect(routes.mentionAddress(ORG, 'mattermost', MM_CHANNEL, AGENT_SHARED_1)).toBe('@sharedbot reviewer')
    expect(routes.mentionAddress(ORG, 'mattermost', MM_CHANNEL, AGENT_SHARED_2)).toBe('@SharedBot planner')
    expect(routes.mentionAddress(ORG, 'mattermost', MM_CHANNEL, AGENT_REMOTE)).toBeUndefined()
  })
})

describe('compoundMentionAddressesFor("mattermost")', () => {
  it('returns only shared-bot compound @handle slug addresses', () => {
    const reader = compoundMentionAddressesFor('mattermost')
    expect(reader).toBeTypeOf('function')
    expect(
      reader!([
        { agentId: AGENT_LOCAL, botUsername: 'localbot', name: 'local-agent' },
        { agentId: AGENT_SHARED_1, botUsername: 'sharedbot', botShared: true, name: 'reviewer' },
        { agentId: AGENT_SHARED_2, botUsername: '@sharedbot', botShared: true, name: 'planner' },
        { agentId: 'no-slug', botUsername: 'sharedbot', botShared: true }
      ])
    ).toEqual(['@sharedbot reviewer', '@sharedbot planner'])
  })
})

describe('Daemon cross-daemon @botUsername mention resolution', () => {
  it('resolves @peerbot into mentionedAgentIds for a peer living on another daemon', async () => {
    const server = new FakeMattermostServer()
    const daemon = new Daemon({
      root: scaffoldDaemonRoot(server),
      mattermostTransport: {
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      },
      hostFactory: () => ({}) as never,
      slackAppFactory: fakeSlackAppFactory()
    })
    daemons.push(daemon)
    await daemon.start()

    ;(daemon as any).cpCollab.replace({
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'mattermost',
          channelId: MM_CHANNEL,
          agents: [
            placement(AGENT_LOCAL, {
              botUserId: server.botUser.id,
              botUsername: server.botUser.username,
              name: 'local-agent'
            }),
            placement(AGENT_REMOTE, {
              daemonId: DAEMON_REMOTE,
              integrationId: INT_REMOTE,
              botAppId: 'mm-0123456789abcdef',
              botUserId: 'mmuserremote00000000000002',
              botUsername: '  @peerbot  ',
              name: 'remote-reviewer'
            })
          ]
        }
      ],
      agents: [
        { ...placement(AGENT_LOCAL), orgId: ORG, name: 'local-agent' },
        {
          ...placement(AGENT_REMOTE, { daemonId: DAEMON_REMOTE }),
          orgId: ORG,
          name: 'remote-reviewer'
        }
      ],
      platformKinds: []
    })

    const directory = (daemon as any).cpCollab.mentionDirectory(ORG, 'mattermost', MM_CHANNEL)
    const pending = (text: string) => ({
      plan: {
        agentId: AGENT_LOCAL,
        integrationId: INT_LOCAL,
        platform: 'mattermost',
        channel: MM_CHANNEL,
        sourceHopCount: 0
      },
      reply: { text, responseId: 'resp-1' },
      conn: {}
    })

    expect(
      (daemon as any).mattermostResponses.resolveRouting(pending('@peerbot please verify this patch'), directory)
    ).toEqual({
      mentionedAgentIds: [AGENT_REMOTE],
      addressedAnyone: true
    })

    const turn = pending('@PeerBot. please inspect')
    ;(daemon as any).mattermostResponses.prepareResponseClosure(turn)
    expect((turn.reply as { finalRouting?: unknown }).finalRouting).toEqual({
      mentionedAgentIds: [AGENT_REMOTE],
      addressedAnyone: true,
      hasPeers: true,
      peerSharesBot: false
    })

    expect(
      (daemon as any).mattermostResponses.resolveRouting(pending('email me at user@peerbot.com'), directory)
        .mentionedAgentIds
    ).toEqual([])

    expect((daemon as any).mattermostResponses.resolveRouting(pending('plain status update'), directory)).toEqual({
      mentionedAgentIds: [],
      addressedAnyone: false
    })

    expect(
      (daemon as any).compoundMentionAddresses(AGENT_LOCAL, { platform: 'mattermost', channel: MM_CHANNEL })
    ).toEqual([])

    const dirWithShared = [
      { agentId: AGENT_LOCAL, botUsername: 'localbot', name: 'local-agent' },
      { agentId: AGENT_REMOTE, botUsername: 'peerbot', botShared: true, name: 'remote-reviewer' }
    ]
    expect(compoundMentionAddressesFor('mattermost')!(dirWithShared)).toEqual(['@peerbot remote-reviewer'])
  })
})
