import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimGoogleChatCustomer } from './api'
import { decodeGoogleChatClaimState, googleChatClaimErrorKey, isGoogleChatRedirect } from './googlechat-claim'

const REDIRECT = 'https://chat.google.com/api/config_complete_redirect?token=synthetic'

function encode(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(fields)).toString('base64url')
}

const FIELDS = {
  v: 1,
  app: '123456789012',
  space: 'spaces/AAAAexample',
  user: 'users/100000000000000000009',
  kind: 'space',
  tenant: 'customers/C0000000000',
  redirect: REDIRECT,
  iat: 1_790_000_000
}

describe('decodeGoogleChatClaimState', () => {
  it('reads the account, the app, and the conversation for display', () => {
    expect(decodeGoogleChatClaimState(encode(FIELDS))).toEqual({
      app: '123456789012',
      space: 'spaces/AAAAexample',
      user: 'users/100000000000000000009',
      kind: 'space',
      redirect: REDIRECT
    })
    expect(decodeGoogleChatClaimState(`${encode(FIELDS)}==`)?.kind).toBe('space')
  })

  it('refuses a missing, malformed, or unexpected state', () => {
    expect(decodeGoogleChatClaimState(null)).toBeNull()
    expect(decodeGoogleChatClaimState('not a state')).toBeNull()
    expect(decodeGoogleChatClaimState(encode({ ...FIELDS, v: 2 }))).toBeNull()
    expect(decodeGoogleChatClaimState(encode({ ...FIELDS, kind: 'group' }))).toBeNull()
    expect(decodeGoogleChatClaimState(encode({ ...FIELDS, user: 'users/<script>' }))).toBeNull()
    expect(decodeGoogleChatClaimState(encode({ ...FIELDS, redirect: 'https://console.example.test/' }))).toBeNull()
  })

  it('follows only Chat’s own completion URL', () => {
    expect(isGoogleChatRedirect(REDIRECT)).toBe(true)
    expect(isGoogleChatRedirect('https://chat.google.com.example.test/')).toBe(false)
    expect(isGoogleChatRedirect('javascript:alert(1)')).toBe(false)
  })
})

describe('googleChatClaimErrorKey', () => {
  it('maps every refusal code to its sentence, and falls back on the status', () => {
    expect(googleChatClaimErrorKey('GOOGLE_CHAT_CLAIM_IDENTITY', 403)).toBe('identity')
    expect(googleChatClaimErrorKey('GOOGLE_CHAT_CLAIM_EXTERNAL', 403)).toBe('external')
    expect(googleChatClaimErrorKey('GOOGLE_CHAT_CLAIM_TAKEN', 409)).toBe('taken')
    expect(googleChatClaimErrorKey('GOOGLE_CHAT_CLAIM_WORKSPACE_REQUIRED', 403)).toBe('workspaceRequired')
    expect(googleChatClaimErrorKey('GOOGLE_CHAT_UNREACHABLE', 503)).toBe('tryAgain')
    expect(googleChatClaimErrorKey(undefined, 403)).toBe('noPermission')
    expect(googleChatClaimErrorKey(undefined, 400)).toBe('generic')
  })
})

describe('claimGoogleChatCustomer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the state to the chosen organization and returns where Chat continues', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ redirect: REDIRECT }, { status: 201 }))
    vi.stubGlobal('fetch', fetcher)

    await expect(claimGoogleChatCustomer('org-1', 'c3RhdGU')).resolves.toEqual({ redirect: REDIRECT })
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toMatch(/\/orgs\/org-1\/integrations\/googlechat\/claim$/)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ state: 'c3RhdGU' })
  })
})
