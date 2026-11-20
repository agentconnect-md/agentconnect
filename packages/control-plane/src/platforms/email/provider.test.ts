import { describe, expect, it, vi } from 'vitest'
import { EMAIL_V1_FEATURE, IntegrationEmailConfig } from '@agentconnect.md/protocol'
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
})
