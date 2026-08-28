import { describe, expect, it } from 'vitest'
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
  MAX_CLUSTER_SKILL_MANIFEST_PAGE
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
