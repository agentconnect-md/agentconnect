// How the console NAMES `workspaceIsolation: 'session'` — git-workspace-model.md §11.
import { isPoolPlacementKind, type Agent, type PlacementKindValue } from '@/lib/data'

/** What decides whether an OS boundary encloses the runtime a session will use. */
export interface RuntimeBoundary {
  /** A managed-pool runtime: its own pod is the boundary, so the daemon offers no `sandbox` capability and `runInSandbox` is not a knob there at all. */
  pool: boolean
  /** The agent's stored Run in sandbox preference — never the label's input on its own. */
  runInSandbox: boolean
  /** Whether the daemon this will run on can provide the sandbox. */
  sandboxSupported: boolean
  /** Whether that daemon's policy forces the sandbox on. */
  sandboxRequired: boolean
}

/** Is an OS boundary in effect? The same `sandboxRequired || (sandboxSupported && runInSandbox)` the agent modals gate their toggle on, with a pool runtime always confined by its own pod. */
export function hasRuntimeBoundary(boundary: RuntimeBoundary): boolean {
  return boundary.pool || boundary.sandboxRequired || (boundary.sandboxSupported && boundary.runInSandbox)
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

/** The same label for an agent the console already holds, whose sandbox triple the CP projected against the daemon it is placed on. */
export function agentSessionIsolationLabel(
  agent: Pick<Agent, 'runInSandbox' | 'sandboxSupported' | 'sandboxRequired'> & { placementKind?: PlacementKindValue }
): SessionIsolationLabel {
  return sessionIsolationLabel({
    pool: isPoolPlacementKind(agent.placementKind),
    runInSandbox: agent.runInSandbox,
    sandboxSupported: agent.sandboxSupported,
    sandboxRequired: agent.sandboxRequired
  })
}
