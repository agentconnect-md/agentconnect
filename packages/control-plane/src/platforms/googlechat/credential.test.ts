/** Google Chat credential validation (google-chat-integration.md §3) against a fake HTTP layer; nothing here reaches Google. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from 'jose'
import {
  GOOGLE_CHAT_BOT_SCOPE,
  GOOGLE_CHAT_PROBE_URL,
  GOOGLE_CLOUD_READ_ONLY_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  checkGoogleChatApp,
  checkServiceAccountKey,
  googleCloudProjectUrl,
  isGoogleCloudProjectNumber,
  probeFailureIsConnectivity,
  probeGoogleChatCredential,
  resolveProjectNumber,
  serviceAccountProject,
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

  it('takes the owning project from the authenticated email, never from the editable project_id', () => {
    // A key of example-project's account, edited to claim a project it only has Browser access on.
    const edited = keyJson({ project_id: 'other-example-project' })
    expect(checkServiceAccountKey(edited, 'other-example-project')).toEqual({
      status: 'invalid_key',
      message: `the key's project_id other-example-project does not match its service account's project ${PROJECT_ID}`
    })
  })

  it('accepts only a user-managed service account created in a project', () => {
    for (const clientEmail of [
      '123456789012-compute@developer.gserviceaccount.com',
      `${PROJECT_ID}@appspot.gserviceaccount.com`,
      `agentconnect-chat@${PROJECT_ID}.iam.gserviceaccount.com.example.test`,
      `Agentconnect-Chat@${PROJECT_ID}.iam.gserviceaccount.com`,
      `agent.chat-app@${PROJECT_ID}.iam.gserviceaccount.com`,
      `agentconnect-chat@${PROJECT_ID}.example.test`
    ]) {
      expect(checkServiceAccountKey(keyJson({ client_email: clientEmail }), PROJECT_ID), clientEmail).toEqual({
        status: 'invalid_key',
        message: `the Chat app needs a service account created in its own project (name@project-id.iam.gserviceaccount.com); ${clientEmail} is not one`
      })
    }
    expect(serviceAccountProject(CLIENT_EMAIL)).toBe(PROJECT_ID)
  })

  it('refuses a key from another project without echoing the private key', () => {
    const checked = checkServiceAccountKey(keyJson(), 'other-example-project')
    expect(checked).toEqual({
      status: 'project_mismatch',
      message: `the key belongs to project ${PROJECT_ID}, not other-example-project; keep the Chat app and its service account in one project`
    })
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

const PROJECT_NUMBER = '123456789012'
const CRM_URL = googleCloudProjectUrl(PROJECT_ID)

type CrmAnswer = 'ok' | 'other_project' | 'service_disabled' | 'permission_denied' | 'offline'

/** Google's token endpoint, Cloud Resource Manager, and the Chat API, answering fresh responses per call. */
function fakeCloud(crm: CrmAnswer = 'ok') {
  const calls: { method: string; url: string; scope?: string; bearer?: string | null }[] = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const assertion = new URLSearchParams(String(init.body)).get('assertion')!
      const scope = String(decodeJwt(assertion).scope)
      calls.push({ method, url, scope })
      return Response.json({ access_token: `token-for ${scope}` })
    }
    calls.push({ method, url, bearer: new Headers(init.headers).get('authorization') })
    if (url === CRM_URL) {
      if (crm === 'offline') throw new TypeError('fetch failed')
      if (crm === 'service_disabled') {
        return Response.json(
          {
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: 'Cloud Resource Manager API has not been used in this project before or it is disabled.',
              details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }]
            }
          },
          { status: 403 }
        )
      }
      if (crm === 'permission_denied') {
        return Response.json(
          { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } },
          { status: 403 }
        )
      }
      const projectId = crm === 'other_project' ? 'other-example-project' : PROJECT_ID
      return Response.json({ projectNumber: PROJECT_NUMBER, projectId, lifecycleState: 'ACTIVE' })
    }
    if (url === GOOGLE_CHAT_PROBE_URL) return Response.json({ spaces: [] })
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('resolveProjectNumber', () => {
  it('reads the key’s own project with a read-only token, not the chat.bot one', async () => {
    const cloud = fakeCloud()
    const resolved = await resolveProjectNumber(validKey(), cloud.fetchImpl, () => NOW)

    expect(resolved).toEqual({ status: 'ok', projectNumber: PROJECT_NUMBER })
    expect(cloud.calls).toEqual([
      { method: 'POST', url: GOOGLE_TOKEN_ENDPOINT, scope: GOOGLE_CLOUD_READ_ONLY_SCOPE },
      { method: 'GET', url: CRM_URL, bearer: `Bearer token-for ${GOOGLE_CLOUD_READ_ONLY_SCOPE}` }
    ])
    expect(CRM_URL).toBe(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_ID}`)
  })

  it('asks for the Cloud Resource Manager API when it is disabled in the project', async () => {
    const resolved = await resolveProjectNumber(validKey(), fakeCloud('service_disabled').fetchImpl, () => NOW)
    expect(resolved).toEqual({
      status: 'crm_disabled',
      message: `Enable the Cloud Resource Manager API in project ${PROJECT_ID}: AgentConnect reads the project's number through it to bind the Chat app to this key.`
    })
  })

  it('asks for the Browser role when the service account may not read the project', async () => {
    const resolved = await resolveProjectNumber(validKey(), fakeCloud('permission_denied').fetchImpl, () => NOW)
    expect(resolved).toEqual({
      status: 'crm_forbidden',
      message: `Grant ${CLIENT_EMAIL} the Browser role on project ${PROJECT_ID} (resourcemanager.projects.get): AgentConnect reads the project's number with it to bind the Chat app to this key.`
    })
  })

  it('refuses an answer about another project, and reports an unreachable API as connectivity', async () => {
    const other = await resolveProjectNumber(validKey(), fakeCloud('other_project').fetchImpl, () => NOW)
    expect(other.status).toBe('project_unresolved')
    const offline = await resolveProjectNumber(validKey(), fakeCloud('offline').fetchImpl, () => NOW)
    expect(offline.status).toBe('unreachable')
    expect(probeFailureIsConnectivity(offline.status as 'unreachable')).toBe(true)
  })
})

describe('checkGoogleChatApp', () => {
  const input = { projectId: PROJECT_ID, serviceAccountKey: keyJson() }

  it('resolves the number before the chat.bot read and returns it as the identity', async () => {
    const cloud = fakeCloud()
    const checked = await checkGoogleChatApp(input, cloud.fetchImpl, () => NOW)

    expect(checked).toMatchObject({ status: 'ok', projectNumber: PROJECT_NUMBER })
    expect(cloud.calls.map((call) => call.scope ?? call.url)).toEqual([
      GOOGLE_CLOUD_READ_ONLY_SCOPE,
      CRM_URL,
      GOOGLE_CHAT_BOT_SCOPE,
      GOOGLE_CHAT_PROBE_URL
    ])
  })

  it('accepts an entered number only when it is the resolved one', async () => {
    const same = await checkGoogleChatApp({ ...input, projectNumber: PROJECT_NUMBER }, fakeCloud().fetchImpl, () => NOW)
    expect(same).toMatchObject({ status: 'ok', projectNumber: PROJECT_NUMBER })

    const cloud = fakeCloud()
    const other = await checkGoogleChatApp({ ...input, projectNumber: '210987654321' }, cloud.fetchImpl, () => NOW)
    expect(other).toEqual({
      status: 'project_number_mismatch',
      message: `the project number 210987654321 does not match project ${PROJECT_ID}, whose number is ${PROJECT_NUMBER}`
    })
    // A refused binding never reaches the Chat API.
    expect(cloud.calls.map((call) => call.url)).not.toContain(GOOGLE_CHAT_PROBE_URL)
  })

  it('reads the number of the project named by the service-account email', async () => {
    const second = 'second-example-project'
    const urls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      urls.push(url)
      if (url === GOOGLE_TOKEN_ENDPOINT) return Response.json({ access_token: 'synthetic-access-token' })
      if (url.startsWith('https://cloudresourcemanager.googleapis.com/')) {
        return Response.json({ projectNumber: '345678901234', projectId: second })
      }
      return Response.json({ spaces: [] })
    }) as typeof fetch
    const checked = await checkGoogleChatApp(
      {
        projectId: second,
        serviceAccountKey: keyJson({
          project_id: second,
          client_email: `agentconnect-chat@${second}.iam.gserviceaccount.com`
        })
      },
      fetchImpl,
      () => NOW
    )
    expect(checked).toMatchObject({ status: 'ok', projectNumber: '345678901234', key: { projectId: second } })
    expect(urls).toContain(`https://cloudresourcemanager.googleapis.com/v1/projects/${second}`)
  })

  it('refuses an edited project_id before any Google call', async () => {
    const cloud = fakeCloud()
    const checked = await checkGoogleChatApp(
      { projectId: 'other-example-project', serviceAccountKey: keyJson({ project_id: 'other-example-project' }) },
      cloud.fetchImpl,
      () => NOW
    )
    expect(checked.status).toBe('invalid_key')
    expect(cloud.calls).toEqual([])
  })

  it('stops at a refused resolution', async () => {
    const cloud = fakeCloud('permission_denied')
    const checked = await checkGoogleChatApp(input, cloud.fetchImpl, () => NOW)
    expect(checked.status).toBe('crm_forbidden')
    expect(cloud.calls.map((call) => call.url)).not.toContain(GOOGLE_CHAT_PROBE_URL)
  })
})
