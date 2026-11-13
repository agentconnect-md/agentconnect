import { describe, expect, it } from 'vitest'
import type { WireMsTeamsFileConsent } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { msTeamsActivitiesUrl, msTeamsTokenEndpoint } from '../src/platforms/msteams/api.js'
import {
  MSTEAMS_CONSENT_PENDING_NOTE,
  MSTEAMS_FILE_CONSENT_TYPE,
  MSTEAMS_FILE_INFO_TYPE,
  MSTEAMS_OFFER_LOST_NOTE,
  MsTeamsConnection,
  msTeamsConnKey
} from '../src/platforms/msteams/connection.js'
import { downloadMsTeamsFile, msTeamsFileUrl, uploadMsTeamsFile } from '../src/platforms/msteams/files.js'

const ZERO = '00000000-0000-0000-0000-000000000000'
const SERVICE_URL = `https://smba.trafficmanager.net/amer/${ZERO}/`
const PERSONAL = 'a:example-personal-chat'
const GROUP = '19:example-group@thread.v2'
const FILE_URL = 'https://example-my.sharepoint.com/personal/user/download.aspx?tempauth=t'
const UPLOAD_URL = 'https://example-my.sharepoint.com/personal/user/_api/v2.0/drive/items/x/uploadSession?guid=g'

type Call = { url: string; method: string; body?: unknown; headers?: Record<string, string> }

function connection() {
  const calls: Call[] = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    if (href === msTeamsTokenEndpoint(ZERO)) return Response.json({ access_token: 'tok', expires_in: 3600 })
    const method = init?.method ?? 'GET'
    if (href.startsWith('https://example-my.sharepoint.com')) {
      calls.push({ url: href, method, headers: init?.headers as Record<string, string> })
      return new Response('{}', { status: 201 })
    }
    calls.push({ url: href, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ id: `17000000000${calls.length}` })
  }) as typeof fetch
  const config = { appId: ZERO, tenantId: ZERO, clientSecret: 'client-secret-example' }
  const conn = new MsTeamsConnection({
    group: { key: msTeamsConnKey(config), agentId: 'a', integrationId: 'i', config, integrations: [] },
    fetchImpl,
    sendIntervalMs: 0
  })
  return { conn, calls }
}

function seen(conn: MsTeamsConnection, channel: string, isDm: boolean): void {
  conn.noteMessage({
    platform: 'msteams',
    channel,
    isDm,
    sender: { id: '29:sender', isBot: false },
    adapterExt: { msteams: { serviceUrl: SERVICE_URL, conversationId: channel } }
  } as unknown as NormalizedMessage)
}

const FILE = { bytes: Buffer.from('hello file'), name: 'report.txt', mimeType: 'text/plain' }

function consentOf(uploadId: string, action: 'accept' | 'decline' = 'accept'): WireMsTeamsFileConsent {
  return {
    kind: 'file-consent',
    action,
    uploadId,
    conversationId: PERSONAL,
    serviceUrl: SERVICE_URL,
    userId: '29:sender',
    ...(action === 'accept'
      ? {
          upload: {
            uploadUrl: UPLOAD_URL,
            contentUrl: 'https://example-my.sharepoint.com/personal/user/Documents/Applications/report.txt',
            name: 'report.txt',
            uniqueId: 'unique-1',
            fileType: 'txt'
          }
        }
      : {})
  }
}

function offeredId(call: Call | undefined): string {
  const attachment = (call?.body as { attachments: { content: { acceptContext: { uploadId: string } } }[] })
    .attachments[0]!
  return attachment.content.acceptContext.uploadId
}

describe('Teams 1:1 files', () => {
  it('fetches only https SharePoint links', () => {
    expect(msTeamsFileUrl(FILE_URL)?.hostname).toBe('example-my.sharepoint.com')
    expect(msTeamsFileUrl('http://example-my.sharepoint.com/x')).toBeUndefined()
    expect(msTeamsFileUrl('https://example.test/x')).toBeUndefined()
    expect(msTeamsFileUrl('https://user:pw@example-my.sharepoint.com/x')).toBeUndefined()
  })

  it('downloads a file within the cap and refuses a redirect off SharePoint', async () => {
    const ok = (async () => new Response('bytes')) as unknown as typeof fetch
    expect((await downloadMsTeamsFile(FILE_URL, 100, ok))?.toString()).toBe('bytes')
    const reasons: string[] = []
    expect(await downloadMsTeamsFile(FILE_URL, 2, ok, (r) => reasons.push(r))).toBeNull()
    const away = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.test/x' } })) as unknown as typeof fetch
    expect(await downloadMsTeamsFile(FILE_URL, 100, away, (r) => reasons.push(r))).toBeNull()
    expect(reasons).toEqual(['size_limit', 'invalid_redirect'])
  })

  it('uploads the whole file in one range', async () => {
    let seenInit: RequestInit | undefined
    const put = (async (_url: unknown, init?: RequestInit) => {
      seenInit = init
      return new Response('{}', { status: 201 })
    }) as typeof fetch
    expect(await uploadMsTeamsFile(UPLOAD_URL, Buffer.from('abc'), put)).toEqual({ ok: true })
    expect(seenInit?.method).toBe('PUT')
    expect((seenInit?.headers as Record<string, string>)['content-range']).toBe('bytes 0-2/3')
    expect(await uploadMsTeamsFile('https://example.test/x', Buffer.from('abc'), put)).toEqual({
      ok: false,
      reason: 'invalid_url'
    })
  })

  it('offers a file in a 1:1 chat with a consent card', async () => {
    const { conn, calls } = connection()
    seen(conn, PERSONAL, true)
    const outcome = await conn.uploadFile(PERSONAL, FILE, 'Here is the report')
    expect(outcome).toEqual({ ok: true, messageId: '170000000001', warning: MSTEAMS_CONSENT_PENDING_NOTE })
    expect(calls[0]!.url).toBe(msTeamsActivitiesUrl(SERVICE_URL, PERSONAL))
    expect(calls[0]!.body).toMatchObject({
      attachments: [
        {
          contentType: MSTEAMS_FILE_CONSENT_TYPE,
          name: 'report.txt',
          content: { description: 'Here is the report', sizeInBytes: FILE.bytes.length }
        }
      ]
    })
  })

  it('refuses a group chat and a conversation it has not seen', async () => {
    const { conn, calls } = connection()
    seen(conn, GROUP, false)
    expect(await conn.uploadFile(GROUP, FILE)).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(await conn.uploadFile(PERSONAL, FILE)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(calls).toEqual([])
  })

  it('uploads an accepted file and posts its file card', async () => {
    const { conn, calls } = connection()
    seen(conn, PERSONAL, true)
    await conn.uploadFile(PERSONAL, FILE)
    await conn.settleFileConsent(consentOf(offeredId(calls[0])))
    expect(calls[1]).toMatchObject({ url: UPLOAD_URL, method: 'PUT' })
    expect(calls[2]!.body).toMatchObject({
      attachments: [{ contentType: MSTEAMS_FILE_INFO_TYPE, name: 'report.txt', content: { uniqueId: 'unique-1' } }]
    })
    // The offer is spent: a repeat answer finds nothing to upload.
    await conn.settleFileConsent(consentOf(offeredId(calls[0])))
    expect(calls[3]!.body).toMatchObject({ text: MSTEAMS_OFFER_LOST_NOTE })
  })

  it('drops a declined file and ignores an answer from another chat', async () => {
    const { conn, calls } = connection()
    seen(conn, PERSONAL, true)
    await conn.uploadFile(PERSONAL, FILE)
    const id = offeredId(calls[0])
    await conn.settleFileConsent({ ...consentOf(id), conversationId: 'a:another-chat' })
    await conn.settleFileConsent(consentOf(id, 'decline'))
    expect(calls).toHaveLength(1)
  })
})
