#!/usr/bin/env node
// The persistent sandbox service shared by Kubernetes and local VMs.
import { readFileSync } from 'node:fs'
import { runSandboxRuntimeProvider } from '../acp/sandbox-runtime-provider.js'
import { ShimClient } from './client.js'
import { createAutoMergeHandler } from './auto-merge-handler.js'
import { shimEntryOptions } from './entry-options.js'
import { createExecHandler } from './exec-handler.js'
import { resolveCommandInPath } from './path-resolve.js'
import { ShimServer } from './server.js'
import { TunnelHost } from './tunnel-host.js'

if (process.argv[2] === '__sandbox-runtime' || process.argv[2] === '__sandbox-runtime-offline') {
  process.exit(
    await runSandboxRuntimeProvider(process.argv.slice(3), {
      offline: process.argv[2] === '__sandbox-runtime-offline'
    })
  )
}

const log = {
  info: (message: string) => console.error(`[shim] ${message}`),
  warn: (message: string) => console.error(`[shim] ${message}`)
}

async function main(): Promise<number> {
  const localIdentity = process.argv[2] === '--identity-stdin' ? readFileSync(0, 'utf8').trim() : undefined
  if (localIdentity !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(localIdentity)) {
    throw new Error('invalid sandbox identity')
  }
  let options: ReturnType<typeof shimEntryOptions>
  try {
    options = shimEntryOptions(process.env)
  } catch (error) {
    log.warn((error as Error).message)
    return 2
  }
  const { workspaceRoot, paths } = options
  const exec = createExecHandler({ workspaceRoot, paths, log })
  // Watchers own long-lived processes and stay outside the git-only exec inventory.
  const automerge = createAutoMergeHandler({ paths, log })
  const server = new ShimServer({ log })
  // Tunnel listeners follow pod lifetime so credential renewal cannot break client sockets.
  const tunnels = new TunnelHost({
    emit: (streamId, event) => client.emit(streamId, event),
    socketPathFor: (tunnel) => paths.tunnels[tunnel],
    log
  })
  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    dial: () => server.nextTransport(),
    ...(localIdentity ? { readToken: () => localIdentity } : {}),
    // Resolve executable hints and path-qualified registry commands inside the sandbox.
    resolveCommand: resolveCommandInPath,
    // Image-accepted provider config (AC_CLAUDE_*/AC_CODEX_* → the runtime's BASE_URL/API_KEY).
    podEnv: process.env,
    completeEnv: options.completeEnv,
    ...(options.runtimeMark ? { runtimeMark: options.runtimeMark } : {}),
    // Serves materialize and git exec, and ENFORCES the declared inventory here rather than
    // trusting that the daemon sent only permitted subcommands; tunnels are served separately
    // because they own long-lived sockets rather than answering one request.
    handle: (capability, payload, abort, context) =>
      capability === 'tunnel'
        ? tunnels.handle(payload)
        : capability === 'automerge'
          ? automerge(payload)
          : exec(capability, payload, abort, context),
    // Reported in the hello so daemon-built pod paths are anchored on this filesystem.
    workspaceRoot,
    features: ['cluster-skills-v1', 'cluster-skills-v2', 'cluster-skills-v3'],
    log
  })
  if ('socketPath' in options.listen) await server.startOnSocket(options.listen.socketPath)
  else await server.start(options.listen.port, localIdentity ? '127.0.0.1' : undefined)
  if (localIdentity) process.stdout.write('ready\n')
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      tunnels.close()
      client.stop()
      // On a host no pod or VM teardown follows this exit, so the runtimes are ended here; elsewhere it does, and they are left to it.
      const runtimes = 'socketPath' in options.listen ? client.closeStreams(5_000) : Promise.resolve()
      void runtimes.then(() => server.stop()).finally(() => process.exit(0))
    })
  }
  await client.start()
  // Bound: stay up serving daemon requests until the pod goes away.
  await new Promise<void>(() => {})
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.warn(`fatal: ${(err as Error).message}`)
    process.exit(1)
  }
)
