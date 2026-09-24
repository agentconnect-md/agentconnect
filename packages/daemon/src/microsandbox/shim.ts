import { createHash, randomBytes } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import type { Sandbox } from 'microsandbox'
import { z } from 'zod'
import type { Logger } from '../log.js'
import type { ShimSession } from '../shim/session.js'
import { ClusterSkillClient } from '../shim/skill-client.js'
import { DEFAULT_SHIM_RUNTIME_ROOT, SANDBOX_SKILL_STAGING_DIR } from '../shim/sandbox-paths.js'
import {
  DEFAULT_SHIM_LISTEN_PORT,
  SHIM_COMPLETE_ENV_FLAG,
  SHIM_LISTEN_PORT_ENV,
  SHIM_SEED_ENV,
  SHIM_WORKSPACE_ROOT_ENV
} from '../shim/protocol.js'
import { openExecStream, MICROSANDBOX_NODE, type MicrosandboxExecStream } from './exec.js'
import { openGuestTcp } from './tcp.js'

const TIMEOUT_MS = 15_000
const ARTIFACTS = ['index.js', 'skills/dist/cli.js', 'skills/package.json', 'skills/workspace-mutation.js']
let artifacts: Promise<string> | undefined

// Stage this daemon's immutable code, so a retained VM need not change its image to receive a shim fix.
function shimArtifacts(): Promise<string> {
  return (artifacts ??= (async () => {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    for (const root of [join(moduleDir, 'shim'), join(moduleDir, '../../dist/shim')]) {
      try {
        return JSON.stringify(
          Object.fromEntries(
            await Promise.all(
              ARTIFACTS.map(async (path) => [path, (await readFile(join(root, path))).toString('base64')])
            )
          )
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    throw new Error('microsandbox requires the bundled shim; build the daemon before starting it')
  })())
}

const STAGE = String.raw`
import base64, grp, json, os, pwd, sys, tempfile
data = json.load(sys.stdin)
user, _, group = (data['user'] or '0').partition(':')
uid = int(user) if user.isdecimal() else pwd.getpwnam(user).pw_uid
try:
    gid = pwd.getpwuid(uid).pw_gid
except KeyError:
    gid = uid
if group:
    gid = int(group) if group.isdecimal() else grp.getgrnam(group).gr_gid
os.makedirs('${SANDBOX_SKILL_STAGING_DIR}', mode=0o700, exist_ok=True)
# The shim binds its tunnel sockets in the runtime root as the runtime user, which is the pool image's layout.
for path in ('${DEFAULT_SHIM_RUNTIME_ROOT}', '${SANDBOX_SKILL_STAGING_DIR}'):
    os.chown(path, uid, gid)
os.chmod('${DEFAULT_SHIM_RUNTIME_ROOT}', 0o700)
root = tempfile.mkdtemp(prefix='agentconnect-shim-', dir='/run')
os.chmod(root, 0o755)
with open(os.path.join(root, 'package.json'), 'x') as output:
    output.write('{"type":"module"}')
for name, content in data['files'].items():
    path = os.path.join(root, name)
    os.makedirs(os.path.dirname(path), mode=0o755, exist_ok=True)
    with open(path, 'xb') as output:
        output.write(base64.b64decode(content, validate=True))
    os.chmod(path, 0o444)
print(root, flush=True)
`

/** A local VM's skills seam over its bound shim, fenced on the workspace's own identity. */
export async function microsandboxSkillTarget(session: Pick<ShimSession, 'request' | 'hasCapability'>, cwd: string) {
  // VM replacement preserves bind-mounted storage; replacing that storage must revoke its receipts.
  const stat = await lstat(cwd, { bigint: true })
  if (!stat.isDirectory()) throw new Error('skill workspace root is unsafe')
  const identity = [await realpath(cwd), String(stat.dev), String(stat.ino)]
  return {
    workspaceIncarnation: `workspace:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    client: new ClusterSkillClient(
      { request: (capability, request, options) => session.request(capability, { cwd, request }, options) },
      session.hasCapability('skills-wide'),
      true,
      session.hasCapability('skills-receipts')
    )
  }
}

/** A shim running in a VM with nothing bound to it: what "prepare an environment" leaves behind, before any daemon drives it (§5). */
export interface GuestShim {
  /** Open a fresh connection to the shim's guest loopback listener over agentd's TCP stream — its ONE listener, which nothing outside the VM reaches. */
  connect(): Promise<Duplex>
  /** The one-time identity the shim presents: a local daemon compares it, while a remote holder takes the pipe it crossed as the proof instead (§6). */
  token: string
  /** Settles when the shim's exec stream ends, however it ends. */
  exited: Promise<void>
  stop(): Promise<void>
}

/** Copy this daemon's immutable shim code into the VM's `/run` and answer the directory it landed in. */
async function stageShim(input: {
  sdk: Pick<typeof import('microsandbox'), 'AgentClient'>
  sandbox: Sandbox
  artifacts?: () => Promise<string>
}): Promise<string> {
  const { sdk, sandbox } = input
  const staged = await openExecStream(sdk, sandbox, '/usr/bin/python3', ['-I', '-c', STAGE], { user: '0:0', cwd: '/' })
  let directory = ''
  const stageTimer = setTimeout(() => void staged.close(), TIMEOUT_MS)
  try {
    const output = (async () => {
      for await (const event of staged) {
        if (event.kind === 'stdout') directory += Buffer.from(event.data).toString()
        if (event.kind === 'exited' && event.code !== 0) throw new Error('could not stage the sandbox shim')
        if (directory.length > 1024) throw new Error('invalid sandbox shim staging response')
      }
    })()
    void output.catch(() => {})
    const stdin = await staged.takeStdin()
    if (!stdin) throw new Error('sandbox shim staging has no input')
    const config = z
      .object({ runtime: z.object({ user: z.string().nullable().optional() }) })
      .parse(await sandbox.config())
    await stdin.write(
      Buffer.from(
        JSON.stringify({
          user: config.runtime.user ?? null,
          files: JSON.parse(await (input.artifacts ?? shimArtifacts)())
        })
      )
    )
    await stdin.close()
    await output
  } finally {
    clearTimeout(stageTimer)
    await staged.close()
  }
  directory = directory.trim()
  if (!/^\/run\/agentconnect-shim-[a-zA-Z0-9_-]+$/.test(directory)) throw new Error('invalid sandbox shim directory')
  return directory
}

/** Stage the bundle and start the shim in the VM, dialing nothing: the half of a VM's launch that is not "spawn the runtime" (§5). */
export async function startGuestShim(input: {
  sdk: Pick<typeof import('microsandbox'), 'AgentClient'>
  sandbox: Sandbox
  workspaceRoot: string
  /** Whether the daemon driving this VM is on the same machine and sends each runtime's whole environment; a holder on another machine describes a different machine, so for one it is false (§6). */
  completeEnv: boolean
  /** What a hosted session's HOME seed points a runtime at on this machine; the shim fills it in beneath a holder's env, as a host shim does. */
  seedEnv?: Record<string, string>
  /** What the runtime writes to stderr: the shim starts it with its own stderr, so it arrives on the shim's stream. */
  runtimeStderr: (text: string) => void
  /** The shim ended without having been stopped. */
  failed?: (error: Error) => void
  log?: Logger
  // Overridden by tests; the real one reads this daemon's built shim bundle.
  artifacts?: () => Promise<string>
}): Promise<GuestShim> {
  const { sdk, sandbox } = input
  const directory = await stageShim(input)
  const token = randomBytes(32).toString('base64url')
  const log = { info: (s: string) => input.log?.debug(s), warn: (s: string) => input.log?.warn(s) }
  // Only the shim's own lines carry its tag; the rest is the runtime's, which a process spawn would have sent to this daemon's stderr.
  const stderrLine = (line: string): void =>
    line.startsWith('[shim] ') ? log.info(line) : input.runtimeStderr(`${line}\n`)
  let handle: MicrosandboxExecStream | undefined
  let stopping = false
  let pump: Promise<void> | undefined
  let settle!: () => void
  const exited = new Promise<void>((resolve) => (settle = resolve))
  const stop = async () => {
    stopping = true
    const timer = setTimeout(() => void handle?.close(), TIMEOUT_MS)
    try {
      await handle?.kill().catch(() => {})
      await handle?.close()
      await pump?.catch(() => {})
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    handle = await openExecStream(sdk, sandbox, MICROSANDBOX_NODE, [`${directory}/index.js`, '--identity-stdin'], {
      cwd: '/',
      env: {
        // One variable the runner fills in beneath the holder's env, so a seed can name none of the shim's own.
        ...(input.seedEnv && Object.keys(input.seedEnv).length
          ? { [SHIM_SEED_ENV]: JSON.stringify(input.seedEnv) }
          : {}),
        [SHIM_WORKSPACE_ROOT_ENV]: input.workspaceRoot,
        [SHIM_LISTEN_PORT_ENV]: String(DEFAULT_SHIM_LISTEN_PORT),
        ...(input.completeEnv ? { [SHIM_COMPLETE_ENV_FLAG]: '1' } : {})
      }
    })
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void ready.catch(() => {})
    const timer = setTimeout(() => reject(new Error('sandbox shim startup timed out')), TIMEOUT_MS)
    pump = (async () => {
      let output = ''
      let started = false
      let tail = ''
      const text = new TextDecoder()
      for await (const event of handle!) {
        if (event.kind === 'stdout') {
          const chunk = Buffer.from(event.data).toString()
          if (started) log.info(chunk.trim())
          else {
            output += chunk
            if (output.startsWith('ready\n')) {
              started = true
              resolve()
              if (output.length > 6) log.info(output.slice(6).trim())
              output = ''
            } else if (!'ready\n'.startsWith(output)) throw new Error('invalid sandbox shim readiness response')
          }
        }
        if (event.kind === 'stderr') {
          const lines = (tail + text.decode(event.data, { stream: true })).split('\n')
          tail = lines.pop() ?? ''
          for (const line of lines) stderrLine(line)
        }
      }
      if (tail) stderrLine(tail)
      if (!stopping) throw new Error('sandbox shim exited')
    })()
      .catch((error: Error) => {
        reject(error)
        if (!stopping) input.failed?.(error)
      })
      .finally(() => settle())
    try {
      const stdin = await handle.takeStdin()
      if (!stdin) throw new Error('sandbox shim has no identity input')
      await stdin.write(Buffer.from(token))
      await stdin.close()
      await ready
    } finally {
      clearTimeout(timer)
    }
    return { connect: () => openGuestTcp(sdk, sandbox.name, DEFAULT_SHIM_LISTEN_PORT), token, exited, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
