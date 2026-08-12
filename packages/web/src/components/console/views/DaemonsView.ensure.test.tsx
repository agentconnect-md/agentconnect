// @vitest-environment happy-dom
/**
 * The Daemons page is the convergence point for a managed-execution envelope an
 * org create never produced (a JIT personal org, a waitlist redeem, an org that
 * predates the feature). What matters is not that it fires once, but WHEN it
 * stops firing: the endpoint answers 200 with no `credentialRevision` while the
 * operator is still publishing the namespace, and treating that as done would
 * strand the daemon uncredentialed until a full page reload.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  refreshDaemons: vi.fn(async () => {}),
  orgId: 'org-1',
  role: 'owner' as string
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: mocks.orgId }, myRole: mocks.role, orgPath: (p: string) => `/acme${p}` })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    daemons: [],
    daemonsLoading: false,
    agents: [],
    refreshDaemons: mocks.refreshDaemons,
    renameDaemon: vi.fn()
  })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
// The real ApiError — the retry decision is an instanceof + status check on it.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ensureClusterExecution: mocks.ensure
}))

const { ApiError } = await import('@/lib/api')
const DaemonsView = (await import('./DaemonsView')).default

/** Settled envelope: enabled and credentialed. */
const CREDENTIALED = { enabled: true, credentialRevision: 'key-1' }
/** The operator has not published `status.namespace` yet — still converging. */
const PENDING = { enabled: true }

let orgSeq = 0

/** A fresh org id per test: the "already checked" caches are module-level, so a
 *  reused id would carry one test's verdict into the next. */
function freshOrg(): string {
  orgSeq += 1
  mocks.orgId = `org-${orgSeq}`
  return mocks.orgId
}

/** One trip to the Daemons page. Mount and unmount, because that is what a route
 *  change does — re-rendering the same root would leave the effect's deps
 *  untouched and never re-run it, which is not the thing under test. */
async function visit(): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  // act() drains microtasks on exit, so the ensure chain settles inside the visit.
  await act(async () => {
    root.render(<DaemonsView />)
  })
  await act(async () => root.unmount())
  host.remove()
}

beforeEach(() => {
  mocks.ensure.mockReset()
  mocks.refreshDaemons.mockClear()
  mocks.role = 'owner'
})

describe('DaemonsView cluster-envelope check', () => {
  it('checks once per org and refreshes the fleet the credential registered', async () => {
    freshOrg()
    mocks.ensure.mockResolvedValue(CREDENTIALED)
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
    expect(mocks.refreshDaemons).toHaveBeenCalled()

    // Coming back remounts the view; the answer was final, so nothing reasks.
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
  })

  it('reasks after a deferred credential, which is what finishes provisioning', async () => {
    freshOrg()
    mocks.ensure.mockResolvedValue(PENDING)
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)

    mocks.ensure.mockResolvedValue(CREDENTIALED)
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(2)
    // And now it is done.
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(2)
  })

  it('reasks after a failure rather than swallowing the org forever', async () => {
    freshOrg()
    mocks.ensure.mockRejectedValue(new ApiError('cluster unreachable', 502))
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)

    mocks.ensure.mockResolvedValue(CREDENTIALED)
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(2)
  })

  it('stops asking when the deployment has no cluster at all (404)', async () => {
    freshOrg()
    mocks.ensure.mockRejectedValue(new ApiError('not found', 404))
    await visit()
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
  })

  it('leaves a disabled envelope alone — an owner switched it off', async () => {
    freshOrg()
    mocks.ensure.mockResolvedValue({ enabled: false })
    await visit()
    await visit()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
  })

  it('does not check for a non-owner, who could not provision anyway', async () => {
    freshOrg()
    mocks.role = 'viewer'
    mocks.ensure.mockResolvedValue(CREDENTIALED)
    await visit()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
})
