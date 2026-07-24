import { readFileSync } from 'node:fs'

// The daemon's own version, read from package.json at runtime so it always
// matches the installed package: 1.0.0-dev in the repo, the real version once
// published (semantic-release bumps package.json before the build). Resolved
// relative to this module's URL, which works from source (tsx → src/version.ts)
// and the bundled dist/index.js alike (../package.json sits beside both).
export const DAEMON_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version
