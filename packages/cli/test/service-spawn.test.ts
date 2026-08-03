import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnDaemonViaLoginShell } from '../src/service-spawn.js'
import { daemonLockPath } from '../src/paths.js'

const dir = () => mkdtempSync(join(tmpdir(), 'ac-svc-spawn-'))

/** A fake login shell honoring the POSIX template: drops `-l -i -c <cmd>` and
 *  execs the remaining argv in place (pid preserved), like a real shell would. */
function fakePosixShell(root: string, body = 'shift 4\nexec "$@"'): string {
  const p = join(root, 'bash') // basename "bash" selects the POSIX template
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}

/** A fake daemon entry that writes its pid to the daemon lock and stays alive. */
function fakeDaemonEntry(root: string): string {
  const p = join(root, 'entry.cjs')
  writeFileSync(
    p,
    `require('node:fs').writeFileSync(process.argv[2], String(process.pid) + '\\n')\nsetInterval(() => {}, 1000)\n`
  )
  return p
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}

describe('spawnDaemonViaLoginShell', () => {
  it('marks ready on exit when the daemon writes the lock between polls', async () => {
    const root = dir()
    const lock = daemonLockPath(root)
    const { child, done } = spawnDaemonViaLoginShell(
      root,
      fakeDaemonEntry(root),
      [lock],
      {},
      {
        shell: fakePosixShell(root),
        // Keep the background poll beyond the test window so the exit-time
        // probe is what observes the lock written by the daemon.
        pollMs: 60_000,
        readyTimeoutMs: 5000
      }
    )
    expect(await waitFor(() => existsSync(lock), 5000)).toBe(true)
    child.kill('SIGTERM')
    const result = await done
    expect(result.ready).toBe(true)
    expect(result.signal).toBe('SIGTERM')
  })

  it('kills a hanging shell at the deadline and reports not-ready', async () => {
    const root = dir()
    const { done } = spawnDaemonViaLoginShell(
      root,
      fakeDaemonEntry(root),
      [],
      {},
      {
        // profile hijack: the shell execs something else (tmux-style, pid
        // preserved) and never reaches the daemon. `exec` also keeps the test
        // orphan-free — the watchdog's SIGKILL hits the sleep itself.
        shell: fakePosixShell(root, 'exec sleep 60'),
        pollMs: 25,
        readyTimeoutMs: 400
      }
    )
    const result = await done
    expect(result.ready).toBe(false)
    expect(result.signal).toBe('SIGKILL')
  })

  it('group-kills a profile hanging in a child command — no stray survivors', async () => {
    const root = dir()
    const pidFile = join(root, 'stray.pid')
    const { done } = spawnDaemonViaLoginShell(
      root,
      fakeDaemonEntry(root),
      [],
      {},
      {
        // profile hang in a CHILD command (no exec): the hanging command does
        // not share the shell pid, so only a process-group kill reaps it.
        shell: fakePosixShell(root, `sleep 60 &\necho $! > "${pidFile}"\nwait`),
        pollMs: 25,
        readyTimeoutMs: 400
      }
    )
    const result = await done
    expect(result.ready).toBe(false)
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(await waitFor(() => existsSync(pidFile), 2000)).toBe(true)
    const stray = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
    expect(await waitFor(() => !alive(stray), 3000)).toBe(true)
  })

  it('reports not-ready when the shell dies before reaching the daemon (profile error)', async () => {
    const root = dir()
    const { done } = spawnDaemonViaLoginShell(
      root,
      fakeDaemonEntry(root),
      [],
      {},
      {
        shell: fakePosixShell(root, 'exit 3'),
        pollMs: 25,
        readyTimeoutMs: 5000
      }
    )
    const result = await done
    expect(result.ready).toBe(false)
    expect(result.code).toBe(3)
  })

  it('falls back to a direct spawn (ready by definition) for shells with no template', async () => {
    const root = dir()
    const entry = join(root, 'quick.cjs')
    writeFileSync(entry, 'process.exit(0)\n')
    const { done } = spawnDaemonViaLoginShell(root, entry, [], {}, { shell: '/bin/tcsh' })
    const result = await done
    expect(result.ready).toBe(true)
    expect(result.code).toBe(0)
  })
})
