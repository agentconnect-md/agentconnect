#!/usr/bin/env node
// The persistent sandbox service shared by Kubernetes and local VMs.
import { readFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { runSandboxRuntimeProvider } from '../acp/sandbox-runtime-provider.js'
import { ShimClient } from './client.js'
import { createAutoMergeHandler } from './auto-merge-handler.js'
import { shimEntryOptions } from './entry-options.js'
import { createExecHandler } from './exec-handler.js'
import { sweepMarkedUntilClear } from './marked-sweep.js'
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

/** The identity's line alone, leaving stdin open: under a lifeline its end-of-file comes later and means stop. */
function readIdentityLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    const done = (error?: Error): void => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.pause()
      if (error) reject(error)
      else resolve(data.slice(0, data.indexOf('\n')).trim())
    }
    const onData = (chunk: Buffer): void => {
      data += chunk.toString()
      if (data.includes('\n')) done()
      else if (data.length > 256) done(new Error('invalid sandbox identity'))
    }
    const onEnd = (): void => done(new Error('stdin closed before the sandbox identity arrived'))
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
  })
}

async function main(): Promise<number> {
  let options: ReturnType<typeof shimEntryOptions>
  try {
    options = shimEntryOptions(process.env)
  } catch (error) {
    log.warn((error as Error).message)
    return 2
  }
  const identityOnStdin = process.argv[2] === '--identity-stdin'
  const localIdentity = !identityOnStdin
    ? undefined
    : options.stdinLifeline
      ? await readIdentityLine()
      : readFileSync(0, 'utf8').trim()
  if (localIdentity !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(localIdentity)) {
    throw new Error('invalid sandbox identity')
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
  let leaving = false
  const leave = (orphaned: boolean): void => {
    if (leaving) return
    leaving = true
    tunnels.close()
    client.stop()
    // On a host no pod or VM teardown follows this exit, so the runtimes are ended here; elsewhere it does, and they are left to it.
    const runtimes = 'socketPath' in options.listen ? client.closeStreams(5_000) : Promise.resolve()
    // An orphan has no launcher left to sweep behind it, so it sweeps its own mark.
    const swept = runtimes
      .catch(() => {})
      .then(() => (orphaned && options.runtimeMark ? sweepMarkedUntilClear(options.runtimeMark) : undefined))
    void swept.then(() => server.stop()).finally(() => process.exit(0))
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => leave(false))
  if (options.parentFd !== undefined) {
    // The daemon holds the other end and never writes: this closes only when that daemon is gone, however it went.
    const parent = new Socket({ fd: options.parentFd, readable: true, writable: false })
    parent.on('error', () => {})
    // That daemon also read this shim's output: once it is gone a log line fails, and must not end the shim before its runtimes.
    for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
    parent.once('close', () => {
      log.warn('the daemon that started this shim is gone — ending its runtimes and exiting')
      leave(true)
    })
    parent.resume()
  }
  if (options.stdinLifeline) {
    // A boundary passes stdio alone, so stdin is the lifeline: its writer closes it to stop the shim, and the kernel does when that daemon dies.
    for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
    process.stdin.on('data', () => {})
    process.stdin.once('end', () => {
      log.warn('stdin closed — ending the runtimes and exiting')
      leave(true)
    })
    process.stdin.resume()
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
