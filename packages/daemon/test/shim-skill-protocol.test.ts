import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ClusterSkillBeginSchema,
  ClusterSkillManifestSchema,
  ClusterSkillReconcileReplySchema,
  ClusterSkillReconcileSchema,
  ClusterSkillUploadSchema,
  LEGACY_MAX_CLUSTER_SKILL_FILES,
  MAX_CLUSTER_SKILL_CONTROL_BYTES,
  MAX_CLUSTER_SKILL_FILE_BYTES,
  MAX_CLUSTER_SKILL_FILES,
  MAX_CLUSTER_SKILL_MANIFEST_PAGE,
  ClusterSkillReconcileResultSchema,
  GitSkillPlanSchema,
  MAX_CLUSTER_SKILL_SOURCES,
  MAX_SKILL_GET_URL_LENGTH,
  SkillSkipCodeSchema,
  budgetSkillPlanUrls,
  skillReceiptPage,
  skillReplyFor
} from '../src/shim/skill-protocol.js'
import { ClusterSkillClient } from '../src/shim/skill-client.js'

const operationId = '11111111-1111-4111-8111-111111111111'
const digest = 'a'.repeat(64)
const authority = {
  groupId: 'group',
  term: '1',
  daemonId: 'daemon',
  agentId: 'agent',
  workspaceIncarnation: 'claim-uid',
  shimGeneration: 1
}

describe('cluster skill protocol', () => {
  it('accepts a bounded immutable snapshot manifest', () => {
    expect(
      ClusterSkillBeginSchema.parse({
        op: 'begin',
        operationId,
        authority,
        skillsAgentId: 'codex',
        files: [{ sourceId: 'managed:one', path: 'SKILL.md', size: 3, sha256: digest }]
      }).files
    ).toHaveLength(1)
  })

  it.each(['../SKILL.md', '/tmp/SKILL.md', 'a/../../SKILL.md', 'a\\..\\SKILL.md'])('rejects unsafe path %s', (path) => {
    expect(
      ClusterSkillBeginSchema.safeParse({
        op: 'begin',
        operationId,
        authority,
        skillsAgentId: 'codex',
        files: [{ sourceId: 'managed:one', path, size: 3, sha256: digest }]
      }).success
    ).toBe(false)
  })

  it('rejects duplicate source/path identities and oversized declarations', () => {
    const file = { sourceId: 'managed:one', path: 'SKILL.md', size: 3, sha256: digest }
    const base = {
      op: 'begin',
      operationId,
      authority,
      skillsAgentId: 'codex'
    }
    expect(ClusterSkillBeginSchema.safeParse({ ...base, files: [file, file] }).success).toBe(false)
    expect(
      ClusterSkillBeginSchema.safeParse({
        ...base,
        files: [{ ...file, size: MAX_CLUSTER_SKILL_FILE_BYTES + 1 }]
      }).success
    ).toBe(false)
  })

  it('bounds upload chunks and binds them to the declared file', () => {
    expect(
      ClusterSkillUploadSchema.parse({
        op: 'upload',
        operationId,
        handle: 'opaque-handle-1234',
        sourceId: 'managed:one',
        path: 'SKILL.md',
        offset: 0,
        data: Buffer.from('hey').toString('base64'),
        final: true
      }).final
    ).toBe(true)
    expect(
      ClusterSkillUploadSchema.safeParse({
        op: 'upload',
        operationId,
        handle: 'opaque-handle-1234',
        sourceId: 'managed:one',
        path: '../escape',
        offset: 0,
        data: 'aA==',
        final: true
      }).success
    ).toBe(false)
  })

  it('requires all reconciliation fences and rejects inconsistent receipts', () => {
    const request = {
      op: 'reconcile',
      operationId,
      handle: 'opaque-handle-1234',
      authority,
      priorRoots: [],
      replayKey: 'a'.repeat(64),
      allowDesiredAdoption: false,
      sources: []
    }
    expect(ClusterSkillReconcileSchema.safeParse(request).success).toBe(true)
    expect(ClusterSkillReconcileSchema.safeParse({ ...request, authority: { ...authority, term: '01' } }).success).toBe(
      false
    )
    expect(
      ClusterSkillReconcileReplySchema.safeParse({
        roots: [
          {
            path: '.agents/skills/one',
            sourceId: 'managed:one',
            sourceKind: 'managed',
            digest,
            files: [{ path: 'SKILL.md', mode: 0o600, size: 3, sha256: digest }]
          }
        ],
        conflicts: []
      }).success
    ).toBe(false)
  })

  it('carries skipped sources on every receipt page, so paging cannot lose them', () => {
    const skipped = [
      { sourceId: 'agent:0:abc:' + 'f'.repeat(40), reason: 'skills CLI bundle "x" contains an oversized file' }
    ]
    const result = ClusterSkillReconcileResultSchema.parse({ roots: [], conflicts: [], skipped })
    expect(skillReceiptPage(result, 0)).toEqual({ roots: [], conflicts: [], skipped })
    // Absent stays absent: a shim without the field parses unchanged.
    expect(skillReceiptPage(ClusterSkillReconcileResultSchema.parse({ roots: [], conflicts: [] }), 0)).toEqual({
      roots: [],
      conflicts: []
    })
    expect(() =>
      ClusterSkillReconcileResultSchema.parse({ roots: [], conflicts: [], skipped: [{ sourceId: '', reason: 'x' }] })
    ).toThrow()
  })

  it('pages a full Git collection manifest, each page its own frame', async () => {
    // The long content-addressed sourceId on every row is most of the manifest's bytes.
    const files = Array.from({ length: MAX_CLUSTER_SKILL_FILES }, (_unused, index) => ({
      sourceId: `agent:0:${'b'.repeat(64)}:${'c'.repeat(40)}`,
      path: `skills/some-skill-name-${index}/reference/document-${index}.md`,
      size: 1024,
      sha256: digest
    }))
    const frames: Array<Record<string, unknown>> = []
    const client = new ClusterSkillClient(
      {
        async request(_capability, payload) {
          const request = payload as Record<string, unknown>
          frames.push(request)
          return request.op === 'begin' ? { handle: 'opaque-handle-1234' } : { declared: frames.length }
        }
      },
      true
    )
    await client.begin({ operationId, authority, skillsAgentId: 'universal', files })

    expect(frames[0]!.op).toBe('begin')
    expect(frames.slice(1).every((frame) => frame.op === 'manifest')).toBe(true)
    expect(frames.flatMap((frame) => frame.files as unknown[])).toHaveLength(MAX_CLUSTER_SKILL_FILES)
    expect(frames.map((frame) => frame.moreFiles)).toEqual([...frames.slice(0, -1).map(() => true), false])
    for (const frame of frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_CLUSTER_SKILL_CONTROL_BYTES)
    }
  })

  it("reports the bound image's budget, so a caller can spend it across sources", () => {
    const requester = { request: async () => ({ handle: 'opaque-handle-1234' }) }
    // Two sources of 200 files each fit `begin` on a v2 image and must NOT each be measured
    // against a fresh legacy allowance — the pair is what the manifest carries.
    const wide = new ClusterSkillClient(requester, true).manifestLimits
    const legacy = new ClusterSkillClient(requester).manifestLimits
    expect(200 + 200).toBeLessThanOrEqual(wide.maxFiles)
    expect(200 + 200).toBeGreaterThan(legacy.maxFiles)
    expect(legacy.maxFiles).toBe(LEGACY_MAX_CLUSTER_SKILL_FILES)
    expect(wide.maxFiles).toBe(MAX_CLUSTER_SKILL_FILES)
  })

  it('splits a page on bytes, not just row count, when paths are long', () => {
    const files = Array.from({ length: MAX_CLUSTER_SKILL_MANIFEST_PAGE }, (_unused, index) => ({
      sourceId: 'agent:0',
      path: `${'d'.repeat(400)}/file-${index}.md`,
      size: 16,
      sha256: digest
    }))
    // One count-sized page of these would be ~250 KiB — over the frame budget.
    expect(
      ClusterSkillManifestSchema.safeParse({
        op: 'manifest',
        operationId,
        handle: 'h'.repeat(16),
        files,
        moreFiles: false
      }).success
    ).toBe(false)
  })

  it('refuses a widened manifest against a shim that only advertises cluster-skills-v1', async () => {
    const files = Array.from({ length: LEGACY_MAX_CLUSTER_SKILL_FILES + 1 }, (_unused, index) => ({
      sourceId: 'agent:0',
      path: `docs/note-${index}.md`,
      size: 16,
      sha256: digest
    }))
    const begin = { operationId, authority, skillsAgentId: 'universal', files }
    const requester = { request: async () => ({ handle: 'opaque-handle-1234' }) }
    expect(new ClusterSkillClient(requester).manifestLimits.maxFiles).toBe(LEGACY_MAX_CLUSTER_SKILL_FILES)
    expect(new ClusterSkillClient(requester, true).manifestLimits.maxFiles).toBe(MAX_CLUSTER_SKILL_FILES)
    await expect(new ClusterSkillClient(requester).begin(begin)).rejects.toThrow(/this sandbox image admits/)
    await expect(new ClusterSkillClient(requester, true).begin(begin)).resolves.toEqual({
      handle: 'opaque-handle-1234'
    })
  })
})

describe('Git skill plan wire (skill-git-in-pod-v1)', () => {
  const commit = 'c'.repeat(40)
  const plan = {
    sourceId: `agent:0:${'b'.repeat(64)}:${commit}`,
    sourceKind: 'git',
    url: 'https://github.com/acme/skills.git',
    ref: 'refs/heads/main',
    plannedCommit: commit,
    subDir: 'skills/review',
    selections: ['review'],
    getUrl: 'https://bucket.example.com/src/blobless/x.bundle?X-Amz-Signature=abc'
  }
  const reconcile = {
    op: 'reconcile',
    operationId,
    handle: 'opaque-handle-1234',
    authority,
    priorRoots: [],
    replayKey: 'a'.repeat(64),
    allowDesiredAdoption: false,
    sources: [plan]
  }
  const gitReply = {
    roots: [],
    conflicts: [],
    skipped: [{ sourceId: 'agent:1', reason: 'ref moved', code: 'ref_moved' }],
    gitSources: [{ sourceId: plan.sourceId, resolvedCommit: commit, leaves: ['review'] }],
    writeBackCandidates: [
      {
        sourceId: plan.sourceId,
        branch: 'refs/heads/main',
        commit,
        handle: '22222222-2222-4222-8222-222222222222',
        bytes: 4096,
        sha256: Buffer.alloc(32, 7).toString('base64'),
        trigger: 'miss'
      }
    ]
  }
  // The reply schema a daemon predating skill-git-in-pod-v1 parses with: strict, and without the new fields.
  const OlderDaemonReplySchema = z
    .object({
      roots: z.array(z.unknown()),
      conflicts: z.array(z.string()),
      skipped: z.array(z.object({ sourceId: z.string(), reason: z.string() }).strict()).optional()
    })
    .strict()

  it('accepts a tracked-ref entry, a tag, and a pinned SHA without a ref', () => {
    expect(GitSkillPlanSchema.safeParse(plan).success).toBe(true)
    expect(GitSkillPlanSchema.safeParse({ ...plan, ref: 'refs/tags/v1.2.0' }).success).toBe(true)
    const { ref: _ref, subDir: _subDir, getUrl: _getUrl, ...pinned } = plan
    expect(GitSkillPlanSchema.safeParse({ ...pinned, keepInstalled: true }).success).toBe(true)
    expect(ClusterSkillReconcileSchema.safeParse(reconcile).success).toBe(true)
  })

  it.each([
    ['a short SHA', { plannedCommit: 'c'.repeat(12) }],
    ['an uppercase SHA', { plannedCommit: 'C'.repeat(40) }],
    ['a SHA-256 id', { plannedCommit: 'c'.repeat(64) }],
    ['a bare branch', { ref: 'main' }],
    ['HEAD', { ref: 'HEAD' }],
    ['a remote-tracking ref', { ref: 'refs/remotes/origin/main' }],
    ['a ref with ..', { ref: 'refs/heads/a..b' }],
    ['a ref that is an option', { ref: '--upload-pack=x' }],
    ['a parent subDir', { subDir: '../etc' }],
    ['an absolute subDir', { subDir: '/etc' }],
    ['an option subDir', { subDir: '-c/x' }],
    ['a .git subDir', { subDir: 'a/.git/hooks' }],
    ['an http URL', { url: 'http://github.com/acme/skills.git' }],
    ['a userinfo URL', { url: 'https://token@github.com/acme/skills.git' }],
    ['an ssh URL', { url: 'git@github.com:acme/skills.git' }],
    ['a file URL', { url: 'file:///srv/skills' }],
    ['an http getUrl', { getUrl: 'http://bucket.example.com/x.bundle' }],
    ['a file getUrl', { getUrl: 'file:///etc/passwd' }],
    ['a userinfo getUrl', { getUrl: 'https://user@bucket.example.com/x.bundle' }],
    ['a getUrl with a space', { getUrl: 'https://bucket.example.com/a b' }],
    ['an over-long getUrl', { getUrl: `https://bucket.example.com/${'a'.repeat(MAX_SKILL_GET_URL_LENGTH)}` }],
    ['a keepInstalled entry with a getUrl', { keepInstalled: true }],
    ['an unknown field', { refHash: 'x' }]
  ])('rejects %s', (_label, change) => {
    expect(GitSkillPlanSchema.safeParse({ ...plan, ...change }).success).toBe(false)
  })

  it('rejects an entry with no planned commit', () => {
    const { plannedCommit: _plannedCommit, ...unplanned } = plan
    expect(GitSkillPlanSchema.safeParse(unplanned).success).toBe(false)
  })

  it('keeps the uploaded-source shape exactly as it was', () => {
    const uploaded = { sourceId: 'managed:one', sourceKind: 'managed', selections: ['one'] }
    expect(ClusterSkillReconcileSchema.safeParse({ ...reconcile, sources: [uploaded] }).success).toBe(true)
    expect(
      ClusterSkillReconcileSchema.safeParse({ ...reconcile, sources: [{ ...uploaded, url: plan.url }] }).success
    ).toBe(false)
  })

  it('carries a credential window capability only on a Git plan reconcile', () => {
    const credentialWindow = { capability: 'A'.repeat(43) }
    expect(ClusterSkillReconcileSchema.safeParse({ ...reconcile, credentialWindow }).success).toBe(true)
    const uploaded = { sourceId: 'managed:one', sourceKind: 'managed', selections: ['one'] }
    expect(ClusterSkillReconcileSchema.safeParse({ ...reconcile, sources: [uploaded], credentialWindow }).success).toBe(
      false
    )
    for (const capability of ['short', 'has space in it, padded out', `${'a'.repeat(43)}\n`]) {
      expect(ClusterSkillReconcileSchema.safeParse({ ...reconcile, credentialWindow: { capability } }).success).toBe(
        false
      )
    }
    expect(
      ClusterSkillReconcileSchema.safeParse({ ...reconcile, credentialWindow: { ...credentialWindow, extra: 1 } })
        .success
    ).toBe(false)
  })

  it('takes the new reply fields as optional, and an old-shape reply still parses', () => {
    expect(ClusterSkillReconcileReplySchema.parse(gitReply)).toEqual(gitReply)
    expect(ClusterSkillReconcileReplySchema.parse({ roots: [], conflicts: [] })).toEqual({ roots: [], conflicts: [] })
    const legacySkip = { roots: [], conflicts: [], skipped: [{ sourceId: 'agent:1', reason: 'CLI crashed' }] }
    expect(ClusterSkillReconcileReplySchema.parse(legacySkip)).toEqual(legacySkip)
    expect(
      ClusterSkillReconcileReplySchema.safeParse({
        ...gitReply,
        gitSources: [{ sourceId: 'x', resolvedCommit: 'nope', leaves: [] }]
      }).success
    ).toBe(false)
    expect(
      ClusterSkillReconcileReplySchema.safeParse({
        ...gitReply,
        writeBackCandidates: [{ ...gitReply.writeBackCandidates[0], branch: 'refs/tags/v1' }]
      }).success
    ).toBe(false)
  })

  it.each(SkillSkipCodeSchema.options)('round-trips skipped code %s', (code) => {
    const reply = { roots: [], conflicts: [], skipped: [{ sourceId: 'agent:1', reason: 'x', code }] }
    expect(ClusterSkillReconcileReplySchema.parse(JSON.parse(JSON.stringify(reply)))).toEqual(reply)
  })

  it('names exactly the eight skipped-Source codes of source-cache.md §11', () => {
    expect(SkillSkipCodeSchema.options).toEqual([
      'resolution_failed',
      'access_denied',
      'ref_moved',
      'commit_unavailable',
      'sha_fetch_refused',
      'fetch_failed',
      'limits_exceeded',
      'cli_failed'
    ])
    expect(
      ClusterSkillReconcileReplySchema.safeParse({
        roots: [],
        conflicts: [],
        skipped: [{ sourceId: 'a', reason: 'x', code: 'git_said_no' }]
      }).success
    ).toBe(false)
  })

  it('never sends a daemon without skill-git-in-pod-v1 a field its strict schema refuses', () => {
    // Such a daemon never sends a Git plan, so every reconcile it sends is answered in the old shape.
    const legacyRequest = { sources: [{ sourceId: 'managed:one', sourceKind: 'managed' as const, selections: [] }] }
    const answered = skillReplyFor(legacyRequest, ClusterSkillReconcileResultSchema.parse(gitReply))
    expect(answered).toEqual({ roots: [], conflicts: [], skipped: [{ sourceId: 'agent:1', reason: 'ref moved' }] })
    expect(OlderDaemonReplySchema.safeParse(answered).success).toBe(true)
    expect(OlderDaemonReplySchema.safeParse(skillReceiptPage(answered, 0)).success).toBe(true)
    // A Git plan reconcile keeps them, on every receipt page.
    const planned = skillReplyFor(
      ClusterSkillReconcileSchema.parse(reconcile),
      ClusterSkillReconcileResultSchema.parse(gitReply)
    )
    expect(planned).toEqual(gitReply)
    expect(skillReceiptPage(planned, 0)).toEqual(gitReply)
  })

  it('fits 64 Sources with maximum-length GET URLs under the control-frame cap by dropping URLs', () => {
    const getUrl = `https://bucket.example.com/${'a'.repeat(MAX_SKILL_GET_URL_LENGTH - 'https://bucket.example.com/'.length)}`
    expect(getUrl).toHaveLength(MAX_SKILL_GET_URL_LENGTH)
    const sources = Array.from({ length: MAX_CLUSTER_SKILL_SOURCES }, (_unused, index) => ({
      ...plan,
      sourceId: `agent:${index}:${'b'.repeat(64)}:${commit}`,
      url: `https://github.com/acme/${'r'.repeat(1900)}-${index}.git`,
      getUrl
    }))
    const request = ClusterSkillReconcileSchema.safeParse({ ...reconcile, sources })
    expect(request.success).toBe(false)
    const budgeted = budgetSkillPlanUrls({ ...reconcile, sources: GitSkillPlanSchema.array().parse(sources) })
    expect(Buffer.byteLength(JSON.stringify(budgeted))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
    expect(ClusterSkillReconcileSchema.safeParse(budgeted).success).toBe(true)
    // Earlier Sources keep their bundle; the ones past the budget clone without one.
    const kept = budgeted.sources.map((source) => 'getUrl' in source && source.getUrl !== undefined)
    expect(kept[0]).toBe(true)
    expect(kept.at(-1)).toBe(false)
    expect(kept.indexOf(false)).toBe(kept.filter(Boolean).length)
    // A plan already under the cap is untouched.
    const small = ClusterSkillReconcileSchema.parse(reconcile)
    expect(budgetSkillPlanUrls(small)).toEqual(small)
  })

  it('sends a budgeted Git plan only to a shim granted skills-git', async () => {
    const frames: Array<Record<string, unknown>> = []
    const requester = {
      async request(_capability: string, payload: unknown) {
        frames.push(payload as Record<string, unknown>)
        return gitReply
      }
    }
    const { op: _op, ...input } = ClusterSkillReconcileSchema.parse(reconcile)
    const getUrl = `https://bucket.example.com/${'a'.repeat(8000)}`
    const sources = Array.from({ length: MAX_CLUSTER_SKILL_SOURCES }, (_unused, index) => ({
      ...input.sources[0]!,
      sourceId: `agent:${index}`,
      getUrl
    }))
    await expect(new ClusterSkillClient(requester, true, false, true).reconcile(input)).rejects.toThrow(
      /does not take Git skill plans/
    )
    expect(frames).toHaveLength(0)
    const client = new ClusterSkillClient(requester, true, false, true, true)
    expect(client.gitInPod).toBe(true)
    await expect(client.reconcile({ ...input, sources })).resolves.toEqual(gitReply)
    expect(Buffer.byteLength(JSON.stringify(frames[0]))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
    expect(new ClusterSkillClient(requester).gitInPod).toBe(false)
  })

  it('budgets the frame reconcile() sends, so a plan just past the cap drops one more URL instead of throwing', async () => {
    const frames: Array<Record<string, unknown>> = []
    const requester = {
      async request(_capability: string, payload: unknown) {
        frames.push(payload as Record<string, unknown>)
        return gitReply
      }
    }
    const client = new ClusterSkillClient(requester, true, false, true, true)
    const { op: _op, ...input } = ClusterSkillReconcileSchema.parse(reconcile)
    const getUrl = `https://bucket.example.com/${'a'.repeat(MAX_SKILL_GET_URL_LENGTH - 'https://bucket.example.com/'.length)}`
    const count = 28
    // Spreads `pad` extra bytes over the Source URLs, each kept under the URL cap.
    const make = (pad: number) =>
      GitSkillPlanSchema.array().parse(
        Array.from({ length: count }, (_unused, index) => {
          const extra = Math.max(0, Math.min(1900, pad - index * 1900))
          return {
            ...plan,
            sourceId: `agent:${index}`,
            url: `https://github.com/acme/${'r'.repeat(extra)}-${index}.git`,
            getUrl
          }
        })
      )
    const sent = (sources: unknown[]) =>
      Buffer.byteLength(JSON.stringify({ op: 'reconcile', ...input, priorRoots: [], priorRootCount: 0, sources }))
    const full = sent(make(0))
    const urlBytes = Buffer.byteLength(`,"getUrl":${JSON.stringify(getUrl)}`)
    let drops = 1
    while (full - drops * urlBytes > MAX_CLUSTER_SKILL_CONTROL_BYTES) drops++
    for (let over = 1; over <= 48; over++) {
      // With `drops` URLs gone the sent frame is `over` bytes past the cap, inside the old undercount window.
      const sources = make(MAX_CLUSTER_SKILL_CONTROL_BYTES + over - (full - drops * urlBytes))
      expect(sent(sources) - drops * urlBytes).toBe(MAX_CLUSTER_SKILL_CONTROL_BYTES + over)
      frames.length = 0
      await expect(client.reconcile({ ...input, sources })).resolves.toEqual(gitReply)
      expect(Buffer.byteLength(JSON.stringify(frames[0]))).toBeLessThanOrEqual(MAX_CLUSTER_SKILL_CONTROL_BYTES)
      const dropped = (frames[0]!['sources'] as Array<Record<string, unknown>>).filter(
        (source) => !('getUrl' in source)
      )
      expect(dropped.length).toBe(drops + 1)
    }
  })
})
