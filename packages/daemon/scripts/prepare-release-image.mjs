import { rmSync, writeFileSync } from 'node:fs'

const metadata = new URL('../dist/release.json', import.meta.url)
const version = process.env.AGENTCONNECT_RELEASE_VERSION

// A development rebuild must not keep a previous release's default image.
rmSync(metadata, { force: true })
if (version !== undefined) {
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) {
    throw new Error('AGENTCONNECT_RELEASE_VERSION must be a stable or rc release version')
  }
  // build.yaml publishes this alias even when the runtime image retains an older effective tag.
  writeFileSync(
    metadata,
    JSON.stringify({ runtimeSandboxImage: `ghcr.io/agentconnect-md/runtime-sandbox-full:v${version}` }) + '\n'
  )
}
