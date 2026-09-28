import { readFileSync } from 'node:fs'

// Read the installed manifest so source builds report the dev version and published bundles report the release.
export const CLI_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version
