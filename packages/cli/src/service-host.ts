/** `service-run`: what the Windows logon task launches — the supervisor launchd and systemd are elsewhere. */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { daemonLogPath, logsDir, serviceRunPidPath } from './paths.js'
import { shouldBakeRootEnv } from './service/instance.js'

const FIRST_DELAY_MS = 3_000
const MAX_DELAY_MS = 60_000
const HEALTHY_RUN_MS = 60_000

/** Back off a crash-looping run shell, but start over once it has stayed up for a minute. */
export function nextRespawnDelay(previousMs: number | undefined, livedMs: number): number {
  if (previousMs === undefined || livedMs >= HEALTHY_RUN_MS) return FIRST_DELAY_MS
  return Math.min(previousMs * 2, MAX_DELAY_MS)
}

/** Run `run --root <root>` as a service, logging to daemon.log and respawning it on any exit; only `down` ends it. */
export async function runServiceHost(root: string, cliEntry: string): Promise<never> {
  mkdirSync(logsDir(root), { recursive: true })
  const log = openSync(daemonLogPath(root), 'a')
  const note = (m: string): void => {
    writeSync(log, `${new Date().toISOString()} agentconnect service-run: ${m}\n`)
  }
  // `down` kills this pid's tree: the task scheduler ends only the process it started, not its children.
  writeFileSync(serviceRunPidPath(root), `${process.pid}\n`)
  const env = {
    ...process.env,
    AGENTCONNECT_SUPERVISOR: 'service',
    ...(shouldBakeRootEnv(root) ? { AGENTCONNECT_ROOT: root } : {})
  }
  let delay: number | undefined
  for (;;) {
    const startedAt = Date.now()
    const exit = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [cliEntry, 'run', '--root', root], {
        stdio: ['ignore', log, log],
        env,
        windowsHide: true
      })
      child.on('exit', (code, signal) => resolve(signal ?? `code ${code}`))
      child.on('error', (err) => resolve(`launch error: ${err.message}`))
    })
    delay = nextRespawnDelay(delay, Date.now() - startedAt)
    note(`run shell exited (${exit}) — restarting in ${delay / 1000}s`)
    await new Promise((r) => setTimeout(r, delay))
  }
}
