// Stands in for a daemon: starts one srt shim, says where it is, then idles until the test kills it outright.
import { join } from 'node:path'
import { startHostShim } from '../../src/execution/host-shim.js'
import { srtShimBoundary } from '../../src/execution/srt-shim.js'

const [daemonRoot, sessionLeaf, entry, readRoots] = process.argv.slice(2)
const workspaceRoot = join(daemonRoot!, 'sessions', sessionLeaf!)
const shim = await startHostShim({
  daemonRoot: daemonRoot!,
  workspaceRoot,
  entry: JSON.parse(entry!) as { execArgv: string[]; path: string },
  boundary: srtShimBoundary({
    daemonRoot: daemonRoot!,
    mounts: [{ source: workspaceRoot, target: workspaceRoot, mode: 'writable' }],
    readRoots: JSON.parse(readRoots!) as string[]
  })
})
process.stdout.write(
  `${JSON.stringify({ socketPath: shim.socketPath, token: shim.token, runtimeRoot: shim.runtimeRoot })}\n`
)
setInterval(() => {}, 60_000)
