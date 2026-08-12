import { systemClock, type Clock } from '@agentconnect.md/connection'
import { watchCollection, type K8sHttp, type K8sObject } from '@agentconnect.md/k8s-client'
import type { OperatorConfig } from './config.js'
import type { AgentConnectOrgApi } from './crd/api.js'
import { ORG_LABEL } from './crd/types.js'
import { WorkQueue, type WorkResult } from './workqueue.js'

interface LabeledObject extends K8sObject {
  metadata?: K8sObject['metadata'] & { labels?: Record<string, string> }
}

export interface ControllerOptions {
  http: K8sHttp
  orgApi: AgentConnectOrgApi
  config: OperatorConfig
  reconcile: (name: string) => Promise<WorkResult | void>
  clock?: Clock
  log?: { debug?: (message: string) => void; warn?: (message: string) => void }
}

/** Abortable clock delay; resolves early (without throwing) on abort. */
function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      clock.clearTimeout(handle)
      resolve()
    }
    const handle = clock.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

interface Term {
  controller: AbortController
  queue: WorkQueue
  known: Set<string>
  loops: Promise<void>[]
}

/**
 * Leader-gated control loop: the primary CR watch in the control namespace,
 * secondary Deployment/Pod watches mapped back to the owning CR (status
 * timeliness — daemon readiness must not wait for resync), the short follow-up
 * a pass can ask for when its own reading was provisional, and the bounded
 * full-resync ticker that converges everything else. All term-scoped: losing
 * the lease aborts every watch and drains the queue.
 */
export class Controller {
  private readonly clock: Clock
  private term?: Term

  constructor(private readonly options: ControllerOptions) {
    this.clock = options.clock ?? systemClock
  }

  get isRunning(): boolean {
    return this.term !== undefined
  }

  onStartedLeading(): void {
    if (this.term) return
    const controller = new AbortController()
    const queue = new WorkQueue(this.options.reconcile, { clock: this.clock, log: this.options.log })
    const term: Term = { controller, queue, known: new Set(), loops: [] }
    this.term = term
    term.loops.push(this.runOrgWatch(term), this.runWorkloadWatches(term), this.runResync(term))
  }

  async onStoppedLeading(): Promise<void> {
    const term = this.term
    if (!term) return
    this.term = undefined
    term.controller.abort()
    await Promise.allSettled(term.loops)
    await term.queue.shutdown()
  }

  private async runOrgWatch(term: Term): Promise<void> {
    const source = this.options.orgApi.watch({
      signal: term.controller.signal,
      timeoutSeconds: this.options.config.watchTimeoutSeconds,
      clock: this.clock
    })
    for await (const event of source) {
      if (event.kind === 'synced') {
        term.known = new Set(event.items.map((item) => item.metadata?.name).filter((name): name is string => !!name))
        for (const name of term.known) term.queue.add(name)
        continue
      }
      const name = event.object.metadata?.name
      if (!name) continue
      if (event.kind === 'deleted') term.known.delete(name)
      else term.known.add(name)
      term.queue.add(name)
    }
  }

  /** Deployments and Pods labeled with the org map back to their CR for prompt status. */
  private async runWorkloadWatches(term: Term): Promise<void> {
    const watchOne = async (path: string): Promise<void> => {
      const source = watchCollection<LabeledObject>(this.options.http, {
        path,
        labelSelector: ORG_LABEL,
        signal: term.controller.signal,
        timeoutSeconds: this.options.config.watchTimeoutSeconds,
        clock: this.clock
      })
      for await (const event of source) {
        if (event.kind === 'synced') continue
        const org = event.object.metadata?.labels?.[ORG_LABEL]
        // Another install's workloads carry the same label; only our CRs enqueue.
        if (org && term.known.has(org)) term.queue.add(org)
      }
    }
    await Promise.allSettled([watchOne('/apis/apps/v1/deployments'), watchOne('/api/v1/pods')])
  }

  /** Bounded full resync — the drift-convergence backstop for envelope objects. */
  private async runResync(term: Term): Promise<void> {
    const signal = term.controller.signal
    while (!signal.aborted) {
      await sleep(this.clock, this.options.config.resyncIntervalMs, signal)
      if (signal.aborted) return
      this.options.log?.debug?.(`resync: enqueueing ${term.known.size} orgs`)
      for (const name of term.known) term.queue.add(name)
    }
  }
}
