// Runs a make target only where Virtualization.framework exists. Off macOS this is a
// skip, not a failure: the JS packages must build on Linux and Windows CI, which have
// no Swift toolchain and no hypervisor to target. Set AC_VMM_REQUIRE=1 to turn every
// skip into an error, which is what the macOS CI job does so a real break cannot hide.
import { spawnSync } from 'node:child_process'

const target = process.argv[2]
const required = process.env.AC_VMM_REQUIRE === '1'

const skip = (reason) => {
  if (required) {
    console.error(`vmm: refusing to skip \`make ${target}\` with AC_VMM_REQUIRE=1 — ${reason}`)
    process.exit(1)
  }
  console.log(`vmm: skipping \`make ${target}\` — ${reason}`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip(`Virtualization.framework needs macOS, this is ${process.platform}`)
if (spawnSync('swift', ['--version'], { stdio: 'ignore' }).status !== 0) skip('no swift toolchain on PATH')

process.exit(spawnSync('make', [target], { stdio: 'inherit' }).status ?? 1)
