import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'
import { ClientTransport } from '@agentconnect.md/connection'
import type { Sandbox } from 'microsandbox'
import { z } from 'zod'
import type { Logger } from '../log.js'
import { ShimDialer } from '../shim/dialer.js'
import { ShimSession } from '../shim/session.js'
import { ClusterSkillClient } from '../shim/skill-client.js'
import { SANDBOX_SKILL_STAGING_DIR } from '../shim/sandbox-paths.js'
import { DEFAULT_SHIM_LISTEN_PORT, SHIM_LISTEN_PORT_ENV, SHIM_WORKSPACE_ROOT_ENV } from '../shim/protocol.js'
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
os.chown('${SANDBOX_SKILL_STAGING_DIR}', uid, gid)
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

export interface MicrosandboxShim {
  session: ShimSession
  incarnation: string
  stop(): Promise<void>
}

export async function microsandboxSkillTarget(shim: MicrosandboxShim, cwd: string) {
  // VM replacement preserves bind-mounted storage; replacing that storage must revoke its receipts.
  const stat = await lstat(cwd, { bigint: true })
  if (!stat.isDirectory()) throw new Error('skill workspace root is unsafe')
  const identity = [await realpath(cwd), String(stat.dev), String(stat.ino)]
  return {
    workspaceIncarnation: `workspace:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`,
    client: new ClusterSkillClient(
      {
        request: (capability, request, options) => shim.session.request(capability, { cwd, request }, options)
      },
      shim.session.hasCapability('skills-wide'),
      true,
      shim.session.hasCapability('skills-receipts')
    )
  }
}

export async function startMicrosandboxShim(input: {
  sdk: Pick<typeof import('microsandbox'), 'AgentClient'>
  sandbox: Sandbox
  agentId: string
  subject: string
  workspaceRoot: string
  generation: number
  failed: () => void
  log?: Logger
}): Promise<MicrosandboxShim> {
  const { sdk, sandbox, subject, generation } = input
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
      Buffer.from(JSON.stringify({ user: config.runtime.user ?? null, files: JSON.parse(await shimArtifacts()) }))
    )
    await stdin.close()
    await output
  } finally {
    clearTimeout(stageTimer)
    await staged.close()
  }
  directory = directory.trim()
  if (!/^\/run\/agentconnect-shim-[a-zA-Z0-9_-]+$/.test(directory)) throw new Error('invalid sandbox shim directory')
  const token = randomBytes(32).toString('base64url')
  const log = { info: (s: string) => input.log?.debug(s), warn: (s: string) => input.log?.warn(s) }
  const session = new ShimSession(subject, generation, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
  const dialer = new ShimDialer({
    verifier: {
      reviewToken: async (presented) => {
        const bytes = Buffer.from(presented)
        return {
          authenticated: bytes.length === Buffer.byteLength(token) && timingSafeEqual(bytes, Buffer.from(token)),
          podName: subject,
          podUid: sandbox.id
        }
      }
    },
    dial: async (url, options) => {
      const socket = await openGuestTcp(sdk, sandbox.name, DEFAULT_SHIM_LISTEN_PORT)
      try {
        return await ClientTransport.dial(url, { ...options, createConnection: () => socket as Socket })
      } catch (error) {
        socket.destroy()
        throw error
      }
    },
    onConnection: (connection) => session.attach(connection),
    log
  })
  let handle: MicrosandboxExecStream | undefined
  let stopping = false
  let pump: Promise<void> | undefined
  const stop = async () => {
    stopping = true
    dialer.stop()
    session.lose('microsandbox shim stopped')
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
        [SHIM_WORKSPACE_ROOT_ENV]: input.workspaceRoot,
        [SHIM_LISTEN_PORT_ENV]: String(DEFAULT_SHIM_LISTEN_PORT)
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
        if (event.kind === 'stderr') log.info(Buffer.from(event.data).toString().trim())
      }
      if (!stopping) throw new Error('sandbox shim exited')
    })().catch((error: Error) => {
      reject(error)
      if (!stopping) {
        session.lose(error.message)
        input.failed()
      }
    })
    try {
      const stdin = await handle.takeStdin()
      if (!stdin) throw new Error('sandbox shim has no identity input')
      await stdin.write(Buffer.from(token))
      await stdin.close()
      await ready
      await dialer.connect(
        `ws://127.0.0.1:${DEFAULT_SHIM_LISTEN_PORT}`,
        {
          agentId: input.agentId,
          subject,
          sandboxUid: sandbox.id,
          generation,
          grants: ['read', 'skills', 'skills-wide', 'skills-receipts'],
          podName: subject
        },
        TIMEOUT_MS
      )
    } finally {
      clearTimeout(timer)
    }
    return { session, incarnation: sandbox.id, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
