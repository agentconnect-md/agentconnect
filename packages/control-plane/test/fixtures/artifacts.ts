// Shared artifact test harness: a real signer over an in-memory bucket, members, sessions and a full publish.
import { createHash, randomUUID } from 'node:crypto'
import type { ArtifactInitiator, ArtifactManifest, ArtifactPublishBeginOk } from '@agentconnect.md/protocol'
import type { SourceCacheObjectHead } from '@agentconnect.md/object-store'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from './seed.js'
import { createArtifactService } from '../../src/artifacts/service.js'
import { ArtifactShareCodec, ArtifactShareService } from '../../src/artifacts/shares.js'
import { systemClock } from '../../src/domain/clock.js'
import { FileTransferConfigSchema } from '../../src/file-transfer/config.js'
import { createFileTransfer } from '../../src/file-transfer/transfer.js'
import {
  PgAgentRepo,
  PgArtifactRepo,
  PgArtifactShareRepo,
  PgOrgRepo,
  PgSessionRepo,
  PgUserRepo
} from '../../src/persistence/index.js'
import type { AgentRecord, ArtifactRepo, CronRecord, OrgMemberRole } from '../../src/persistence/ports.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { TEST_API_KEY_PEPPER } from '../fakes/build-http.js'

export const T0 = Date.parse('2026-11-25T10:00:00.000Z')

export const hex = (text: string) => createHash('sha256').update(text).digest('hex')
export const manifestOf = (...files: Array<[string, string, string?]>): ArtifactManifest => ({
  entry: files[0]![0],
  files: files.map(([path, body, mediaType]) => ({
    path,
    sha256: hex(body),
    bytes: Buffer.byteLength(body),
    mediaType: mediaType ?? 'text/html'
  }))
})

// A real signer over an in-memory bucket: the test "uploads" a signed PUT by recording its signed length and checksum.
export function harness(crons: CronRecord[] = [], artifacts: ArtifactRepo = new PgArtifactRepo(prisma)) {
  const objects = new Map<string, SourceCacheObjectHead>()
  // The service's clock, every DELETE in order, and a switch that makes the bucket refuse them.
  const clock = { now: T0 }
  const deletes: string[] = []
  const bucket = { failDeletes: false }
  const transfer = createFileTransfer({
    config: FileTransferConfigSchema.parse({
      version: 1,
      endpoint: 'https://store.internal.example.test',
      publicEndpoint: 'https://store.example.test',
      region: 'us-east-1',
      bucket: 'ac-cache',
      forcePathStyle: true,
      credentials: { source: 'static', dir: '/creds', accessKeyIdKey: 'id', secretAccessKeyKey: 'secret' }
    }),
    credentials: { source: 'static', get: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }) },
    objects: {
      head: async (key) => objects.get(key) ?? { exists: false },
      delete: async (key) => {
        if (bucket.failDeletes) throw new Error('bucket unavailable')
        deletes.push(key)
        objects.delete(key)
      },
      createMultipartUpload: async () => 'mp'
    },
    enabled: () => true,
    now: () => T0
  })
  const service = createArtifactService({
    transfer,
    artifacts,
    sessions: new PgSessionRepo(prisma),
    users: new PgUserRepo(prisma),
    agents: new PgAgentRepo(prisma),
    crons: { listForAgent: async () => crons },
    hooks: { get: async () => null },
    orgs: new PgOrgRepo(prisma),
    // The same pepper as `buildHttpApp`, so a link the agent creates opens through the share read routes.
    shares: new ArtifactShareService({
      shares: new PgArtifactShareRepo(prisma),
      codec: new ArtifactShareCodec(TEST_API_KEY_PEPPER),
      clock: systemClock,
      webAppUrl: 'https://console.example.test'
    }),
    webAppUrl: 'https://console.example.test',
    uploadUrlSeconds: 900,
    now: () => clock.now
  })
  const upload = (ok: ArtifactPublishBeginOk) => {
    if (ok.state !== 'pending') throw new Error('nothing to upload')
    for (const put of ok.uploads) {
      const key = decodeURIComponent(new URL(put.url).pathname).slice('/ac-cache/'.length)
      objects.set(key, {
        exists: true,
        contentLength: Number(put.headers['content-length']),
        checksumSha256: put.headers['x-amz-checksum-sha256']!
      })
    }
  }
  return { service, objects, upload, clock, deletes, bucket }
}

export async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@example.test`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

export async function agentAndSession(
  opts: { visibility?: 'org' | 'private' | 'editors'; ownerIdentity?: string } = {}
) {
  const daemonId = await seedDaemon(prisma, randomUUID())
  const agentId = await seedAgent(prisma, randomUUID(), { daemonId })
  const sessionId = await newSession(agentId, opts)
  const agent = (await new PgAgentRepo(prisma).get(OrgId(DEFAULT_ORG_ID), AgentId(agentId))) as AgentRecord
  return { agent, agentId, sessionId, daemonId }
}

export const newSession = (
  agentId: string,
  opts: { visibility?: 'org' | 'private' | 'editors'; ownerIdentity?: string } = {}
) =>
  seedSessionMeta(prisma, `webchat:${randomUUID()}`, agentId, {
    visibility: opts.visibility ?? 'org',
    ...(opts.ownerIdentity ? { ownerIdentity: opts.ownerIdentity } : {})
  })

/** Begin, upload and complete one revision. */
export async function publish(
  h: ReturnType<typeof harness>,
  agent: AgentRecord,
  sessionId: string,
  extra: { artifactId?: string; initiator?: ArtifactInitiator; manifest?: ArtifactManifest; daemonId?: string } = {}
) {
  const begun = await h.service.begin(
    DEFAULT_ORG_ID,
    agent,
    {
      agentId: agent.id,
      sessionId,
      title: 'Weekly report',
      manifest: extra.manifest ?? manifestOf(['index.html', '<p>hi</p>']),
      idempotencyKey: `key-${randomUUID()}`,
      network: 'cluster',
      ...(extra.artifactId ? { artifactId: extra.artifactId } : {}),
      ...(extra.initiator ? { initiator: extra.initiator } : {})
    },
    extra.daemonId
  )
  h.upload(begun)
  if (begun.state !== 'pending') throw new Error('expected a pending revision')
  return await h.service.complete(DEFAULT_ORG_ID, {
    agentId: agent.id,
    artifactId: begun.artifactId,
    revision: begun.revision
  })
}
