import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { EMAIL_AUTHSERV_ID_DEFAULT } from '@agentconnect.md/protocol'
import { msTeamsRelayTicketKey } from '../msteams/deployment-app.js'
import { emailRelayDeployment, emailRelayTicketKey, resolveEmailDeployment } from './deployment.js'

const PEPPER = 'p'.repeat(32)
const env = {
  EMAIL_PLATFORM_MAIL_DOMAIN: 'Mail.Example.Test',
  EMAIL_PLATFORM_ACCOUNT_ID: '0123456789ABCDEF0123456789abcdef',
  EMAIL_PLATFORM_API_TOKEN: 'example-api-token',
  EMAIL_PLATFORM_INGRESS_SECRET: 's'.repeat(43)
}

describe('the deployment’s Email configuration (email-integration.md §7)', () => {
  it('is all four keys or none, with the domain and account lower-cased', () => {
    expect(resolveEmailDeployment({})).toBeUndefined()
    expect(resolveEmailDeployment(env)).toEqual({
      mailDomain: 'mail.example.test',
      accountId: '0123456789abcdef0123456789abcdef',
      apiToken: 'example-api-token',
      ingressSecret: 's'.repeat(43)
    })
    for (const missing of Object.keys(env) as (keyof typeof env)[])
      expect(() => resolveEmailDeployment({ ...env, [missing]: undefined }), missing).toThrow(/partial/)
    // The budget alone configures nothing.
    expect(resolveEmailDeployment({ EMAIL_PLATFORM_DAILY_SEND_LIMIT: 500 })).toBeUndefined()
  })

  it('stops the boot on a value the relay would refuse, without repeating it', () => {
    const refused = (change: Partial<typeof env>) => {
      try {
        resolveEmailDeployment({ ...env, ...change })
      } catch (error) {
        return (error as Error).message
      }
      return 'accepted'
    }
    expect(refused({ EMAIL_PLATFORM_MAIL_DOMAIN: 'localhost' })).toMatch(/mailDomain/)
    expect(refused({ EMAIL_PLATFORM_ACCOUNT_ID: 'example-account' })).toMatch(/accountId/)
    expect(refused({ EMAIL_PLATFORM_INGRESS_SECRET: 'too-short-a-secret' })).toMatch(/ingressSecret/)
    expect(refused({ EMAIL_PLATFORM_INGRESS_SECRET: 'too-short-a-secret' })).not.toContain('too-short-a-secret')
  })

  it('reaches the relay with the provider’s authserv-id, the budget, and a ticket key of its own', () => {
    const email = resolveEmailDeployment({ ...env, EMAIL_PLATFORM_DAILY_SEND_LIMIT: 500 })!
    expect(emailRelayDeployment(email, PEPPER)).toEqual({
      mailDomain: 'mail.example.test',
      accountId: '0123456789abcdef0123456789abcdef',
      apiToken: 'example-api-token',
      ingressSecret: 's'.repeat(43),
      authservId: EMAIL_AUTHSERV_ID_DEFAULT,
      dailySendLimit: 500,
      ticketKey: emailRelayTicketKey(PEPPER)
    })
    expect(emailRelayDeployment(resolveEmailDeployment(env), PEPPER)).not.toHaveProperty('dailySendLimit')
    expect(EMAIL_AUTHSERV_ID_DEFAULT).toBe('mx.cloudflare.net')
  })

  it('derives the ticket key from the pepper under its own label', () => {
    expect(emailRelayTicketKey(PEPPER)).toBe(
      createHmac('sha256', PEPPER).update('email-relay-ticket-v1').digest('base64url')
    )
    expect(emailRelayTicketKey(PEPPER)).toHaveLength(43)
    expect(emailRelayTicketKey(PEPPER)).not.toBe(msTeamsRelayTicketKey(PEPPER))
    expect(emailRelayTicketKey(PEPPER)).not.toBe(emailRelayTicketKey('q'.repeat(32)))
  })
})
