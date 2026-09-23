// FIFO fixtures for reads of runtime-writable paths: a separate writer turns a blocking read into a wrong answer, not a hung worker.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs, { realpathSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { vi } from 'vitest'

const writers = new Set<ChildProcess>()

/** A FIFO at `path`. POSIX only. */
export function mkfifo(path: string): void {
  execFileSync('mkfifo', [path])
}

// Serves every blocking open while the path is still a FIFO; exits on its own if a crashed run never kills it.
const WRITER = `
const fs = require('node:fs')
const [path, content, delay] = process.argv.slice(1)
setTimeout(() => process.exit(0), 60000).unref()
setTimeout(async () => {
  for (;;) {
    if (!(await fs.promises.lstat(path).catch(() => undefined))?.isFIFO()) return
    await fs.promises.writeFile(path, Buffer.from(content, 'base64')).catch(() => undefined)
  }
}, Number(delay))
`

/** Another process writes `content` into the FIFO (after `delayMs`) for every blocking reader, so one reads that instead of hanging. */
export function fifoWriter(path: string, content: string | Buffer, delayMs = 0): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', WRITER, path, Buffer.from(content).toString('base64'), String(delayMs)],
    { stdio: 'ignore' }
  )
  writers.add(child)
  child.once('exit', () => writers.delete(child))
  return child
}

/** Kill every writer still parked on its FIFO; call from `afterEach`. */
export function killFifoWriters(): void {
  for (const child of writers) child.kill('SIGKILL')
  writers.clear()
}

/** Until the returned restore runs, `lstat`/`stat` of each target answer with `regular`'s stats: the check before a swap, made deterministic. */
export function statsBeforeSwap(targets: string[], regular: string): () => void {
  const fake = fs.lstatSync(regular)
  const swapped = new Set(targets.flatMap((target) => [target, realpathSync(target)]))
  const { lstatSync, statSync } = fs
  const { lstat, stat } = fs.promises
  const sync =
    (original: (...args: never[]) => unknown) =>
    (path: fs.PathLike, ...rest: never[]): unknown =>
      swapped.has(String(path)) ? fake : original(path as never, ...rest)
  const async =
    (original: (...args: never[]) => Promise<unknown>) =>
    async (path: fs.PathLike, ...rest: never[]): Promise<unknown> =>
      swapped.has(String(path)) ? fake : await original(path as never, ...rest)
  const spies = [
    vi.spyOn(fs, 'lstatSync').mockImplementation(sync(lstatSync) as never),
    vi.spyOn(fs, 'statSync').mockImplementation(sync(statSync) as never),
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async(lstat) as never),
    vi.spyOn(fs.promises, 'stat').mockImplementation(async(stat) as never)
  ]
  // Named `node:fs` imports are ESM bindings; this points them at the spies (and back, on restore).
  syncBuiltinESMExports()
  return () => {
    for (const spy of spies) spy.mockRestore()
    syncBuiltinESMExports()
  }
}
