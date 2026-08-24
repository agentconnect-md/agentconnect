#!/usr/bin/env node
// The in-sandbox merge-when-ready watcher: one process per armed pull request, spawned by the shim
// when the daemon arms the box and killed when it disarms. Its own entry for the same reason the
// credential helper and the gh token fetch are — the image copies ONE file per bundle, so two
// entries whose graphs are disjoint stay two single files where a shared module would emit a chunk
// nothing copies.
//
// It runs HERE, in the agent's pod, so the watcher's lifetime is the sandbox's: a reclaimed pod
// takes the intent with it and the console's box reads back unchecked, with nothing persisted
// anywhere to contradict that. It holds no policy — the daemon decided this agent may merge this
// repository, and the token it fetches per tick is clamped CP-side.
import { AUTO_MERGE_POLL_MS } from '../github/auto-merge/core.js'
import { AutoMergeLoop } from '../github/auto-merge/loop.js'
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { fetchGhToken } from '../gitcred/gh-token-ipc.js'
import { SANDBOX_TUNNEL_PATHS } from './sandbox-paths.js'

/** Poll cadence override, so an operator can tighten it without a new image. */
export const AUTO_MERGE_POLL_ENV = 'AC_AUTO_MERGE_POLL_MS'

async function main(): Promise<number> {
  // `<agentId> <owner/repo> <prNumber>`, positional and in that order — the shim spawns this.
  const [agentId, repoFullName, prRaw] = process.argv.slice(2)
  const prNumber = Number(prRaw)
  if (!agentId || !repoFullName || !Number.isInteger(prNumber) || prNumber <= 0) {
    process.stderr.write('agentconnect: auto-merge expects <agentId> <owner/repo> <prNumber>\n')
    return 2
  }
  // The tunnel's path unless something names another; a pod has no daemon root to derive one from.
  const socketPath = process.env[GITCRED_SOCKET_ENV]?.trim() || SANDBOX_TUNNEL_PATHS.gitcred
  const pollMs = Number(process.env[AUTO_MERGE_POLL_ENV]) || AUTO_MERGE_POLL_MS

  // One line of NDJSON per tick on stdout — the shim reads it back as this watcher's status, so
  // the console can say what the merge is waiting on. Nothing else is ever written to stdout.
  const loop = new AutoMergeLoop({
    access: { token: () => fetchGhToken({ agentId, repoFullName, socketPath }) },
    repoFullName,
    prNumber,
    pollMs,
    onStatus: (status) => {
      // BOTH terminal states exit: merged, and the pull request being closed. Exiting is what tells the
      // shim to drop its entry rather than leaving a process that will never do anything again — and a
      // closed watcher left alive is one that would merge the branch if it were ever reopened. The exit
      // waits for the WRITE to flush: stdout is a pipe here, and exiting first would lose the status.
      const done = status.merged || status.closed === true
      process.stdout.write(JSON.stringify(status) + '\n', () => {
        if (done) process.exit(0)
      })
      if (done) loop.stop()
    }
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // The same fence the daemon-local watcher uses: `stop()` moves the generation the tick in flight
      // checks before it merges, and settling before exit means the disarm this signal IS cannot be
      // answered while a squash could still begin in here.
      loop.stop()
      void loop.settle().then(() => process.exit(0))
    })
  }
  loop.start()
  await new Promise<void>(() => {})
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`agentconnect: auto-merge failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
)
