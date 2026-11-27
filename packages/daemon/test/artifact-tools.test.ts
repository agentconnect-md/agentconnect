// The artifact tools against a fake CP client (artifacts.md §5.3, §7): upload and complete, the card row, refusals, fetch, gating.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WireError } from '@agentconnect.md/connection'
import { parseArtifactMarker, type ArtifactPublishBeginReq } from '@agentconnect.md/protocol'
import {
  ARTIFACT_SHARE_TOOLS,
  ARTIFACT_TOOLS,
  artifactToolsFor,
  fetchArtifact,
  listArtifacts,
  publishArtifact,
  shareArtifact,
  unshareArtifact,
  whoCanOpen,
  type ArtifactPort
} from '../src/mcp/ops/artifacts.js'
import { PutObjectError } from '../src/source-cache/put-object.js'
import { getToolGuide } from '../src/mcp/ops/tool-guide.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { checkCoordinate, gettingToKnowCoordinate } from '../src/session/subsession-coordinate.js'
import { fakeTree, type FakeNode } from './artifact-tree-support.js'

const ARTIFACT = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SHARE = '7d444840-9dc0-41d0-8a3c-3a7b3e6f5b01'
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const ctx = (thread = 'T1'): SessionContext => ({
  agentId: '11111111-1111-4111-8111-111111111111',
  platform: 'slack',
  channel: 'C1',
  thread,
  deliveryThread: thread,
  isDm: false,
  tools: ARTIFACT_TOOLS
})

const published = (revision = 1) => ({
  artifactId: ARTIFACT,
  revision,
  title: 'Q3 report',
  linkPath: `/example-org/artifacts/${ARTIFACT}?revision=${revision}`,
  link: `https://console.example.test/example-org/artifacts/${ARTIFACT}?revision=${revision}`,
  audience: { visibility: 'org' as const, owned: true }
})

function harness(root: FakeNode, overrides: Partial<ArtifactPort> = {}) {
  const tree = fakeTree(root)
  const begins: ArtifactPublishBeginReq[] = []
  const puts: { url: string; headers: Record<string, string>; body: string }[] = []
  const cards: string[] = []
  const completes: unknown[] = []
  const port: ArtifactPort = {
    served: () => true,
    sharesServed: () => true,
    turn: async () => ({ sessionId: 'session-1', turn: 'msg-1', initiator: { kind: 'console', userId: 'user-1' } }),
    begin: async (req) => {
      begins.push(req)
      return {
        state: 'pending',
        artifactId: ARTIFACT,
        revision: 1,
        uploads: req.manifest.files.map((f) => ({
          path: f.path,
          url: `https://store.example.test/${f.path}`,
          headers: { 'x-amz-checksum-sha256': f.sha256 }
        })),
        expiresAt: 0
      }
    },
    complete: async (req) => {
      completes.push(req)
      return published()
    },
    fetch: async () => {
      throw new Error('unused')
    },
    list: async () => ({ artifacts: [] }),
    share: async () => {
      throw new Error('unused')
    },
    unshare: async () => {
      throw new Error('unused')
    },
    network: () => 'public',
    maxFileBytes: () => 50 * 1024 * 1024,
    normalizePath: async (_ctx, path) => path,
    source: async () => ({ ok: true, tree }),
    recordCard: async (_ctx, text) => {
      cards.push(text)
    },
    writeOutputs: async () => ({ ok: true, path: '/x', name: 'files:outputs/x' }),
    put: async (upload, bytes) => {
      puts.push({ url: upload.url, headers: upload.headers, body: bytes.toString() })
    },
    download: async () => Buffer.alloc(0),
    cards: new Set(),
    ...overrides
  }
  return { port, deps: { artifacts: port }, tree, begins, puts, cards, completes }
}

describe('publishArtifact', () => {
  it('begins with the manifest, PUTs each file with its signed headers, completes, and records the card', async () => {
    const h = harness({ 'index.html': '<p>hi</p>', 'style.css': 'p{}' })
    const result = await publishArtifact(
      ctx(),
      { path: 'files:outputs/site', title: 'Q3 report', entry: 'index.html' },
      h.deps
    )
    expect(h.begins).toHaveLength(1)
    expect(h.begins[0]).toMatchObject({
      agentId: ctx().agentId,
      sessionId: 'session-1',
      title: 'Q3 report',
      network: 'public',
      initiator: { kind: 'console', userId: 'user-1' },
      manifest: { entry: 'index.html' }
    })
    expect(h.begins[0]!.idempotencyKey).toMatch(/^pub-/)
    expect(h.puts.map((p) => [p.url, p.headers['x-amz-checksum-sha256'], p.body]).sort()).toEqual([
      ['https://store.example.test/index.html', sha('<p>hi</p>'), '<p>hi</p>'],
      ['https://store.example.test/style.css', sha('p{}'), 'p{}']
    ])
    expect(h.completes).toEqual([{ agentId: ctx().agentId, artifactId: ARTIFACT, revision: 1 }])
    expect(h.cards).toHaveLength(1)
    expect(parseArtifactMarker(h.cards[0]!)?.artifact).toEqual({
      artifactId: ARTIFACT,
      revision: 1,
      title: 'Q3 report'
    })
    expect(result).toEqual({
      artifactId: ARTIFACT,
      revision: 1,
      title: 'Q3 report',
      link: published().link,
      audience: { visibility: 'org', owned: true },
      whoCanOpen: 'Every member of the organization can open it.',
      entry: 'index.html',
      files: 2,
      bytes: 12
    })
  })

  it('falls back to the link path when the CP knows no console origin', async () => {
    const { link: _link, ...bare } = published()
    const h = harness('# notes', { complete: async () => bare })
    const result = (await publishArtifact(ctx(), { path: 'notes.md', title: 'Notes' }, h.deps)) as { link: string }
    expect(result.link).toBe(bare.linkPath)
  })

  it('needs a title to create, and keeps the title on a revision', async () => {
    const h = harness('x')
    await expect(publishArtifact(ctx(), { path: 'a.md' }, h.deps)).rejects.toThrow(/a new artifact needs a `title`/)
    expect(h.begins).toHaveLength(0)
    const result = (await publishArtifact(ctx(), { path: 'a.md', artifactId: ARTIFACT, title: 'Renamed' }, h.deps)) as {
      notice?: string
    }
    expect(h.begins[0]).not.toHaveProperty('title')
    expect(h.begins[0]!.artifactId).toBe(ARTIFACT)
    expect(result.notice).toMatch(/keeps the artifact’s title "Q3 report"/)
  })

  it('skips the uploads when the key replays a ready revision, and leaves one card per revision', async () => {
    const h = harness('x', { begin: async () => ({ state: 'ready', ...published() }) })
    await publishArtifact(ctx(), { path: 'a.md', title: 'Q3 report' }, h.deps)
    await publishArtifact(ctx(), { path: 'a.md', title: 'Q3 report' }, h.deps)
    expect(h.puts).toHaveLength(0)
    expect(h.completes).toHaveLength(0)
    expect(h.cards).toHaveLength(1)
  })

  it('refuses a file that changed between hashing and upload', async () => {
    const h = harness('first')
    const read = h.tree.read.bind(h.tree)
    let calls = 0
    h.tree.read = async (rel, max) => (++calls === 1 ? read(rel, max) : { bytes: Buffer.from('other') })
    await expect(publishArtifact(ctx(), { path: 'a.md', title: 'A' }, h.deps)).rejects.toThrow(
      /"a.md" changed while it was being published/
    )
    expect(h.completes).toHaveLength(0)
  })

  it('retries a dropped PUT once, and reports a refused one', async () => {
    let attempts = 0
    const flaky = harness('x', {
      put: async () => {
        if (++attempts === 1) throw new PutObjectError('upload-failed', 'ECONNRESET')
      }
    })
    await publishArtifact(ctx(), { path: 'a.md', title: 'A' }, flaky.deps)
    expect(attempts).toBe(2)
    const refused = harness('x', {
      put: async () => {
        throw new PutObjectError('upload-refused', 'HTTP 403 AccessDenied')
      }
    })
    await expect(publishArtifact(ctx(), { path: 'a.md', title: 'A' }, refused.deps)).rejects.toThrow(
      /uploading "a.md" failed \(HTTP 403 AccessDenied\); nothing was published/
    )
  })

  it('maps the fence refusals', async () => {
    for (const [reason, pattern] of [
      ['sandboxed', /sandbox is not reachable/],
      ['not-found', /no file or directory at "out\/x"/],
      ['escape', /never `.git` or a path that leaves them/]
    ] as const) {
      const h = harness('x', { source: async () => ({ ok: false, reason }) })
      await expect(publishArtifact(ctx(), { path: 'out/x', title: 'A' }, h.deps)).rejects.toThrow(pattern)
    }
  })

  it('maps every refusal reason to a sentence the agent can act on', async () => {
    const cases: [string, RegExp, Record<string, unknown>?][] = [
      ['not-enabled', /artifacts are not enabled on this deployment\. Use shareFile/],
      ['transfer-unavailable', /artifact storage is unavailable right now.*use shareFile/],
      ['session-unknown', /does not know this session yet/],
      ['session-denied', /may not use artifacts/],
      ['not-found', /no such artifact or revision that this conversation can reach/],
      ['not-producer', /only of artifacts you created\. Leave out artifactId/],
      ['too-large', /over this deployment’s size limit \(boom\)/],
      ['idempotency-conflict', /collided with an earlier one/],
      ['title-required', /needs a `title`/],
      ['incomplete', /did not complete for "a.md"; nothing was published/, { paths: ['a.md'] }],
      ['some-new-reason', /did not complete the request \(boom\)/]
    ]
    for (const [reason, pattern, extra] of cases) {
      const h = harness('x', {
        begin: async () => {
          throw new WireError('CONFLICT', 'boom', false, { reason, ...extra })
        }
      })
      await expect(publishArtifact(ctx(), { path: 'a.md', title: 'A' }, h.deps)).rejects.toThrow(pattern)
    }
    const offline = harness('x', {
      complete: async () => {
        throw new Error('socket closed')
      }
    })
    await expect(publishArtifact(ctx(), { path: 'a.md', title: 'A' }, offline.deps)).rejects.toThrow(
      /control plane is not reachable right now/
    )
  })

  it('reports a card that could not be recorded as a notice, not a failure', async () => {
    const h = harness('x', {
      recordCard: async () => {
        throw new Error('disk full')
      }
    })
    const result = (await publishArtifact(ctx(), { path: 'a.md', title: 'A' }, h.deps)) as { notice?: string }
    expect(result.notice).toMatch(/card could not be added to this conversation; the link works/)
    expect(h.port.cards.size).toBe(0)
  })
})

describe('fetchArtifact', () => {
  const files = { 'index.html': '<p>v2</p>', 'img/logo.svg': '<svg/>' }
  const fetched = (override: Partial<Record<keyof typeof files, string>> = {}) => ({
    artifactId: ARTIFACT,
    revision: 2,
    title: 'Q3 report',
    manifest: {
      entry: 'index.html',
      files: Object.entries(files).map(([path, body]) => ({
        path,
        sha256: sha(body),
        bytes: Buffer.byteLength(body),
        mediaType: 'text/html'
      }))
    },
    downloads: Object.keys(files).map((path) => ({ path, url: `https://store.example.test/${path}` })),
    expiresAt: 0,
    served: { ...files, ...override }
  })

  function fetchHarness(answer: ReturnType<typeof fetched>) {
    const written = new Map<string, string>()
    const dirs: string[] = []
    const { served, ...reply } = answer
    const h = harness('x', {
      fetch: async () => reply,
      download: async (url, max) => {
        const body = Buffer.from(served[url.replace('https://store.example.test/', '') as keyof typeof files])
        return body.subarray(0, max)
      },
      writeOutputs: async (_ctx, dirName, fill) => {
        dirs.push(dirName)
        const staged = new Map<string, string>()
        await fill(async (path, bytes) => void staged.set(path, bytes.toString()))
        for (const [k, v] of staged) written.set(`${dirName}/${k}`, v)
        return { ok: true, path: `/session/files/outputs/${dirName}`, name: `files:outputs/${dirName}` }
      }
    })
    return { ...h, written, dirs }
  }

  it('downloads each file, verifies it, and lands the revision in one outputs directory', async () => {
    const h = fetchHarness(fetched())
    const result = await fetchArtifact(ctx(), { artifactId: ARTIFACT.toUpperCase() }, h.deps)
    expect(h.dirs).toEqual(['Q3-report-0f8fad5b'])
    expect([...h.written]).toEqual([
      ['Q3-report-0f8fad5b/index.html', '<p>v2</p>'],
      ['Q3-report-0f8fad5b/img/logo.svg', '<svg/>']
    ])
    expect(result).toEqual({
      artifactId: ARTIFACT,
      revision: 2,
      title: 'Q3 report',
      path: 'files:outputs/Q3-report-0f8fad5b',
      entry: 'files:outputs/Q3-report-0f8fad5b/index.html',
      files: 2
    })
  })

  it('refuses a file whose bytes do not match the manifest, writing nothing', async () => {
    const h = fetchHarness(fetched({ 'img/logo.svg': '<svg>' }))
    await expect(fetchArtifact(ctx(), { artifactId: ARTIFACT }, h.deps)).rejects.toThrow(
      /"img\/logo.svg" did not match its recorded size and checksum; nothing was replaced/
    )
    expect(h.written.size).toBe(0)
  })

  it('maps a write refusal', async () => {
    const h = harness('x', {
      fetch: async () => {
        const { served: _s, ...reply } = fetched()
        return reply
      },
      writeOutputs: async () => ({ ok: false, reason: 'sandboxed' })
    })
    await expect(fetchArtifact(ctx(), { artifactId: ARTIFACT }, h.deps)).rejects.toThrow(/sandbox is not reachable/)
  })
})

describe('listArtifacts', () => {
  it('passes the cursor and answers a compact page', async () => {
    const asked: unknown[] = []
    const h = harness('x', {
      list: async (req) => {
        asked.push(req)
        return {
          artifacts: [
            {
              artifactId: ARTIFACT,
              title: 'Q3 report',
              audience: { visibility: 'private', owned: true },
              producedByAgent: true,
              updatedAt: '2026-11-20T10:00:00.000Z',
              latest: {
                revision: 3,
                entry: 'index.html',
                entryMediaType: 'text/html',
                fileCount: 2,
                totalBytes: 120,
                producedByAgentName: 'Analyst',
                createdAt: '2026-11-20T10:00:00.000Z'
              },
              shares: [
                {
                  shareId: SHARE,
                  revision: 3,
                  audience: 'public',
                  displayTail: '…abcdef',
                  createdAt: '2026-11-21T10:00:00.000Z'
                }
              ]
            }
          ],
          nextCursor: 'next-page'
        }
      }
    })
    const result = await listArtifacts(ctx(), { cursor: 'page-1' }, h.deps)
    expect(asked).toEqual([{ agentId: ctx().agentId, sessionId: 'session-1', cursor: 'page-1' }])
    expect(result).toEqual({
      artifacts: [
        {
          artifactId: ARTIFACT,
          title: 'Q3 report',
          revision: 3,
          entry: 'index.html',
          mediaType: 'text/html',
          files: 2,
          bytes: 120,
          visibility: 'private',
          canRevise: true,
          updatedAt: '2026-11-20T10:00:00.000Z',
          shares: [
            {
              shareId: SHARE,
              revision: 3,
              audience: 'public',
              displayTail: '…abcdef',
              createdAt: '2026-11-21T10:00:00.000Z'
            }
          ]
        }
      ],
      nextCursor: 'next-page'
    })
  })
})

describe('shareArtifact', () => {
  it('shares with the turn’s initiator and answers the link, who can open it and the share id', async () => {
    const asked: unknown[] = []
    const h = harness('x', {
      share: async (req) => {
        asked.push(req)
        return {
          shareId: SHARE,
          artifactId: ARTIFACT,
          revision: 2,
          audience: req.audience,
          displayTail: '…abcdef',
          createdAt: '2026-11-27T10:00:00.000Z',
          linkPath: '/share/token-abcdef',
          link: 'https://console.example.test/share/token-abcdef'
        }
      }
    })
    const result = await shareArtifact(ctx(), { artifactId: ARTIFACT.toUpperCase(), audience: 'public' }, h.deps)
    expect(asked).toEqual([
      {
        agentId: ctx().agentId,
        sessionId: 'session-1',
        artifactId: ARTIFACT,
        audience: 'public',
        initiator: { kind: 'console', userId: 'user-1' }
      }
    ])
    expect(result).toEqual({
      shareId: SHARE,
      artifactId: ARTIFACT,
      revision: 2,
      audience: 'public',
      link: 'https://console.example.test/share/token-abcdef',
      displayTail: '…abcdef',
      whoCanOpen: expect.stringMatching(/Anyone who has the link.*cannot be recalled/)
    })
  })

  it('passes a revision, falls back to the link path, and says an org link needs sign-in', async () => {
    const h = harness('x', {
      turn: async () => ({ sessionId: 'session-1', turn: 'msg-1' }),
      share: async (req) => {
        expect(req).not.toHaveProperty('initiator')
        expect(req.revision).toBe(1)
        return {
          shareId: SHARE,
          artifactId: ARTIFACT,
          revision: 1,
          audience: 'org',
          displayTail: '…abcdef',
          createdAt: '2026-11-27T10:00:00.000Z',
          linkPath: '/share/token-abcdef'
        }
      }
    })
    const result = await shareArtifact(ctx(), { artifactId: ARTIFACT, audience: 'org', revision: 1 }, h.deps)
    expect(result).toMatchObject({
      link: '/share/token-abcdef',
      whoCanOpen: expect.stringMatching(/Signed-in members/)
    })
  })

  it('refuses a bad audience before asking the control plane', async () => {
    const h = harness('x')
    await expect(shareArtifact(ctx(), { artifactId: ARTIFACT, audience: 'private' }, h.deps)).rejects.toThrow(
      /audience must be "org" or "public"/
    )
  })

  it('maps the share refusals to sentences the agent can act on', async () => {
    const cases: [string, RegExp][] = [
      ['no-member-authority', /only an organization member can share or unshare/],
      ['share-forbidden', /may not do this \(boom\)\. An "org" share is open/],
      ['revision-not-ready', /still uploading/],
      ['not-producer', /share and unshare only artifacts you created/],
      ['share-not-found', /no such share on this artifact/]
    ]
    for (const [reason, pattern] of cases) {
      const refuse = async () => {
        throw new WireError('SCOPE_DENIED', 'boom', false, { reason })
      }
      const h = harness('x', { share: refuse, unshare: refuse })
      const tool = reason === 'share-not-found' ? unshareArtifact : shareArtifact
      await expect(tool(ctx(), { artifactId: ARTIFACT, audience: 'org', shareId: SHARE }, h.deps)).rejects.toThrow(
        pattern
      )
    }
  })
})

describe('unshareArtifact', () => {
  it('revokes the share by id with the turn’s initiator and says copies are not recalled', async () => {
    const asked: unknown[] = []
    const h = harness('x', {
      unshare: async (req) => {
        asked.push(req)
        return {
          shareId: SHARE,
          artifactId: ARTIFACT,
          revision: 1,
          audience: 'public',
          revokedAt: '2026-11-27T10:00:00.000Z'
        }
      }
    })
    const result = await unshareArtifact(ctx(), { artifactId: ARTIFACT, shareId: SHARE }, h.deps)
    expect(asked).toEqual([
      {
        agentId: ctx().agentId,
        sessionId: 'session-1',
        artifactId: ARTIFACT,
        shareId: SHARE,
        initiator: { kind: 'console', userId: 'user-1' }
      }
    ])
    expect(result).toMatchObject({ shareId: SHARE, revokedAt: '2026-11-27T10:00:00.000Z', notice: /not recalled/ })
    await expect(
      unshareArtifact(ctx(), { artifactId: ARTIFACT, shareId: 'https://console.example.test/share/x' }, h.deps)
    ).rejects.toThrow(/shareId must be a share id/)
  })
})

describe('artifact tool gating', () => {
  it('offers the tools only toward a CP that serves them, and never in a check, research or getting-to-know task', () => {
    expect(artifactToolsFor(true, { thread: 'T1' }).map((t) => t.name)).toEqual([
      'publishArtifact',
      'fetchArtifact',
      'listArtifacts'
    ])
    expect(artifactToolsFor(true, { thread: 'T1' }, true).map((t) => t.name)).toEqual([
      'publishArtifact',
      'fetchArtifact',
      'listArtifacts',
      'shareArtifact',
      'unshareArtifact'
    ])
    expect(artifactToolsFor(false, { thread: 'T1' }, true)).toEqual([])
    expect(artifactToolsFor(true, { thread: checkCoordinate('d1') }, true)).toEqual([])
    expect(artifactToolsFor(false, { thread: 'T1' })).toEqual([])
    expect(artifactToolsFor(true, { thread: checkCoordinate('d1') })).toEqual([])
    expect(artifactToolsFor(true, { thread: gettingToKnowCoordinate('d1') })).toEqual([])
  })

  it('refuses share and unshare at execution toward a CP without share links', async () => {
    const h = harness('x', { sharesServed: () => false })
    await expect(shareArtifact(ctx(), { artifactId: ARTIFACT, audience: 'org' }, h.deps)).rejects.toThrow(
      /shareArtifact is not available in this session/
    )
    await expect(unshareArtifact(ctx(), { artifactId: ARTIFACT, shareId: SHARE }, h.deps)).rejects.toThrow(
      /unshareArtifact is not available/
    )
    expect(ARTIFACT_SHARE_TOOLS.map((t) => t.name)).toEqual(['shareArtifact', 'unshareArtifact'])
  })

  it('refuses at execution when the CP stopped serving them', async () => {
    const h = harness('x', { served: () => false })
    await expect(listArtifacts(ctx(), {}, h.deps)).rejects.toThrow(/listArtifacts is not available in this session/)
    await expect(listArtifacts(ctx(), {}, {})).rejects.toThrow(/not available/)
    await expect(listArtifacts(ctx(checkCoordinate('d1')), {}, harness('x').deps)).rejects.toThrow(/not available/)
  })

  it('refuses without a session the CP knows', async () => {
    const h = harness('x', { turn: async () => undefined })
    await expect(listArtifacts(ctx(), {}, h.deps)).rejects.toThrow(/no live turn the control plane knows yet/)
  })

  it('serves a publishArtifact guide that says when the tools are not offered', async () => {
    const guide = (await getToolGuide(ctx(), { tool: 'publishArtifact' }, {})) as Record<string, unknown>
    expect(guide.tool).toBe('publishArtifact')
    expect(guide).not.toHaveProperty('availability')
    const absent = (await getToolGuide({ ...ctx(), tools: [] }, { tool: 'publishArtifact' }, {})) as Record<
      string,
      unknown
    >
    expect(absent.availability).toMatch(/Unavailable here/)
  })
})

describe('whoCanOpen', () => {
  it('says who can open the artifact now', () => {
    expect(whoCanOpen({ visibility: 'private', owned: true })).toMatch(/Only its owner/)
    expect(whoCanOpen({ visibility: 'private', owned: false })).toBe('Only organization owners can open it.')
    expect(whoCanOpen({ visibility: 'external', externalProvider: 'slack', owned: true })).toMatch(
      /can see the Slack conversation it came from/
    )
    expect(whoCanOpen({ visibility: 'editors', owned: false })).toMatch(
      /People who can edit this agent can open it\. It has no owner, so organization owners manage it\./
    )
  })
})
