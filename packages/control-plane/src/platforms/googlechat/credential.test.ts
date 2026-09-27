/** Google Chat credential validation (google-chat-integration.md §3) against a fake HTTP layer; nothing here reaches Google. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose'
import {
  GOOGLE_CHAT_BOT_SCOPE,
  GOOGLE_CHAT_PROBE_URL,
  GOOGLE_TOKEN_ENDPOINT,
  checkServiceAccountKey,
  isGoogleCloudProjectNumber,
  probeFailureIsConnectivity,
  probeGoogleChatCredential,
  type GoogleServiceAccountKey
} from './credential.js'

const PROJECT_ID = 'example-project'
const CLIENT_EMAIL = `agentconnect-chat@${PROJECT_ID}.iam.gserviceaccount.com`
const RSA = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const NOW = new Date('2026-09-27T00:00:00.000Z')

function keyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: PROJECT_ID,
    private_key_id: 'synthetic-key-id',
    private_key: RSA.privateKey,
    client_email: CLIENT_EMAIL,
    token_uri: GOOGLE_TOKEN_ENDPOINT,
    ...overrides
  })
}

function validKey(): GoogleServiceAccountKey {
  const checked = checkServiceAccountKey(keyJson(), PROJECT_ID)
  if (checked.status !== 'ok') throw new Error(checked.message)
  return checked.key
}

interface Call {
  url: string
  init: RequestInit
}

function fakeGoogle(token: Response | Error, chat: Response | Error = Response.json({ spaces: [] })) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const answer =
      url === GOOGLE_TOKEN_ENDPOINT ? token : url === GOOGLE_CHAT_PROBE_URL ? chat : new Error(`unexpected ${url}`)
    if (answer instanceof Error) throw answer
    return answer
  }) as typeof fetch
  return { fetchImpl, calls }
}

const issued = () => Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3599 })

describe('checkServiceAccountKey', () => {
  it('accepts a service-account key of the declared project', () => {
    const checked = checkServiceAccountKey(keyJson(), PROJECT_ID)
    expect(checked.status).toBe('ok')
    if (checked.status !== 'ok') return
    expect(checked.key).toMatchObject({
      projectId: PROJECT_ID,
      clientEmail: CLIENT_EMAIL,
      privateKeyId: 'synthetic-key-id'
    })
    expect(JSON.parse(checked.key.json)).toEqual(JSON.parse(keyJson()))
  })

  it('refuses every other credential shape', () => {
    for (const type of ['authorized_user', 'external_account', 'impersonated_service_account', undefined]) {
      expect(checkServiceAccountKey(keyJson({ type }), PROJECT_ID)).toMatchObject({ status: 'invalid_key' })
    }
    expect(checkServiceAccountKey('not json', PROJECT_ID)).toMatchObject({ status: 'invalid_key' })
    expect(checkServiceAccountKey('[]', PROJECT_ID)).toMatchObject({ status: 'invalid_key' })
  })

  it('requires project_id, client_email, and a readable RSA private_key', () => {
    for (const missing of ['project_id', 'client_email', 'private_key']) {
      expect(checkServiceAccountKey(keyJson({ [missing]: undefined }), PROJECT_ID)).toMatchObject({
        status: 'invalid_key'
      })
    }
    expect(checkServiceAccountKey(keyJson({ private_key: 'not a key' }), PROJECT_ID)).toMatchObject({
      status: 'invalid_key'
    })
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    expect(checkServiceAccountKey(keyJson({ private_key: ec.privateKey }), PROJECT_ID)).toMatchObject({
      status: 'invalid_key',
      message: expect.stringMatching(/RSA/)
    })
  })

  it('refuses a key from another project without echoing the private key', () => {
    const checked = checkServiceAccountKey(keyJson(), 'other-example-project')
    expect(checked).toMatchObject({ status: 'project_mismatch' })
    if (checked.status === 'ok') return
    expect(checked.message).not.toContain('PRIVATE KEY')
  })
})

describe('isGoogleCloudProjectNumber', () => {
  it('accepts only the numeric project number', () => {
    expect(isGoogleCloudProjectNumber('123456789012')).toBe(true)
    for (const value of ['', '0123', '12ab', 'example-project', ' 123', '1'.repeat(21)]) {
      expect(isGoogleCloudProjectNumber(value), value).toBe(false)
    }
  })
})

describe('probeGoogleChatCredential', () => {
  it('exchanges a chat.bot assertion at the fixed token endpoint and reads one space', async () => {
    const { fetchImpl, calls } = fakeGoogle(issued())
    const result = await probeGoogleChatCredential(validKey(), fetchImpl, () => NOW)

    expect(result.status).toBe('ok')
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ['POST', GOOGLE_TOKEN_ENDPOINT],
      ['GET', GOOGLE_CHAT_PROBE_URL]
    ])
    const form = new URLSearchParams(String(calls[0]!.init.body))
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    const assertion = form.get('assertion')!
    await jwtVerify(assertion, await importSPKI(RSA.publicKey, 'RS256'), { currentDate: NOW })
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: 'RS256', kid: 'synthetic-key-id' })
    expect(decodeJwt(assertion)).toMatchObject({
      iss: CLIENT_EMAIL,
      aud: GOOGLE_TOKEN_ENDPOINT,
      scope: GOOGLE_CHAT_BOT_SCOPE,
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 3_600
    })
    expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe('Bearer synthetic-access-token')
  })

  it("never follows the key's own token_uri", async () => {
    const checked = checkServiceAccountKey(keyJson({ token_uri: 'https://token.example.test/token' }), PROJECT_ID)
    if (checked.status !== 'ok') throw new Error(checked.message)
    const { fetchImpl, calls } = fakeGoogle(issued())

    await probeGoogleChatCredential(checked.key, fetchImpl, () => NOW)
    expect(calls[0]!.url).toBe(GOOGLE_TOKEN_ENDPOINT)
  })

  it('reports a rejected key as an authentication failure with the next step', async () => {
    const { fetchImpl, calls } = fakeGoogle(
      Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 })
    )
    const result = await probeGoogleChatCredential(validKey(), fetchImpl, () => NOW)

    expect(result.status).toBe('key_rejected')
    expect(probeFailureIsConnectivity(result.status)).toBe(false)
    expect(result.message).toMatch(/^Authentication failed/)
    expect(result.message).toContain('invalid_grant: Invalid JWT Signature.')
    expect(result.message).toMatch(/create a new JSON key/)
    expect(calls).toHaveLength(1)
  })

  it('reports an unreachable endpoint as a connectivity failure', async () => {
    const { fetchImpl } = fakeGoogle(new TypeError('fetch failed'))
    const result = await probeGoogleChatCredential(validKey(), fetchImpl, () => NOW)

    expect(result.status).toBe('unreachable')
    expect(probeFailureIsConnectivity(result.status)).toBe(true)
    expect(result.message).toMatch(/^Connection failed/)
  })

  it('treats a provider outage as connectivity, not a bad key', async () => {
    const { fetchImpl } = fakeGoogle(new Response('unavailable', { status: 503 }))
    const result = await probeGoogleChatCredential(validKey(), fetchImpl, () => NOW)

    expect(result.status).toBe('google_unavailable')
    expect(probeFailureIsConnectivity(result.status)).toBe(true)
  })

  it('explains a project without a configured Chat app', async () => {
    const { fetchImpl } = fakeGoogle(
      issued(),
      Response.json({ error: { code: 404, message: 'Google Chat app not found.' } }, { status: 404 })
    )
    const result = await probeGoogleChatCredential(validKey(), fetchImpl, () => NOW)

    expect(result.status).toBe('chat_api_refused')
    expect(result.message).toMatch(/Configure the Chat app/)
  })

  it('explains a project whose Chat API is disabled', async () => {
    const { fetchImpl } = fakeGoogle(
      issued(),
      Response.json({ error: { code: 403, message: 'Google Chat API has not been used.' } }, { status: 403 })
    )
    const result = await probeGoogleChatCredential(validKey(), fetchImpl, () => NOW)

    expect(result.status).toBe('chat_api_refused')
    expect(result.message).toMatch(/Enable the Google Chat API/)
  })
})
