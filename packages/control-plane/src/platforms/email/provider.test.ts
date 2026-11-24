import { describe, expect, it, vi } from 'vitest'
import { EMAIL_V1_FEATURE, IntegrationEmailConfig } from '@agentconnect.md/protocol'
import { OrgId } from '../../domain/ids.js'
import type { BotRecord, IntegrationRecord, OrgMemberRecord } from '../../persistence/ports.js'
import {
  EMAIL_REUSE_MESSAGE,
  EMAIL_SECRET_MARKER,
  EmailCreateCredentials,
  createEmailCpProvider,
  emailAddressFor,
  emailSecrets
} from './provider.js'

const DOMAIN = 'mail.example.test'
const BOT_ID = '22222222-2222-4222-8222-222222222222'

/** A ledger that records claims as the table does: an address counts once. */
function ledger(taken: string[] = []) {
  const held = new Set(taken)
  return {
    held,
    claim: vi.fn(async (address: string) => {
      if (held.has(address)) return false
      held.add(address)
      return true
    })
  }
}

const bot = (address: string | null) => ({ id: BOT_ID, orgId: 'org-1', externalAppId: address }) as BotRecord
const core = {} as never
const integration = {} as IntegrationRecord

describe('the Email provider (email-integration.md §3)', () => {
  it('takes one input, the name, over the relay only', () => {
    expect(EmailCreateCredentials.parse({ name: ' helper ' })).toEqual({ name: 'helper' })
    expect(EmailCreateCredentials.safeParse({}).success).toBe(false)
    const provider = createEmailCpProvider()
    const issues: string[] = []
    provider.refineCreateBody!({ credentials: { name: 'helper' }, transport: 'socket' }, (m) => issues.push(m))
    provider.refineCreateBody!({ credentials: { name: 'helper' }, transport: 'http' }, (m) => issues.push(m))
    expect(issues).toHaveLength(1)
    expect(provider.projectBotAssign).toBeDefined()
  })

  it('creates nothing until the deployment has a mail domain', async () => {
    const addresses = ledger()
    for (const provider of [createEmailCpProvider({ addresses }), createEmailCpProvider({ mailDomain: DOMAIN })]) {
      expect(await provider.validateConfig({ name: 'helper' }, 'http')).toMatchObject({
        ok: false,
        status: 409,
        code: 'EMAIL_NOT_CONFIGURED'
      })
    }
    expect(addresses.claim).not.toHaveBeenCalled()
  })

  it('claims the full lower-cased address and names the row by it', async () => {
    const addresses = ledger()
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, addresses })
    const validated = await provider.validateConfig({ name: 'Helper.Bot' }, 'http')
    expect(validated).toEqual({
      ok: true,
      identity: { name: `helper.bot@${DOMAIN}`, externalAppId: `helper.bot@${DOMAIN}` }
    })
    expect([...addresses.held]).toEqual([`helper.bot@${DOMAIN}`])
    if (!validated.ok) throw new Error('unreachable')

    const install = provider.buildNewBotInstall({
      credentials: { name: 'Helper.Bot' },
      identity: validated.identity,
      transport: 'http',
      shareable: true
    })
    expect(install.bot).toEqual({ externalAppId: `helper.bot@${DOMAIN}` })
    expect(install.secrets).toEqual({ botToken: EMAIL_SECRET_MARKER, appToken: null, signingSecret: null })
    expect(install.externalIdentity).toMatchObject({
      externalAppId: `helper.bot@${DOMAIN}`,
      externalTenantId: '-'
    })
    expect(provider.projectBotIdentity!({ externalAppId: `helper.bot@${DOMAIN}` } as never)).toEqual({
      externalAppId: `helper.bot@${DOMAIN}`,
      externalTenantId: '-'
    })
  })

  it('refuses a name that is malformed, reserved, or was ever taken, each with its own code', async () => {
    const addresses = ledger([`taken@${DOMAIN}`])
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, addresses })
    const refusal = async (name: string) => {
      const result = await provider.validateConfig({ name }, 'http')
      return result.ok ? 'ok' : `${result.status} ${result.code}`
    }
    expect(await refusal('ab')).toBe('400 EMAIL_NAME_LENGTH')
    expect(await refusal('a'.repeat(41))).toBe('400 EMAIL_NAME_LENGTH')
    expect(await refusal('bad_name')).toBe('400 EMAIL_NAME_CHARACTERS')
    expect(await refusal('a..b')).toBe('400 EMAIL_NAME_CHARACTERS')
    expect(await refusal('helper+tag')).toBe('400 EMAIL_NAME_CHARACTERS')
    expect(await refusal('postmaster')).toBe('400 EMAIL_NAME_RESERVED')
    expect(await refusal('No-Reply')).toBe('400 EMAIL_NAME_RESERVED')
    expect(await refusal('TAKEN')).toBe('409 EMAIL_ADDRESS_TAKEN')
    // Nothing but the taken name reached the ledger, and that one added nothing.
    expect(addresses.claim).toHaveBeenCalledTimes(1)
    expect([...addresses.held]).toEqual([`taken@${DOMAIN}`])
  })

  it('lets one of two racing creates take a name', async () => {
    const addresses = ledger()
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, addresses })
    const results = await Promise.all([
      provider.validateConfig({ name: 'helper' }, 'http'),
      provider.validateConfig({ name: 'helper' }, 'http')
    ])
    expect(results.map((result) => result.ok).sort()).toEqual([false, true])
  })

  it('stores the settings a create chose, and checks a picked member before claiming the name (§4.1)', async () => {
    const addresses = ledger()
    const activeMember = vi.fn(async (orgId: string, userId: string) =>
      orgId === 'org-1' && userId === 'member-2' ? ({ userId } as OrgMemberRecord) : null
    )
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, addresses, activeMember })
    const ctx = { orgId: 'org-1' }
    const gone = {
      name: 'helper',
      whoMayWrite: 'anyone' as const,
      outsideSessions: { kind: 'member' as const, userId: 'x' }
    }
    expect(await provider.validateConfig(gone, 'http', ctx)).toMatchObject({
      ok: false,
      status: 400,
      code: 'EMAIL_OUTSIDE_MEMBER_UNKNOWN'
    })
    expect(addresses.claim).not.toHaveBeenCalled()

    const credentials = {
      name: 'helper',
      whoMayWrite: 'anyone' as const,
      outsideSessions: { kind: 'member' as const, userId: 'member-2' }
    }
    const validated = await provider.validateConfig(credentials, 'http', ctx)
    if (!validated.ok) throw new Error('refused')
    const install = provider.buildNewBotInstall({
      credentials,
      identity: validated.identity,
      transport: 'http',
      shareable: false
    })
    const entries = { whoMayWrite: 'anyone', outsideSessions: 'user:member-2' }
    expect(install.bot).toEqual({ externalAppId: `helper@${DOMAIN}`, platformConfig: entries })
    expect(
      provider.projectBotIdentity!({
        externalAppId: `helper@${DOMAIN}`,
        platformConfig: { ...entries, other: 'x' }
      } as never)
    ).toEqual({ externalAppId: `helper@${DOMAIN}`, externalTenantId: '-', platformConfig: entries })

    // Anyone alone keeps outside sessions with the agent's editors.
    const open = provider.buildNewBotInstall({
      credentials: { name: 'open', whoMayWrite: 'anyone' },
      identity: { externalAppId: `open@${DOMAIN}` },
      transport: 'http',
      shareable: false
    })
    expect(open.bot?.platformConfig).toEqual({ whoMayWrite: 'anyone', outsideSessions: 'editors' })
  })

  it('reads a name as an address without touching the ledger', () => {
    expect(emailAddressFor(' Helper ', DOMAIN)).toEqual({ ok: true, address: `helper@${DOMAIN}` })
    expect(emailAddressFor('helper', undefined)).toEqual({ ok: false, reason: 'not_configured' })
    expect(emailAddressFor('abuse', DOMAIN)).toEqual({ ok: false, reason: 'reserved' })
  })

  it('never frees a row for another install', () => {
    const provider = createEmailCpProvider({ mailDomain: DOMAIN })
    expect(provider.releasesFreedBot!(bot(`helper@${DOMAIN}`))).toBe(true)
    expect(provider.reuseRefusal!(bot(`helper@${DOMAIN}`))).toBe(EMAIL_REUSE_MESSAGE)
  })

  it('projects a spec that names the relay egress and requires email-v1, with no credential', async () => {
    const provider = createEmailCpProvider({ mailDomain: DOMAIN })
    const config = await provider.projectIntegrationConfig(integration, bot(`helper@${DOMAIN}`), core, emailSecrets())
    expect(IntegrationEmailConfig.parse(config)).toEqual({
      address: `helper@${DOMAIN}`,
      egress: 'relay',
      botId: BOT_ID,
      whoMayWrite: 'members'
    })
    const open = { ...bot(`helper@${DOMAIN}`), platformConfig: { whoMayWrite: 'anyone' } }
    const opened = await provider.projectIntegrationConfig(integration, open, core, emailSecrets())
    expect(IntegrationEmailConfig.parse(opened).whoMayWrite).toBe('anyone')
    expect(JSON.stringify(config)).not.toContain(EMAIL_SECRET_MARKER)
    expect(provider.requiredDaemonFeatures!(config)).toEqual([EMAIL_V1_FEATURE])
    expect(await provider.projectBotAssign!(bot(`helper@${DOMAIN}`), emailSecrets())).toEqual({
      secrets: {},
      ingress: { apiAppId: `helper@${DOMAIN}` }
    })
  })

  it('delivers nothing for an address the deployment no longer serves', async () => {
    const stale = bot('helper@old.example.test')
    for (const provider of [createEmailCpProvider({ mailDomain: DOMAIN }), createEmailCpProvider()]) {
      expect(await provider.projectIntegrationConfig(integration, stale, core, emailSecrets())).toBeUndefined()
      expect(provider.relayAssignable!(stale)).toBe(false)
    }
    expect(createEmailCpProvider({ mailDomain: DOMAIN }).relayAssignable!(bot(`helper@${DOMAIN}`))).toBe(true)
    // A suffix match alone is not the domain.
    expect(createEmailCpProvider({ mailDomain: DOMAIN }).relayAssignable!(bot(`helper@evil-${DOMAIN}`))).toBe(false)
  })

  it('owns a conversation by the member whose verified sign-in email the sender is', async () => {
    const memberByVerifiedEmail = vi.fn(async (orgId: string, email: string) =>
      orgId === 'org-1' && email === 'alice@corp.example.test' ? ({ userId: 'member-1' } as OrgMemberRecord) : null
    )
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, memberByVerifiedEmail })
    const row = bot(`helper@${DOMAIN}`)
    expect(provider.groupOwnedByOpener).toBe(true)
    expect(await provider.dmOwnerMember!(row, ' Alice@Corp.Example.Test ')).toBe('member-1')
    expect(await provider.dmOwnerMember!(row, 'mallory@other.example.test')).toBeNull()
    // Not an address: nothing is asked.
    expect(await provider.dmOwnerMember!(row, 'Alice Example')).toBeNull()
    expect(memberByVerifiedEmail).toHaveBeenCalledTimes(2)
    expect(await createEmailCpProvider().dmOwnerMember!(row, 'alice@corp.example.test')).toBeNull()
  })

  it('names a sender the member whose verified sign-in email they write from, in the organization asked about', async () => {
    const memberByVerifiedEmail = vi.fn(async (orgId: string, email: string) =>
      orgId === 'org-1' && email === 'alice@corp.example.test' ? ({ userId: 'member-1' } as OrgMemberRecord) : null
    )
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, memberByVerifiedEmail })
    expect(await provider.senderMember!(OrgId('org-1'), 'Alice@Corp.Example.Test')).toBe('member-1')
    expect(await provider.senderMember!(OrgId('org-2'), 'alice@corp.example.test')).toBeNull()
    expect(await provider.senderMember!(OrgId('org-1'), 'mallory@other.example.test')).toBeNull()
    // Not an address, a started thread's owner included: nothing is asked.
    expect(await provider.senderMember!(OrgId('org-1'), 'user:member-1')).toBeNull()
    expect(memberByVerifiedEmail).toHaveBeenCalledTimes(3)
    expect(await createEmailCpProvider().senderMember!(OrgId('org-1'), 'alice@corp.example.test')).toBeNull()
  })

  it('owns a started thread by the member its session names, while they are an active member (§5.3)', async () => {
    const activeMember = vi.fn(async (orgId: string, userId: string) =>
      orgId === 'org-1' && userId === 'member-2' ? ({ userId } as OrgMemberRecord) : null
    )
    const memberByVerifiedEmail = vi.fn(async () => null)
    const provider = createEmailCpProvider({ mailDomain: DOMAIN, memberByVerifiedEmail, activeMember })
    const row = bot(`helper@${DOMAIN}`)
    expect(await provider.dmOwnerMember!(row, 'user:member-2')).toBe('member-2')
    // A departed member, an empty id and a provider without the port own nothing, so the row stays private.
    expect(await provider.dmOwnerMember!(row, 'user:member-9')).toBeNull()
    expect(await provider.dmOwnerMember!(row, 'user:')).toBeNull()
    expect(await createEmailCpProvider({ mailDomain: DOMAIN }).dmOwnerMember!(row, 'user:member-2')).toBeNull()
    expect(memberByVerifiedEmail).not.toHaveBeenCalled()
  })
})
