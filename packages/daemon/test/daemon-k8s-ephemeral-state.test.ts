import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import { LocalStore } from '../src/store/local-store.js'

/** A cloud daemon's state root is an emptyDir, so a pod replacement wipes every file it
 *  wrote. What a `--k8s` daemon reads back at boot has to survive in the cloud store
 *  instead — these are the durable semantics that must cross a wipe, and the control
 *  cases that prove the store is what carries them. */

const REMOVED_AGENT = 'agent-doomed'

function seedStateRoot(path: string): void {
  writeFileSync(join(path, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
}

function stateRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-ephemeral-state-'))
  seedStateRoot(path)
  return path
}

/** Replace the pod: the volume is discarded and remounted with only what the deployment
 *  supplies, which is the config file and nothing the previous daemon wrote. */
function replacePod(root: string): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  seedStateRoot(root)
  expect(readdirSync(root)).toEqual(['config.json'])
}

function cloudStore(): { file: string; open: () => LocalStore } {
  const file = join(mkdtempSync(join(tmpdir(), 'ac-cloud-store-')), 'cloud-store.sqlite')
  return { file, open: () => new LocalStore(file) }
}

function catalog(): ResolvedRuntimeCatalog {
  const absent = { command: 'ac-k8s-absent-runtime', args: [], env: [] }
  return {
    entries: {
      claude: { runtime: absent, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' }
    },
    runtimes: { claude: absent }
  }
}

/** One pod lifetime: a fresh daemon over the given state root and cloud store. */
function daemon(root: string, store: LocalStore): Daemon {
  return new Daemon({
    root,
    k8s: true,
    openDataPlane: (async () => ({
      store,
      transcripts: {
        appendTranscript: () => {},
        insertToolCall: () => {},
        updateToolCall: () => {},
        transcriptTailForAgent: async () => ({ rows: [], hasMore: false, cursor: 0 }),
        transcriptPageForAgentByEventTime: async () => ({ rows: [], hasMore: false }),
        transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
        currentTranscriptRevision: async () => 0,
        getToolBodyForAgent: async () => undefined
      },
      close: async () => {}
    })) as never,
    startK8sPlane: (async () => ({
      driver: { claimName: (id: string) => `agent-${id}` } as never,
      listener: { listeningPort: () => 0 } as never,
      gitRunnerFor: () => undefined,
      launchedAgents: () => [],
      suspendIdle: async () => 'absent',
      discardAgent: async () => {},
      stop: async () => {}
    })) as never,
    startControlPlane: vi.fn(() => Promise.resolve()) as never,
    resolveCatalog: async () => catalog(),
    hostFactory: () => ({}) as never
  })
}

/** Run one pod lifetime, hand the caller the live daemon, then shut both it and the
 *  store handle down the way a terminating pod does. */
async function inPod(root: string, store: LocalStore, body: (d: Daemon) => void | Promise<void>): Promise<void> {
  const instance = daemon(root, store)
  try {
    await instance.start()
    await body(instance)
  } finally {
    await instance.stop()
    store.close()
  }
}

describe('--k8s durable semantics across an ephemeral state root', () => {
  it('keeps a removed agent fenced after the state root is wiped', async () => {
    const root = stateRoot()
    const store = cloudStore()

    await inPod(root, store.open(), (before) => {
      // Admission of a CP removal, through the real reservation path that publishes
      // both the filesystem markers and the store row.
      const reservation = (
        before as never as { reserveAgentRemoval(id: string): { markerError?: Error } }
      ).reserveAgentRemoval(REMOVED_AGENT)
      expect(reservation.markerError).toBeUndefined()
    })

    // The removal never reached its delete step: the pod died mid-flight and came back
    // on a volume that has neither filesystem mirror on it.
    replacePod(root)

    await inPod(root, store.open(), (after) => {
      const probe = after as never as {
        removedAgentTombstones: Set<string>
        effectiveAgents(): { id: string }[]
        cpLocalState(): { agents: { agentId: string; origin: string }[] }
      }
      expect(probe.removedAgentTombstones.has(REMOVED_AGENT)).toBe(true)
      expect(probe.effectiveAgents().map((agent) => agent.id)).not.toContain(REMOVED_AGENT)
      // agent/remove is a fire-and-forget EVT that the CP never retries and no reaper
      // replays, so reporting the replica here is the only thing that ever gets the
      // agent's sandbox claim and workspace volume reclaimed.
      expect(probe.cpLocalState().agents).toContainEqual({ agentId: REMOVED_AGENT, origin: 'cp' })
    })
  })

  it('loses the fence when the cloud store is discarded too, isolating what carries it', async () => {
    const root = stateRoot()
    const store = cloudStore()

    await inPod(root, store.open(), (before) => {
      ;(before as never as { reserveAgentRemoval(id: string): unknown }).reserveAgentRemoval(REMOVED_AGENT)
    })
    replacePod(root)

    // The control for the case above: a different database, so nothing but the wiped
    // volume could have carried the obligation.
    await inPod(root, cloudStore().open(), (after) => {
      expect((after as never as { removedAgentTombstones: Set<string> }).removedAgentTombstones.size).toBe(0)
    })
  })

  it('discharges the obligation once the removal completes, so the fence does not outlive it', async () => {
    const root = stateRoot()
    const store = cloudStore()

    await inPod(root, store.open(), (before) => {
      const probe = before as never as {
        reserveAgentRemoval(id: string): unknown
        clearRemovalAfterDestruction(id: string): void
        removedAgentTombstones: Set<string>
      }
      probe.reserveAgentRemoval(REMOVED_AGENT)
      probe.clearRemovalAfterDestruction(REMOVED_AGENT)
      expect(probe.removedAgentTombstones.has(REMOVED_AGENT)).toBe(false)
    })
    replacePod(root)

    await inPod(root, store.open(), (after) => {
      expect((after as never as { removedAgentTombstones: Set<string> }).removedAgentTombstones.size).toBe(0)
    })
  })

  it('reopens the gate across a wipe once an authoritative re-add clears the obligation', async () => {
    const root = stateRoot()
    const store = cloudStore()

    await inPod(root, store.open(), (before) => {
      const probe = before as never as {
        reserveAgentRemoval(id: string): unknown
        clearRemovalForReadd(id: string): void
      }
      probe.reserveAgentRemoval(REMOVED_AGENT)
      // A complete authority replacement: the durable latch has to go with it, or the
      // re-added agent would stay dark on every later pod.
      probe.clearRemovalForReadd(REMOVED_AGENT)
    })
    replacePod(root)

    await inPod(root, store.open(), (after) => {
      expect((after as never as { removedAgentTombstones: Set<string> }).removedAgentTombstones.size).toBe(0)
    })
  })
})

describe('LocalStore agent removal obligations', () => {
  it('admits, lists, and discharges obligations idempotently', () => {
    const store = new LocalStore(':memory:')
    try {
      store.recordAgentRemovalObligation('a', 1)
      store.recordAgentRemovalObligation('b', 2)
      // A retried removal must not multiply the row or slide its admission time.
      store.recordAgentRemovalObligation('a', 9)
      expect(store.agentRemovalObligations().sort()).toEqual(['a', 'b'])

      store.clearAgentRemovalObligation('a')
      expect(store.agentRemovalObligations()).toEqual(['b'])
      // Discharging an obligation that was never admitted is a no-op, not an error.
      store.clearAgentRemovalObligation('a')
      expect(store.agentRemovalObligations()).toEqual(['b'])
    } finally {
      store.close()
    }
  })
})
