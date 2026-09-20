// Stands in for a daemon: starts one host shim, says where it is, then idles until the test kills it outright.
import { startHostShim } from '../../src/execution/host-shim.js'

const [daemonRoot, sessionLeaf, entry] = process.argv.slice(2)
const shim = await startHostShim({
  daemonRoot: daemonRoot!,
  sessionLeaf: sessionLeaf!,
  entry: JSON.parse(entry!) as { execArgv: string[]; path: string }
})
process.stdout.write(`${JSON.stringify({ socketPath: shim.socketPath, token: shim.token })}\n`)
setInterval(() => {}, 60_000)
