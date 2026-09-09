import { parseArgs } from 'node:util'
import { loadConfig } from './config/load-config.js'
import { gitcredSocketPath } from './cp/gitcred-server.js'
import { makeLogger } from './log.js'
import { installMicrosandbox } from './microsandbox/install.js'
import { mcpSocketPath, resolveRoot } from './paths.js'

const { values } = parseArgs({ options: { root: { type: 'string' }, config: { type: 'string' } } })
const root = resolveRoot(values.root)
const config = loadConfig({ root, configPath: values.config, optional: true })
if (config.sandbox.backend === 'microsandbox') {
  const manager = await installMicrosandbox({
    root,
    config: config.sandbox.microsandbox,
    sockets: { mcp: mcpSocketPath(root), gitcred: gitcredSocketPath(root) },
    log: makeLogger(config.logging.level)
  })
  await manager.prepareImage()
}
