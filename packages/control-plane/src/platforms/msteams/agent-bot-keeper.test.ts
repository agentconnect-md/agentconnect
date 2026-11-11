import { describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../../http/deps.js'
import type { BotRecord } from '../../persistence/ports.js'
import { memoryMsTeamsAgentBotRequestStore } from '../../../test/fakes/msteams-agent-bot-request-store.js'
import { MSTEAMS_AGENT_BOT_NAME_KEY, MsTeamsAgentBotKeeper } from './agent-bot-keeper.js'
import { MsTeamsAgentBotError, msTeamsAgentBotKey, msTeamsAgentBotResourceName } from './agent-bots.js'
import { msTeamsAgentBotEntries } from './deployment-app.js'

const BLUEPRINT = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'
const NOW = Date.UTC(2026, 10, 1)
const KEY_A = 'a'.repeat(32)
const KEY_B = 'b'.repeat(32)

const row = (over: Partial<BotRecord> & { key?: string; blueprintId?: string; name?: string } = {}): BotRecord =>
  ({
    id: 'bot-a',
    orgId: ORG,
    platform: 'msteams',
    externalAppId: 'identity-a',
    externalTenantId: TENANT,
    agentIds: ['agent-a'],
    platformConfig: {
      ...msTeamsAgentBotEntries({
        blueprintId: over.blueprintId ?? BLUEPRINT,
        resourceName: msTeamsAgentBotResourceName(over.key ?? KEY_A)
      }),
      ...(over.name ? { [MSTEAMS_AGENT_BOT_NAME_KEY]: over.name } : {})
    },
    ...over
  }) as unknown as BotRecord

function harness(rows: BotRecord[], agentNames: Record<string, string> = { 'agent-a': 'Helper' }) {
  const requests = memoryMsTeamsAgentBotRequestStore(() => NOW)
  const merged: Record<string, string>[] = []
  const client = {
    rename: vi.fn(async () => {}),
    deleteRegistration: vi.fn(async () => {}),
    deleteIdentity: vi.fn(async () => {}),
    listRegistrations: vi.fn(async () => [] as { key: string; identity: string | null; tenantId: string | null }[]),
    listIdentities: vi.fn(async () => [] as { identity: string; key: string | null }[])
  }
  const http = {
    clock: { now: () => NOW },
    repos: {
      bot: {
        listForPlatform: async () => rows,
        mergeBotIdentity: async (_org: string, id: string, merge: () => { platformConfig: Record<string, string> }) => {
          const next = merge().platformConfig
          merged.push(next)
          const held = rows.find((bot) => bot.id === id)
          if (held) Object.assign(held, { platformConfig: { ...held.platformConfig, ...next } })
          return true
        }
      },
      agent: {
        get: async (_org: string, id: string) =>
          agentNames[id] ? { id, name: 'helper', displayName: agentNames[id] } : null
      },
      msTeamsAgentBotRequest: requests.store
    }
  } as unknown as HttpDeps
  const log = { info: vi.fn(), warn: vi.fn() }
  const keeper = new MsTeamsAgentBotKeeper({ http, client, agentBots: { blueprintId: BLUEPRINT }, log })
  return { keeper, client, merged, requests, log }
}

describe('MsTeamsAgentBotKeeper', () => {
  it('removes a deleted row’s registration and identity, and nothing for a row it did not make', async () => {
    const { keeper, client } = harness([])
    await keeper.remove(row())
    expect(client.deleteRegistration).toHaveBeenCalledWith(KEY_A)
    expect(client.deleteIdentity).toHaveBeenCalledWith(TENANT, 'identity-a')

    client.deleteRegistration.mockClear()
    await keeper.remove(row({ blueprintId: '99999999-9999-4999-8999-999999999999' }))
    await keeper.remove({ ...row(), platformConfig: { appOwner: 'deployment' } } as unknown as BotRecord)
    expect(client.deleteRegistration).not.toHaveBeenCalled()
  })

  it('renames a bot whose agent’s name the row does not record, once', async () => {
    const names = { 'agent-a': 'Helper' }
    const { keeper, client, merged } = harness([row({ name: 'Helper' })], names)
    await keeper.syncNames()
    expect(client.rename).not.toHaveBeenCalled()

    names['agent-a'] = 'Reviewer'
    await keeper.syncNames()
    expect(client.rename).toHaveBeenCalledWith({
      key: KEY_A,
      tenantId: TENANT,
      identity: 'identity-a',
      displayName: 'Reviewer'
    })
    expect(merged).toEqual([{ [MSTEAMS_AGENT_BOT_NAME_KEY]: 'Reviewer' }])
    await keeper.syncNames()
    expect(client.rename).toHaveBeenCalledTimes(1)
  })

  it('leaves a bot Microsoft would not rename until the next sweep', async () => {
    const { keeper, client, merged } = harness([row()])
    client.rename.mockRejectedValueOnce(new Error('refused'))
    await keeper.syncNames()
    await keeper.syncNames()
    expect(client.rename).toHaveBeenCalledTimes(1)
    expect(merged).toEqual([])
    await keeper.sweep()
    await keeper.syncNames()
    expect(client.rename).toHaveBeenCalledTimes(2)
    expect(merged).toEqual([{ [MSTEAMS_AGENT_BOT_NAME_KEY]: 'Helper' }])
  })

  it('deletes what no row or waiting request names, on the second sweep that finds it so', async () => {
    const { keeper, client, requests } = harness([row()])
    const waitingKey = msTeamsAgentBotKey('agent-w', TENANT)
    await requests.store.create({
      id: 'req-1',
      orgId: ORG,
      agentId: 'agent-w',
      tenantId: TENANT
    } as never)
    client.listRegistrations.mockResolvedValue([
      { key: KEY_A, identity: 'identity-a', tenantId: TENANT },
      { key: waitingKey, identity: 'identity-w', tenantId: TENANT },
      { key: KEY_B, identity: 'identity-b', tenantId: 'other-tenant' }
    ])
    client.listIdentities.mockResolvedValue([
      { identity: 'identity-a', key: KEY_A },
      { identity: 'identity-w', key: waitingKey },
      { identity: 'identity-c', key: 'c'.repeat(32) },
      { identity: 'identity-untagged', key: null }
    ])
    await keeper.sweep()
    expect(client.deleteRegistration).not.toHaveBeenCalled()
    expect(client.deleteIdentity).not.toHaveBeenCalled()

    await keeper.sweep()
    expect(client.deleteRegistration.mock.calls).toEqual([[KEY_B]])
    expect(client.deleteIdentity.mock.calls).toEqual([
      ['other-tenant', 'identity-b'],
      [TENANT, 'identity-c']
    ])
    expect(client.listIdentities).toHaveBeenCalledWith(TENANT)
  })

  it('keeps the registration that points at an identity until the identity is gone, so a failed removal is found again', async () => {
    const { keeper, client } = harness([])
    const unreachable = new MsTeamsAgentBotError('identity', undefined, undefined)
    client.deleteIdentity.mockRejectedValueOnce(unreachable)
    await expect(keeper.remove(row())).rejects.toBe(unreachable)
    expect(client.deleteRegistration).not.toHaveBeenCalled()

    // The tenant has no row left: the registration is the only thing that names the identity.
    client.listRegistrations.mockResolvedValue([{ key: KEY_A, identity: 'identity-a', tenantId: TENANT }])
    await keeper.sweep()
    client.deleteIdentity.mockRejectedValueOnce(unreachable)
    await keeper.sweep()
    expect(client.deleteRegistration).not.toHaveBeenCalled()
    await keeper.sweep()
    expect(client.deleteIdentity).toHaveBeenLastCalledWith(TENANT, 'identity-a')
    expect(client.deleteRegistration.mock.calls).toEqual([[KEY_A]])

    // A wrong secret, a disabled principal or a refused permission leaves the identity in place, so the registration stays too.
    for (const refusal of [
      new MsTeamsAgentBotError('token', 401, '7000215'),
      new MsTeamsAgentBotError('token', 400, '7000112'),
      new MsTeamsAgentBotError('identity', 403, 'Authorization_RequestDenied')
    ]) {
      client.deleteRegistration.mockClear()
      client.deleteIdentity.mockRejectedValueOnce(refusal)
      await expect(keeper.remove(row())).rejects.toBe(refusal)
      expect(client.deleteRegistration).not.toHaveBeenCalled()
    }

    // A tenant whose principal is gone has nothing left to delete with, so the registration goes alone.
    client.deleteRegistration.mockClear()
    client.deleteIdentity.mockRejectedValueOnce(new MsTeamsAgentBotError('token', 400, '7000229'))
    await keeper.remove(row())
    expect(client.deleteRegistration.mock.calls).toEqual([[KEY_A]])
  })

  it('spares an orphan that got its row between two sweeps, and goes on when a tenant cannot be listed', async () => {
    const rows: BotRecord[] = []
    const { keeper, client } = harness(rows)
    client.listRegistrations.mockResolvedValue([{ key: KEY_A, identity: 'identity-a', tenantId: TENANT }])
    await keeper.sweep()
    rows.push(row())
    client.listIdentities.mockRejectedValue(new Error('unreachable'))
    await keeper.sweep()
    expect(client.deleteRegistration).not.toHaveBeenCalled()
    expect(client.deleteIdentity).not.toHaveBeenCalled()
  })
})
