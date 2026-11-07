// Emit `dist/shim/agentconnect-secrets` — the live secrets wrapper the RUNTIME IMAGE puts on the agent's PATH.
// Generated from the same `renderSecretsWrapper` the daemon's `run/secrets-bin` copy uses, so the two cannot drift.
// Its paths are the image's, not this machine's: nothing here may be derived from where the build happened to run.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderSecretsWrapper, SECRETS_WRAPPER_NAME } from '../src/cp/secrets-shim.ts'
import { SANDBOX_PATHBIN_DIR, SANDBOX_SECRETS_ENTRY } from '../src/shim/sandbox-paths.ts'

mkdirSync(fileURLToPath(new URL('../dist/shim', import.meta.url)), { recursive: true })
// capability-requests.md §4.9.2.
writeFileSync(
  fileURLToPath(new URL(`../dist/shim/${SECRETS_WRAPPER_NAME}`, import.meta.url)),
  renderSecretsWrapper(`node ${SANDBOX_SECRETS_ENTRY}`),
  { mode: 0o755 }
)
console.log(`✓ emitted the sandbox ${SECRETS_WRAPPER_NAME} wrapper for ${SANDBOX_PATHBIN_DIR}/${SECRETS_WRAPPER_NAME}`)
