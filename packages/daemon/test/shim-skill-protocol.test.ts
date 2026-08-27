import { describe, expect, it } from 'vitest'
import {
  ClusterSkillBeginSchema,
  ClusterSkillReconcileReplySchema,
  ClusterSkillReconcileSchema,
  ClusterSkillUploadSchema,
  MAX_CLUSTER_SKILL_FILE_BYTES
} from '../src/shim/skill-protocol.js'

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
})
