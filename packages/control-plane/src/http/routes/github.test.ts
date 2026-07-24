import { describe, expect, it } from 'vitest'
import { OrgId } from '../../domain/ids.js'
import {
  checksPermissionFromPersisted,
  githubInstallationToDto,
  pullRequestsPermissionFromPersisted
} from './github.js'

describe('GitHub installation Checks permission DTO', () => {
  it('exposes the persisted installation-effective permission exactly', () => {
    expect(checksPermissionFromPersisted({ checks: 'write', contents: 'read' })).toBe('write')
    expect(checksPermissionFromPersisted({ checks: 'read', contents: 'read' })).toBe('missing')
    expect(checksPermissionFromPersisted({ contents: 'write' })).toBe('missing')
  })

  it('fails legacy snapshots closed as unknown', () => {
    expect(checksPermissionFromPersisted({})).toBe('unknown')
    expect(pullRequestsPermissionFromPersisted({})).toBe('unknown')
  })

  it('exposes the exact formal-review permission separately', () => {
    expect(pullRequestsPermissionFromPersisted({ pull_requests: 'write' })).toBe('write')
    expect(pullRequestsPermissionFromPersisted({ pull_requests: 'read' })).toBe('read')
    expect(pullRequestsPermissionFromPersisted({ checks: 'write' })).toBe('missing')
  })

  it('keeps exact Checks access distinct from the coarse App-upgrade status', () => {
    const dto = githubInstallationToDto(
      {
        id: 'installation-row-1',
        orgId: OrgId('org-1'),
        installationId: 123n,
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspendedAt: null,
        permissions: { checks: 'write', pull_requests: 'write', contents: 'read' },
        revokedAt: null,
        createdAt: new Date('2026-07-11T00:00:00.000Z')
      },
      new Map([['123', 'https://github.com/organizations/acme/settings/installations/123']])
    )

    expect(dto).toMatchObject({
      permissionsStatus: 'outdated',
      pullRequestsPermission: 'write',
      checksPermission: 'write'
    })
  })
})
