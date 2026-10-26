// Emit `dist/shim/gh` — the gh wrapper the RUNTIME IMAGE puts on the agent's PATH.
// Generated rather than written into the Dockerfile so the pod's wrapper and the daemon's `run/bin/gh` come from
// one `renderGhWrapper`; a second copy of that sh would drift the moment either side's contract moved.
// Its paths are the image's, not this machine's: nothing here may be derived from where the build happened to run.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderGhWrapper, renderSecretsWrapper, SECRETS_WRAPPER_NAME } from '../src/cp/gh-shim.ts'
import { SANDBOX_GH_TOKEN_ENTRY, SANDBOX_GH_WRAPPER_DIR, SANDBOX_SECRETS_ENTRY } from '../src/shim/sandbox-paths.ts'

const out = fileURLToPath(new URL('../dist/shim/gh', import.meta.url))
mkdirSync(fileURLToPath(new URL('../dist/shim', import.meta.url)), { recursive: true })
writeFileSync(
  out,
  renderGhWrapper({
    selfDir: SANDBOX_GH_WRAPPER_DIR,
    tokenCommand: `node ${SANDBOX_GH_TOKEN_ENTRY} "$AC_AGENT_ID" -- "$@"`
  }),
  { mode: 0o755 }
)
console.log(`✓ emitted the sandbox gh wrapper for ${SANDBOX_GH_WRAPPER_DIR}/gh`)
// The live secrets helper's wrapper (capability-requests.md §4.9.2), from the same generator the daemon's run/bin copy uses.
writeFileSync(
  fileURLToPath(new URL(`../dist/shim/${SECRETS_WRAPPER_NAME}`, import.meta.url)),
  renderSecretsWrapper(`node ${SANDBOX_SECRETS_ENTRY}`),
  { mode: 0o755 }
)
console.log(
  `✓ emitted the sandbox ${SECRETS_WRAPPER_NAME} wrapper for ${SANDBOX_GH_WRAPPER_DIR}/${SECRETS_WRAPPER_NAME}`
)
