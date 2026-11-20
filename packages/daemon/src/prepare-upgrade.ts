import { parseArgs } from 'node:util'
import { loadConfig } from './config/load-config.js'
import { agentChannelSocketPath } from './cp/agent-channel-server.js'
import { makeLogger } from './log.js'
import { installMicrosandbox } from './microsandbox/install.js'
import { wantsImagePrePull } from './microsandbox/prepull.js'
import { mcpSocketPath, resolveRoot } from './paths.js'

const { values } = parseArgs({ options: { root: { type: 'string' }, config: { type: 'string' } } })
const root = resolveRoot(values.root)
const config = loadConfig({ root, configPath: values.config, optional: true })
// Only a machine with an agent in microsandbox pre-pulls the next image (daemon-sandbox-backends.md).
if (config.sandbox.microsandbox !== false && wantsImagePrePull(root)) {
  const manager = await installMicrosandbox({
    root,
    config: config.sandbox.microsandbox,
    sockets: { mcp: mcpSocketPath(root), agent: agentChannelSocketPath(root) },
    log: makeLogger(config.logging.level)
  })
  await manager.prepareImage()
}
