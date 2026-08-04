#!/usr/bin/env node
import { Command } from 'commander'
import { checkDeployment } from './check.js'
import { createSetupConfig, DEFAULT_CONFIG_PATH, loadSetupConfig, SetupModeSchema, writeSetupConfig } from './config.js'
import { parseOutputFormat, renderReport, reportExitCode } from './report.js'
import { SETUP_VERSION } from './version.js'

const program = new Command()
  .name('agentconnect-setup')
  .description('Set up and check an AgentConnect self-hosted deployment')
  .version(SETUP_VERSION)
  .option('-c, --config <path>', 'setup config path', DEFAULT_CONFIG_PATH)

program
  .command('init [mode]')
  .description('Create a minimal setup config (local, local-auth, or external)')
  .option('--web-url <url>', 'external Web console URL')
  .option('--control-plane-url <url>', 'external AgentConnect API URL')
  .option('--relay-url <url>', 'external callback service URL, when needed')
  .option('--issuer <url>', 'external OIDC issuer ending in /oidc')
  .action(
    async (
      rawMode: string = 'local',
      options: { webUrl?: string; controlPlaneUrl?: string; relayUrl?: string; issuer?: string }
    ) => {
      const mode = SetupModeSchema.parse(rawMode)
      const config = createSetupConfig(mode, {
        web: options.webUrl,
        controlPlane: options.controlPlaneUrl,
        relay: options.relayUrl,
        issuer: options.issuer
      })
      const path = await writeSetupConfig(program.opts().config, config)
      console.log(`Created ${path}`)
      if (mode === 'local') {
        console.log('Next: docker compose up -d --pull always')
        return
      }
      if (mode === 'local-auth') {
        console.log('Next: docker compose -f compose.yaml -f compose.logto.yaml up -d postgres logto')
        console.log(
          'Then open http://admin.agentconnect.localhost:3002 and configure the Logto SPA and GitHub connector.'
        )
        console.log('Set LOGTO_APP_ID and the documented localhost Logto values in .env, then run:')
        console.log('  docker compose -f compose.yaml -f compose.logto.yaml up -d')
        console.log('  npx -y @agentconnect.md/setup check deployment')
        return
      }
      console.log('Next: start your existing stack, then run agentconnect-setup check deployment')
    }
  )

program
  .command('check [scope]')
  .description('Check deployment readiness without changing it')
  .option('--format <format>', 'table or json', 'table')
  .action(async (scope: string = 'deployment', options: { format: string }) => {
    if (scope !== 'deployment') throw new Error(`the MVP supports check deployment only (received '${scope}')`)
    const format = parseOutputFormat(options.format)
    const config = await loadSetupConfig(program.opts().config)
    const findings = await checkDeployment(config)
    console.log(renderReport(config.mode, findings, format))
    process.exitCode = reportExitCode(findings)
  })

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`agentconnect-setup: ${message}`)
  process.exitCode = 1
})
