import { defineConfig, configDefaults } from 'vitest/config'
import { githubActionsReporters } from '../../scripts/vitest-github-reporters.js'

// Whole files the suite cannot run on Windows, excluded when the platform IS Windows so
// `vitest run` is green for a Windows contributor too. A single non-portable CASE belongs on
// `it.skipIf(process.platform === 'win32')` — this list is only for files whose every case is
// POSIX-only. `test/windows-exclusions.test.ts` fails if an entry goes stale.
export const WINDOWS_EXCLUDED = [
  // POSIX login-shell semantics end to end: `#!/bin/sh` fake shells, `-l -i -c`, process-group kills.
  'test/service-spawn.test.ts',
  // `shellExecArgv` has no Windows template at all — every case asserts a POSIX shell's argv.
  'test/shell-exec.test.ts',
  // A unit/plist is only ever written on the OS that reads it, so every path here is POSIX by target.
  'test/service-launchd.test.ts',
  'test/service-systemd.test.ts'
]

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(process.platform === 'win32' ? WINDOWS_EXCLUDED : [])],
    reporters: githubActionsReporters('cli.md')
  }
})
