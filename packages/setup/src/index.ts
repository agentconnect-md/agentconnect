#!/usr/bin/env node
import { Command } from 'commander'
import { checkDeployment } from './check.js'
import { createSetupConfig, DEFAULT_CONFIG_PATH, loadSetupConfig, SetupModeSchema, writeSetupConfig } from './config.js'
import { inspectEnvFile, preflightEnvFile, readEnvFileValues, writeEnvFile } from './env-file.js'
import { convertGithubManifest, GITHUB_DEPLOYMENT_ENV_KEYS, startGithubManifestFlow } from './github-app.js'
import { parseOutputFormat, renderReport, reportExitCode } from './report.js'
import {
  auditSlackManifest,
  buildSlackDeploymentManifest,
  createSlackApp,
  exportSlackManifest,
  requireExternalRelay,
  SLACK_CONFIG_TOKEN_ENV,
  SLACK_DEPLOYMENT_ENV_KEYS
} from './slack-app.js'
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

async function providerConfigurationPath(
  provider: 'GitHub' | 'Slack',
  envFile: string,
  keys: readonly string[]
): Promise<string | undefined> {
  const state = await inspectEnvFile(envFile, keys)
  if (state.missing.length === 0) {
    return state.absolutePath
  }
  if (state.defined.length > 0) {
    throw new Error(
      `${provider} App configuration in ${state.absolutePath} is partial; missing ${state.missing.join(', ')}`
    )
  }
  await preflightEnvFile(envFile, keys)
  return undefined
}

async function verifySlackApp(configToken: string, appId: string, manifest: Record<string, unknown>): Promise<void> {
  const exported = await exportSlackManifest(configToken, appId)
  const missing = auditSlackManifest(exported, manifest)
  if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`)
}

const create = program.command('create').description('Create a deployment-owned provider App once')

create
  .command('github')
  .description('Create a GitHub App through the official manifest flow')
  .option('--name <name>', 'GitHub App name', 'AgentConnect')
  .option('--github-org <login>', 'create the App under this GitHub organization')
  .option('--env-file <path>', 'runtime environment file', '.env')
  .action(async (options: { name: string; githubOrg?: string; envFile: string }) => {
    const config = await loadSetupConfig(program.opts().config)
    requireExternalRelay(config)
    const configuredPath = await providerConfigurationPath('GitHub', options.envFile, GITHUB_DEPLOYMENT_ENV_KEYS)
    if (configuredPath) {
      console.log(`GitHub App is already configured in ${configuredPath}; nothing changed.`)
      return
    }

    const flow = await startGithubManifestFlow(config, options.name, options.githubOrg)
    console.log('Open this local URL in a browser to review and create the GitHub App:')
    console.log(`  ${flow.startUrl}`)

    let code: string
    try {
      code = await flow.code
    } finally {
      await flow.close()
    }
    let credentials: Awaited<ReturnType<typeof convertGithubManifest>>
    try {
      credentials = await convertGithubManifest(code)
    } catch (error) {
      throw new Error(
        `GitHub confirmed App creation, but credential conversion failed: ${(error as Error).message}. Check GitHub Apps settings and delete any orphan before retrying`
      )
    }
    let envPath: string
    try {
      envPath = await writeEnvFile(options.envFile, {
        GITHUB_APP_ID: credentials.appId,
        GITHUB_APP_SLUG: credentials.slug,
        GITHUB_APP_CLIENT_ID: credentials.clientId,
        GITHUB_APP_PRIVATE_KEY_B64: credentials.privateKeyBase64,
        GITHUB_APP_WEBHOOK_SECRET: credentials.webhookSecret,
        GITHUB_APP_CLIENT_SECRET: credentials.clientSecret
      })
    } catch {
      throw new Error(
        `GitHub App ${credentials.slug} was created, but its credentials could not be saved; delete the App before retrying`
      )
    }

    console.log(`Created GitHub App ${credentials.slug} (${credentials.appId}).`)
    console.log(`Saved ${GITHUB_DEPLOYMENT_ENV_KEYS.join(', ')} to ${envPath}.`)
    const settingsUrl = options.githubOrg
      ? `https://github.com/organizations/${options.githubOrg}/settings/apps/${credentials.slug}`
      : `https://github.com/settings/apps/${credentials.slug}`
    console.log(`Settings: ${settingsUrl}`)
    console.log('Next: restart the Control Plane and Relay, then connect GitHub from the AgentConnect console.')
  })

create
  .command('slack')
  .description('Create a deployment Slack App with the App Manifest API')
  .option('--name <name>', 'Slack App name', 'AgentConnect')
  .option('--env-file <path>', 'runtime environment file', '.env')
  .action(async (options: { name: string; envFile: string }) => {
    const config = await loadSetupConfig(program.opts().config)
    const manifest = buildSlackDeploymentManifest(config, options.name)
    const configuredPath = await providerConfigurationPath('Slack', options.envFile, SLACK_DEPLOYMENT_ENV_KEYS)

    const configToken = process.env[SLACK_CONFIG_TOKEN_ENV]?.trim()
    if (configuredPath) {
      if (!configToken) {
        console.log(`Slack App is already configured in ${configuredPath}; no provider call was made.`)
        console.log(`Set ${SLACK_CONFIG_TOKEN_ENV} and rerun to verify its manifest without creating another App.`)
        return
      }
      const values = await readEnvFileValues(options.envFile, ['SLACK_PLATFORM_APP_ID'])
      const appId = values.SLACK_PLATFORM_APP_ID
      if (!appId) throw new Error(`${configuredPath} does not contain a usable SLACK_PLATFORM_APP_ID`)
      try {
        await verifySlackApp(configToken, appId, manifest)
      } catch (error) {
        throw new Error(
          `Slack App ${appId} is configured, but manifest verification failed: ${(error as Error).message}`
        )
      }
      console.log(`Slack App ${appId} is already configured and its manifest was verified; nothing changed.`)
      return
    }
    if (!configToken) {
      throw new Error(`set ${SLACK_CONFIG_TOKEN_ENV} to a temporary Slack App Configuration access token`)
    }

    let credentials: Awaited<ReturnType<typeof createSlackApp>>
    try {
      credentials = await createSlackApp(configToken, manifest)
    } catch (error) {
      throw new Error(
        `Slack App creation could not be confirmed: ${(error as Error).message}. Check Slack Apps for an orphan before retrying`
      )
    }
    let envPath: string
    try {
      envPath = await writeEnvFile(options.envFile, {
        SLACK_PLATFORM_APP_ID: credentials.appId,
        SLACK_PLATFORM_CLIENT_ID: credentials.clientId,
        SLACK_PLATFORM_CLIENT_SECRET: credentials.clientSecret,
        SLACK_PLATFORM_SIGNING_SECRET: credentials.signingSecret
      })
    } catch {
      throw new Error(
        `Slack App ${credentials.appId} was created, but its credentials could not be saved; delete the App before retrying`
      )
    }

    try {
      await verifySlackApp(configToken, credentials.appId, manifest)
    } catch (error) {
      throw new Error(
        `Slack App ${credentials.appId} was created and its credentials were saved to ${envPath}, but manifest verification failed: ${(error as Error).message}. Rerun with ${SLACK_CONFIG_TOKEN_ENV} to retry verification without creating another App`
      )
    }

    console.log(`Created and verified Slack App ${credentials.appId}.`)
    console.log(`Saved ${SLACK_DEPLOYMENT_ENV_KEYS.join(', ')} to ${envPath}.`)
    console.log(`Settings: https://api.slack.com/apps/${credentials.appId}`)
    console.log('Before installing it in other workspaces, activate Public Distribution in Slack App settings.')
    console.log('Next: restart the Control Plane and Relay, then install Slack from the AgentConnect console.')
  })

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
