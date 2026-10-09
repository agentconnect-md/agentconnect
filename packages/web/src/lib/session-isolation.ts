// How the console NAMES `workspaceIsolation: 'session'` — git-workspace-model.md §11.
import { isPoolPlacementKind, type Agent } from '@/lib/data'
import { isSandboxStrategy } from '@/lib/execution-strategy'

/** What decides whether an OS boundary encloses the runtime a session will use. */
export interface RuntimeBoundary {
  /** A managed-pool runtime: its own pod is the boundary, whatever strategy the agent names. */
  pool: boolean
  /** The strategy the agent's sessions run in (session-executors.md §5); every one but `host` is a boundary. */
  execution: string
}

/** Is an OS boundary in effect? A pool runtime is always confined by its pod; elsewhere any strategy but `host` confines. */
export function hasRuntimeBoundary(boundary: RuntimeBoundary): boolean {
  return boundary.pool || isSandboxStrategy(boundary.execution)
}

/** The nouns one effective boundary earns: `mode` names the setting, `checkout`/`checkouts` the per-session directory it produces. */
export interface SessionIsolationLabel {
  mode: string
  checkout: string
  checkouts: string
}

/** No boundary — the per-session directory is a linked worktree of the primary, and saying so is the most useful thing the console can say. */
const WORKTREE_LABEL: SessionIsolationLabel = { mode: 'Worktree', checkout: 'worktree', checkouts: 'worktrees' }

/** Boundary present — the directory is a per-session clone, so the console names the promise instead of an implementation the reader cannot act on. */
const CONFINED_LABEL: SessionIsolationLabel = {
  mode: 'Session isolation',
  checkout: 'session checkout',
  checkouts: 'session checkouts'
}

/** The label for one effective boundary — the only place the two vocabularies are chosen between. */
export function sessionIsolationLabel(boundary: RuntimeBoundary): SessionIsolationLabel {
  return hasRuntimeBoundary(boundary) ? CONFINED_LABEL : WORKTREE_LABEL
}

/** The same label for an agent the console already holds, by its placement and the strategy it names. */
// `orgSetIds` is REQUIRED, like `agentDaemonLabel`'s `groups` and for the same reason: the pool is the set that is NOT the org's, so a caller that omits the list reads every group placement as Cloud and labels a `host` group agent — which gets a plain worktree — "Session isolation".
export function agentSessionIsolationLabel(
  agent: Pick<Agent, 'placementKind' | 'setId' | 'execution'>,
  orgSetIds: ReadonlySet<string>
): SessionIsolationLabel {
  return sessionIsolationLabel({
    pool: isPoolPlacementKind(agent.placementKind, agent.setId, orgSetIds),
    execution: agent.execution
  })
}
