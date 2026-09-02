// What the console SAYS when a git write did not do what was asked (§9 M3). Every outcome here is DATA: the daemon answered, and this is what it answered — nothing staged, a commit with no identity to sign it, a push the remote refused. None of it is an error state of the panel.
// The daemon hand-writes a `detail` for each reason and scrubs host paths out of it, so that text is preferred; these strings are the fallback for a daemon that sends a reason with no detail, and they carry the NEXT ACTION the daemon cannot know the console offers.

import type { WorkspaceGitWriteReason } from '@/lib/api'

// A `Record`, not a `switch` with a default: a reason added to the wire enum then fails to typecheck here rather than falling through to prose that describes the wrong thing.
const REASON_TEXT: Record<WorkspaceGitWriteReason, string> = {
  'not-a-repo': 'This workspace is not a git checkout, so there is nothing to stage, commit or push.',
  'nothing-staged': 'Nothing is staged, so there was nothing to commit. Stage a file first.',
  'empty-message': 'A commit needs a message. Write one, or generate it from the staged diff.',
  'no-identity':
    'This daemon registered no commit identity, so the console will not commit under whatever name happens to be on that machine. Reconnect the agent’s GitHub App, then commit again.',
  'detached-head':
    'This checkout has no branch checked out, so there is no branch to push. A session worktree is always detached — push the agent’s primary checkout instead, or ask the agent to push.',
  'no-upstream': 'This branch tracks no remote branch, so the daemon has no ref to push it to.',
  'unsafe-origin': 'This checkout’s remote is not the one the daemon is authorized to push to, so nothing was sent.',
  'unsafe-config':
    'This checkout carries a local git setting the daemon refuses to run, so it was left alone. Inspect its .git/config on the agent’s machine.',
  diverged: 'The remote has commits this branch does not. Pull those first, then push again.',
  rejected: 'The remote refused the push — this agent may not have write access, or the branch may be protected.',
  failed: 'git refused the operation. Nothing was changed.'
}

/** A refused write, as the reader should read it: the daemon's own `detail` when it sent one, else the reason's copy, else a last-resort line for a `reason`-less refusal an older daemon could send. */
export function gitWriteFailureText(reason: WorkspaceGitWriteReason | null, detail: string | null): string {
  const trimmed = detail?.trim()
  if (trimmed) return trimmed
  if (reason) return REASON_TEXT[reason]
  return 'The daemon refused that git operation and gave no reason.'
}

/** A write that never reached an answer: the CP replied with a status instead. `WORKSPACE_STALE` is the daemon's own "the agent is working in here" refusal, and `DAEMON_FEATURE_MISSING` is version skew — both are worth telling apart from an offline daemon, because only one of them is worth retrying now. */
export function gitWriteRequestFailureText(status: number | null, code: string | null): string {
  if (status === 409 && code === 'DAEMON_FEATURE_MISSING') {
    return 'This agent runs a daemon version that cannot stage or commit from the console. Update the agent to work in its checkout here.'
  }
  if (status === 409 && code === 'WORKSPACE_STALE') {
    return 'The agent is working in this workspace right now. Try again when it is idle.'
  }
  if (status === 409) return 'This agent runs a daemon version that cannot write to a session checkout.'
  if (status === 403) return 'Your role in this organization cannot change this agent’s checkout.'
  if (status === 404) return 'This checkout is not available to write to.'
  if (status === 400) return 'The daemon refused that request. Try a smaller selection.'
  return 'Couldn’t reach the checkout — the owning daemon may be offline. Git runs on that machine, so nothing can be staged or committed while it is disconnected.'
}
