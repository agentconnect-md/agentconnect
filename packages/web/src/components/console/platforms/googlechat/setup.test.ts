import { GOOGLE_CHAT_EVENTS_PATH as PROTOCOL_EVENTS_PATH } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import english from '../../../../../messages/en.json'
import { ApiError } from '@/lib/api'
import {
  GOOGLE_CHAT_ERROR_KEYS,
  GOOGLE_CHAT_EVENTS_PATH,
  googleChatCallbackUrl,
  googleChatErrorMessage,
  googleChatMarketplaceUrl,
  googleChatSetupState,
  parseServiceAccountKey,
  projectNumberOk
} from './setup'

const messages = english.Platforms.googlechat.errors as Record<string, string>
const translate = (key: string) => messages[key.replace(/^errors\./, '')] ?? `missing:${key}`

// Every refusal the Control Plane's provider can send to the wizard (platforms/googlechat/provider.ts).
const CONTROL_PLANE_CODES = [
  'GOOGLE_CHAT_PROJECT_NUMBER_INVALID',
  'GOOGLE_CHAT_KEY_INVALID',
  'GOOGLE_CHAT_PROJECT_MISMATCH',
  'GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH',
  'GOOGLE_CHAT_CRM_DISABLED',
  'GOOGLE_CHAT_CRM_FORBIDDEN',
  'GOOGLE_CHAT_PROJECT_UNRESOLVED',
  'GOOGLE_CHAT_KEY_REJECTED',
  'GOOGLE_CHAT_APP_UNAVAILABLE',
  'GOOGLE_CHAT_UNREACHABLE',
  'GOOGLE_CHAT_DEPLOYMENT_APP'
]

describe('Google Chat error mapping', () => {
  it('maps every Control Plane code to its own English sentence', () => {
    expect(Object.keys(GOOGLE_CHAT_ERROR_KEYS).sort()).toEqual([...CONTROL_PLANE_CODES].sort())
    const sentences = CONTROL_PLANE_CODES.map((code) =>
      googleChatErrorMessage(new ApiError('server words', 400, code), translate)
    )
    for (const sentence of sentences) expect(sentence).not.toMatch(/^missing:|server words/)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('points the two project-read failures at their fixes', () => {
    expect(googleChatErrorMessage(new ApiError('x', 400, 'GOOGLE_CHAT_CRM_DISABLED'), translate)).toContain(
      'Cloud Resource Manager API'
    )
    expect(googleChatErrorMessage(new ApiError('x', 400, 'GOOGLE_CHAT_CRM_FORBIDDEN'), translate)).toContain(
      'Browser role'
    )
  })

  it('keeps the Control Plane’s own words for a refusal without a known code', () => {
    const taken = 'This Google Chat app is already connected to an agent.'
    expect(googleChatErrorMessage(new ApiError(taken, 409), translate)).toBe(taken)
    expect(googleChatErrorMessage(new ApiError('other', 400, 'SOMETHING_ELSE'), translate)).toBe('other')
    expect(googleChatErrorMessage(new Error('offline'), translate)).toBe('offline')
  })
})

describe('setup state', () => {
  const base = {
    saved: true,
    active: true,
    credentialAttention: false,
    relayAvailable: true,
    agentReady: true,
    conversations: 0
  }

  it('never calls a saved app connected, or a connected app added, without its own evidence', () => {
    expect(googleChatSetupState(base)).toEqual({ saved: true, connected: true, added: false })
    expect(googleChatSetupState({ ...base, agentReady: false, conversations: 2 })).toEqual({
      saved: true,
      connected: false,
      added: false
    })
    expect(googleChatSetupState({ ...base, credentialAttention: true })).toMatchObject({ connected: false })
    expect(googleChatSetupState({ ...base, relayAvailable: false })).toMatchObject({ connected: false })
    expect(googleChatSetupState({ ...base, conversations: 1 })).toEqual({ saved: true, connected: true, added: true })
  })
})

describe('setup values', () => {
  it('builds the endpoint from the relay origin and the route the relay serves', () => {
    expect(GOOGLE_CHAT_EVENTS_PATH).toBe(PROTOCOL_EVENTS_PATH)
    expect(googleChatCallbackUrl('https://relay.example.test/')).toBe('https://relay.example.test/googlechat/events')
    expect(googleChatCallbackUrl(null)).toBeNull()
  })

  it('links a Chat app’s Marketplace listing by its project number', () => {
    expect(googleChatMarketplaceUrl('100000000000')).toBe(
      'https://workspace.google.com/marketplace/app/agentconnect/100000000000'
    )
    expect(googleChatMarketplaceUrl('not-a-number')).toBeNull()
  })

  it('accepts an empty or numeric project number', () => {
    expect(projectNumberOk('')).toBe(true)
    expect(projectNumberOk(' 123456789012 ')).toBe(true)
    expect(projectNumberOk('example-project')).toBe(false)
  })

  it('recognizes a service-account key by its fields and reads its project', () => {
    const key = { type: 'service_account', project_id: 'example-project', client_email: 'a@b', private_key: 'k' }
    expect(parseServiceAccountKey(JSON.stringify(key))).toEqual({ projectId: 'example-project' })
    expect(parseServiceAccountKey('{"client_email":"a@b"}')).toBeNull()
    expect(parseServiceAccountKey('[]')).toBeNull()
    expect(parseServiceAccountKey('not json')).toBeNull()
  })
})
