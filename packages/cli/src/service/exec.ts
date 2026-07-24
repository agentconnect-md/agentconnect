/** Production `Exec`: runs a command via `execFile` and never throws — a non-zero
 *  exit (or spawn error) is reported as a resolved `ExecResult`. */
import { execFile } from 'node:child_process'
import type { Exec } from './types.js'

export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      const code =
        err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? Number((err as unknown as { code: number }).code)
          : err
            ? 1
            : 0
      resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
    })
  })
