/**
 * `GithubInstallationDoorbell` — pull-as-truth semantics, per-installation
 * single-flight + cooldown, and error isolation (webhook-triggers decision 11).
 * Pure logic over faked deps + FakeClock — no DB, no network.
 */
import { describe, it, expect, vi } from 'vitest'
import { GithubInstallationDoorbell } from './installation-doorbell.service.js'
import type { GithubInstallationFacts, GithubInstallationRecord } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const INS = 1234567n

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }

function row(): GithubInstallationRecord {
  return {
    id: 'row-1',
    orgId: OrgId('org-a'),
    installationId: INS,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    suspendedAt: null,
    permissions: {},
    revokedAt: null,
    createdAt: new Date(0)
  }
}

function facts(over: Partial<GithubInstallationFacts> = {}): GithubInstallationFacts {
  return {
    installationId: INS,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'all',
    suspendedAt: null,
    permissions: {},
    ...over
  }
}

function make(opts: {
  known?: boolean
  pull?: () => Promise<GithubInstallationFacts | null>
  onFactsChanged?: (installationId: bigint, orgId: OrgId) => void | Promise<void>
  cooldownMs?: number
}) {
  const clock = new FakeClock()
  const pullInstallation = vi.fn(opts.pull ?? (async () => facts()))
  const getByInstallationId = vi.fn(async () => ((opts.known ?? true) ? row() : null))
  const upsertFromGithub = vi.fn(async (_orgId: OrgId, f: GithubInstallationFacts) => ({ ...row(), ...f }))
  const markRevokedByInstallationId = vi.fn(async () => {})
  const recompileOrg = vi.fn(async () => {})
  const doorbell = new GithubInstallationDoorbell({
    github: { pullInstallation },
    installations: { getByInstallationId, upsertFromGithub, markRevokedByInstallationId },
    recompileOrg,
    ...(opts.onFactsChanged ? { onFactsChanged: opts.onFactsChanged } : {}),
    clock,
    log: silentLog,
    ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {})
  })
  return {
    doorbell,
    clock,
    pullInstallation,
    getByInstallationId,
    upsertFromGithub,
    markRevokedByInstallationId,
    recompileOrg
  }
}

describe('GithubInstallationDoorbell', () => {
  it('unknown installation: ignored — no pull, no recompile (claiming stays with the signed callback)', async () => {
    const h = make({ known: false })
    h.doorbell.poke({ installationId: INS.toString(), action: 'created' })
    await h.doorbell.settle()
    expect(h.pullInstallation).not.toHaveBeenCalled()
    expect(h.recompileOrg).not.toHaveBeenCalled()
  })

  it('known + GitHub 200: upserts under the EXISTING claim org, then recompiles it', async () => {
    const h = make({ pull: async () => facts({ suspendedAt: new Date(1000) }) })
    h.doorbell.poke({ installationId: INS.toString(), action: 'suspend' })
    await h.doorbell.settle()
    expect(h.upsertFromGithub).toHaveBeenCalledWith(OrgId('org-a'), facts({ suspendedAt: new Date(1000) }))
    expect(h.markRevokedByInstallationId).not.toHaveBeenCalled()
    expect(h.recompileOrg).toHaveBeenCalledWith(OrgId('org-a'))
  })

  it('known + GitHub 404/410 (pull → null): marks revoked, then recompiles', async () => {
    const h = make({ pull: async () => null })
    h.doorbell.poke({ installationId: INS.toString(), action: 'deleted' })
    await h.doorbell.settle()
    expect(h.markRevokedByInstallationId).toHaveBeenCalledWith(INS)
    expect(h.upsertFromGithub).not.toHaveBeenCalled()
    expect(h.recompileOrg).toHaveBeenCalledWith(OrgId('org-a'))
  })

  it('settle waits for async fact-change side effects before recompiling', async () => {
    let release!: () => void
    const onFactsChanged = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const h = make({ onFactsChanged })
    h.doorbell.poke({ installationId: INS.toString(), action: 'repositories_added' })
    let settled = false
    const settling = h.doorbell.settle().then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(onFactsChanged).toHaveBeenCalledWith(INS, OrgId('org-a')))
    expect(settled).toBe(false)
    expect(h.recompileOrg).not.toHaveBeenCalled()
    release()
    await settling
    expect(h.recompileOrg).toHaveBeenCalledWith(OrgId('org-a'))
  })

  it('coalesces concurrent pokes onto one in-flight pull', async () => {
    let release!: (f: GithubInstallationFacts) => void
    const gate = new Promise<GithubInstallationFacts>((r) => (release = r))
    const h = make({ pull: () => gate })
    h.doorbell.poke({ installationId: INS.toString(), action: 'added' })
    h.doorbell.poke({ installationId: INS.toString(), action: 'removed' })
    h.doorbell.poke({ installationId: INS.toString(), action: 'added' })
    release(facts())
    await h.doorbell.settle()
    expect(h.pullInstallation).toHaveBeenCalledTimes(1)
    expect(h.recompileOrg).toHaveBeenCalledTimes(1)
  })

  it('a poke inside the cooldown is DEFERRED, not dropped — one trailing pull at expiry', async () => {
    const h = make({ cooldownMs: 30_000 })
    h.doorbell.poke({ installationId: INS.toString(), action: 'suspend' })
    await h.doorbell.settle()
    // Several pokes inside the cooldown collapse onto ONE scheduled re-pull.
    h.doorbell.poke({ installationId: INS.toString(), action: 'unsuspend' })
    h.doorbell.poke({ installationId: INS.toString(), action: 'unsuspend' })
    await h.doorbell.settle()
    expect(h.pullInstallation).toHaveBeenCalledTimes(1) // throttled…
    h.clock.advance(30_001)
    await h.doorbell.settle()
    expect(h.pullInstallation).toHaveBeenCalledTimes(2) // …but never lost
    expect(h.recompileOrg).toHaveBeenCalledTimes(2)
  })

  it('suspend→unsuspend inside one cooldown converges (GitHub sends the flip exactly once)', async () => {
    // The pull reads suspended first (hooks evicted), then the deferred pull
    // reads the unsuspended end state (hooks recompiled) — no manual Sync needed.
    let state: GithubInstallationFacts = facts({ suspendedAt: new Date(1000) })
    const h = make({ cooldownMs: 30_000, pull: async () => state })
    h.doorbell.poke({ installationId: INS.toString(), action: 'suspend' })
    await h.doorbell.settle()
    expect(h.upsertFromGithub).toHaveBeenLastCalledWith(OrgId('org-a'), facts({ suspendedAt: new Date(1000) }))

    state = facts({ suspendedAt: null })
    h.doorbell.poke({ installationId: INS.toString(), action: 'unsuspend' }) // inside cooldown
    h.clock.advance(30_001)
    await h.doorbell.settle()
    expect(h.upsertFromGithub).toHaveBeenLastCalledWith(OrgId('org-a'), facts({ suspendedAt: null }))
    expect(h.recompileOrg).toHaveBeenCalledTimes(2)
  })

  it('a poke landing mid-pull triggers one follow-up pull (the GET may predate the flip)', async () => {
    let release: ((f: GithubInstallationFacts) => void) | undefined
    let calls = 0
    const h = make({
      cooldownMs: 0,
      pull: () => {
        calls += 1
        if (calls === 1) return new Promise<GithubInstallationFacts>((r) => (release = r))
        return Promise.resolve(facts())
      }
    })
    h.doorbell.poke({ installationId: INS.toString(), action: 'added' })
    await vi.waitFor(() => expect(release).toBeDefined()) // the GET is in flight…
    h.doorbell.poke({ installationId: INS.toString(), action: 'removed' }) // …when the flip lands
    release!(facts())
    await h.doorbell.settle()
    await h.doorbell.settle() // the follow-up pull chains off the first completion
    expect(h.pullInstallation).toHaveBeenCalledTimes(2)
  })

  it('stop() cancels scheduled trailing pulls (shutdown)', async () => {
    const h = make({ cooldownMs: 30_000 })
    h.doorbell.poke({ installationId: INS.toString(), action: 'suspend' })
    await h.doorbell.settle()
    h.doorbell.poke({ installationId: INS.toString(), action: 'unsuspend' }) // deferred
    h.doorbell.stop()
    h.clock.advance(60_000)
    await h.doorbell.settle()
    expect(h.pullInstallation).toHaveBeenCalledTimes(1)
  })

  it('a pull failure is swallowed and does not poison later pokes', async () => {
    let calls = 0
    const h = make({
      cooldownMs: 0,
      pull: async () => {
        calls += 1
        if (calls === 1) throw new Error('github 500')
        return facts()
      }
    })
    h.doorbell.poke({ installationId: INS.toString(), action: 'added' })
    await h.doorbell.settle()
    expect(h.recompileOrg).not.toHaveBeenCalled()
    h.doorbell.poke({ installationId: INS.toString(), action: 'added' })
    await h.doorbell.settle()
    expect(h.recompileOrg).toHaveBeenCalledTimes(1)
  })

  it('an unparseable installation id is ignored outright', async () => {
    const h = make({})
    h.doorbell.poke({ installationId: 'not-a-number', action: 'created' })
    await h.doorbell.settle()
    expect(h.getByInstallationId).not.toHaveBeenCalled()
  })
})
