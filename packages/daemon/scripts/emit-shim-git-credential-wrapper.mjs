// Emit `dist/bin/git-credential` — the credential helper git runs when this installation is a session's helper root
// (the host and srt strategies). Without it every credentialed clone of a session placed here fails.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { INSTALLATION_GIT_CREDENTIAL_WRAPPER } from '../src/shim/git-credential-wrapper.ts'

mkdirSync(fileURLToPath(new URL('../dist/bin', import.meta.url)), { recursive: true })
writeFileSync(
  fileURLToPath(new URL('../dist/bin/git-credential', import.meta.url)),
  INSTALLATION_GIT_CREDENTIAL_WRAPPER,
  {
    mode: 0o755
  }
)
console.log('✓ emitted the installation git credential helper at dist/bin/git-credential')
