#!/usr/bin/env node
// The bin is a telemetry bootstrap and nothing else. `node:http(s)` hand out their named exports
// when a module that imports them is evaluated, and the Kubernetes client captures `request` that
// way — so an SDK started after that import would wrap functions nobody calls. Everything that
// touches the client therefore lives in `./main.js`, imported dynamically below.
import { pathToFileURL } from 'node:url'
import { startOperatorOpenTelemetry } from './observability.js'
import { PREFLIGHT_UNINSTALL } from './preflight.js'

// Run only as a bin; importing this module (tests, tooling) must stay side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  // The pre-delete hook is a one-shot Job that lists CRs and exits; it gets no exporter.
  const telemetry = argv[0] === PREFLIGHT_UNINSTALL ? undefined : startOperatorOpenTelemetry()
  void import('./main.js')
    .then(({ main }) => main(argv, telemetry))
    .catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
}
