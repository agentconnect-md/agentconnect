#!/usr/bin/env node
import { Command } from 'commander'
import { serveTenantAdmin } from './admin/server.js'
import { checkDeployment } from './check.js'
import { createSetupConfig, DEFAULT_CONFIG_PATH, loadSetupConfig, SetupModeSchema, writeSetupConfig } from './config.js'
import {
  applyDeploymentConfig,
  DEFAULT_TENANT_ADMIN_URL,
  githubDeploymentPut,
  readDeploymentConfigPut,
  slackDeploymentPut,
  TenantAdminClient,
  type DeploymentConfigAdmin
} from './deployment-config-client.js'
import { inspectEnvFile, preflightEnvFile, readEnvFileValues, writeEnvFile } from './env-file.js'
import { convertGithubManifest, GITHUB_DEPLOYMENT_ENV_KEYS, startGithubManifestFlow } from './github-app.js'
import { parseOutputFormat, renderReport, reportExitCode } from './report.js'
import {
  auditSlackManifest,
  buildSlackDeploymentManifest,
  createSlackApp,
  exportSlackManifest,
  type ProviderAppConfig,
  requireExternalRelay,
  requireProviderAppEndpoints,
  SLACK_CONFIG_TOKEN_ENV,
  SLACK_DEPLOYMENT_ENV_KEYS
} from './slack-app.js'
import { SETUP_VERSION } from './version.js'

const program = new Command()
  .name('agentconnect-setup')
  .description('Set up and check an AgentConnect self-hosted deployment')
  .version(SETUP_VERSION)
  .option('-c, --config <path>', 'setup config path', DEFAULT_CONFIG_PATH)
  .option('--admin-url <url>', 'temporary tenant-admin server origin', DEFAULT_TENANT_ADMIN_URL)

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be an integer from 1 to 65535')
  return port
}

program
  .command('serve')
  .description('Run the temporary local Tenant Admin UI and API')
  .option('--host <host>', 'listen host (default: 127.0.0.1)')
  .option('--port <port>', 'listen port (default: 8091)', parsePort)
  .action(async (options: { host?: string; port?: number }) => serveTenantAdmin(options))

program
  .command('init [mode]')
  .description('Create a minimal setup config (local, local-auth, or external)')
  .option('--control-plane-url <url>', 'bootstrap AgentConnect API URL (required for external mode)')
  .option('--web-url <url>', 'legacy env-fallback Web console URL')
  .option('--relay-url <url>', 'legacy env-fallback callback service URL')
  .option('--issuer <url>', 'legacy env-fallback OIDC issuer ending in /oidc')
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
          'In Logto, create one SPA with redirect URIs http://localhost:3000/auth/callback and http://localhost:8091/auth/callback, plus matching CORS origins.'
        )
        console.log(
          'Create one Management API M2M app with `all` access to https://default.logto.app/api; the setup README has the copy-paste deployment document.'
        )
        console.log(
          'Then start temporary admin: docker compose -f compose.yaml -f compose.logto.yaml --profile admin up -d tenant-admin'
        )
        console.log('Configure with `config apply`; run `create github|slack` as needed; then run `check logto`.')
        console.log('Finally stop tenant-admin, restart the stack, and run `check deployment`.')
        return
      }
      console.log(
        "Next: run this release's database migrations, start `agentconnect-setup serve`, then run `config apply` and `create` as needed."
      )
      console.log('Stop temporary admin, restart the deployment, then run `check deployment`.')
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

function requireJsonFormat(value: string): void {
  if (value !== 'json') throw new Error(`unknown format '${value}' (use json)`)
}

function tenantAdminClient(): TenantAdminClient {
  return new TenantAdminClient(program.opts<{ adminUrl: string }>().adminUrl)
}

function providerConfigFromDeployment(current: DeploymentConfigAdmin): ProviderAppConfig {
  const config: ProviderAppConfig = {
    services: {
      web: current.values.publicUrls.web ?? '',
      controlPlane: current.values.publicUrls.controlPlane ?? '',
      ...(current.values.publicUrls.relay ? { relay: current.values.publicUrls.relay } : {})
    }
  }
  requireProviderAppEndpoints(config)
  return config
}

function sameProviderEndpoints(left: ProviderAppConfig, right: ProviderAppConfig): boolean {
  return JSON.stringify(left.services) === JSON.stringify(right.services)
}

interface ProviderCreateResult {
  schemaVersion: '1'
  operation: 'create.github' | 'create.slack'
  status: 'created' | 'already-configured'
  changed: boolean
  sink: 'deployment-config' | 'env-file'
  app: { id: string; slug?: string }
  verified?: boolean
  revision: number | null
  restartRequired: boolean
  settingsUrl: string
  environmentFile?: string
}

function printCreateResult(result: ProviderCreateResult, format: 'table' | 'json', messages: readonly string[]): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const message of messages) console.log(message)
}

const configCommand = program.command('config').description('Read or apply deployment settings through tenant-admin')

configCommand
  .command('get')
  .description('Get the redacted deployment configuration')
  .option('--format <format>', 'output format (json)', 'json')
  .action(async (options: { format: string }) => {
    requireJsonFormat(options.format)
    console.log(JSON.stringify(await tenantAdminClient().get(), null, 2))
  })

configCommand
  .command('apply')
  .description('Apply a JSON deployment configuration document')
  .requiredOption('--file <json|->', 'JSON file, or - to read stdin')
  .option('--format <format>', 'output format (json)', 'json')
  .action(async (options: { file: string; format: string }) => {
    requireJsonFormat(options.format)
    const input = await readDeploymentConfigPut(options.file)
    console.log(JSON.stringify(await applyDeploymentConfig(tenantAdminClient(), input), null, 2))
  })

const create = program.command('create').description('Create a deployment-owned provider App once')

create
  .command('github')
  .description('Create a GitHub App through the official manifest flow')
  .option('--name <name>', 'GitHub App name', 'AgentConnect')
  .option('--github-org <login>', 'create the App under this GitHub organization')
  .option('--env-file <path>', 'legacy: write credentials to a runtime environment file')
  .option('--format <format>', 'table or json', 'table')
  .action(async (options: { name: string; githubOrg?: string; envFile?: string; format: string }) => {
    const format = parseOutputFormat(options.format)
    let config: ProviderAppConfig

    let current: DeploymentConfigAdmin | undefined
    let adminClient: TenantAdminClient | undefined
    if (options.envFile) {
      const legacyConfig = await loadSetupConfig(program.opts().config)
      requireExternalRelay(legacyConfig)
      config = legacyConfig
      const configuredPath = await providerConfigurationPath('GitHub', options.envFile, GITHUB_DEPLOYMENT_ENV_KEYS)
      if (configuredPath) {
        const values = await readEnvFileValues(options.envFile, ['GITHUB_APP_ID', 'GITHUB_APP_SLUG'])
        const appId = values.GITHUB_APP_ID ?? 'configured'
        const slug = values.GITHUB_APP_SLUG
        const settingsUrl = slug
          ? options.githubOrg
            ? `https://github.com/organizations/${options.githubOrg}/settings/apps/${slug}`
            : `https://github.com/settings/apps/${slug}`
          : 'https://github.com/settings/apps'
        printCreateResult(
          {
            schemaVersion: '1',
            operation: 'create.github',
            status: 'already-configured',
            changed: false,
            sink: 'env-file',
            app: { id: appId, ...(slug ? { slug } : {}) },
            revision: null,
            restartRequired: false,
            settingsUrl,
            environmentFile: configuredPath
          },
          format,
          [`GitHub App is already configured in ${configuredPath}; nothing changed.`]
        )
        return
      }
    } else {
      adminClient = tenantAdminClient()
      current = await adminClient.get()
      if (current.values.github) {
        const github = current.values.github
        const settingsUrl = options.githubOrg
          ? `https://github.com/organizations/${options.githubOrg}/settings/apps/${github.slug}`
          : `https://github.com/settings/apps/${github.slug}`
        printCreateResult(
          {
            schemaVersion: '1',
            operation: 'create.github',
            status: 'already-configured',
            changed: false,
            sink: 'deployment-config',
            app: { id: String(github.appId), slug: github.slug },
            revision: current.revision,
            restartRequired: false,
            settingsUrl
          },
          format,
          [`GitHub App ${github.slug} is already configured in deployment config revision ${current.revision}.`]
        )
        return
      }
      config = providerConfigFromDeployment(current)
    }

    const flow = await startGithubManifestFlow(config, options.name, options.githubOrg)
    const browserPrompt = `Open this local URL in a browser to review and create the GitHub App:\n  ${flow.startUrl}`
    // Keep stdout as one parseable JSON document in machine mode.
    if (format === 'json') console.error(browserPrompt)
    else console.log(browserPrompt)

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
    const settingsUrl = options.githubOrg
      ? `https://github.com/organizations/${options.githubOrg}/settings/apps/${credentials.slug}`
      : `https://github.com/settings/apps/${credentials.slug}`

    if (options.envFile) {
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
      printCreateResult(
        {
          schemaVersion: '1',
          operation: 'create.github',
          status: 'created',
          changed: true,
          sink: 'env-file',
          app: { id: credentials.appId, slug: credentials.slug },
          revision: null,
          restartRequired: true,
          settingsUrl,
          environmentFile: envPath
        },
        format,
        [
          `Created GitHub App ${credentials.slug} (${credentials.appId}).`,
          `Saved ${GITHUB_DEPLOYMENT_ENV_KEYS.join(', ')} to ${envPath}.`,
          `Settings: ${settingsUrl}`,
          'Next: restart the Control Plane, Relay, and Web, then connect GitHub from the AgentConnect console.'
        ]
      )
      return
    }

    let updated: DeploymentConfigAdmin
    try {
      // The browser flow can stay open for minutes. Merge onto a fresh read so
      // unrelated admin edits made meanwhile are not replaced by the old GET.
      const latest = await adminClient!.get()
      if (latest.values.github) {
        throw new Error('another GitHub App was configured while this App was being created')
      }
      if (!sameProviderEndpoints(config, providerConfigFromDeployment(latest))) {
        throw new Error('deployment public URLs changed while the GitHub App was being created')
      }
      updated = await adminClient!.put(githubDeploymentPut(latest, credentials), latest.revision)
    } catch {
      throw new Error(
        `GitHub App ${credentials.slug} was created, but its credentials could not be saved to tenant-admin; delete the App before retrying`
      )
    }
    printCreateResult(
      {
        schemaVersion: '1',
        operation: 'create.github',
        status: 'created',
        changed: true,
        sink: 'deployment-config',
        app: { id: credentials.appId, slug: credentials.slug },
        revision: updated.revision,
        restartRequired: updated.restartRequired ?? true,
        settingsUrl
      },
      format,
      [
        `Created GitHub App ${credentials.slug} (${credentials.appId}).`,
        `Saved its write-only credentials to deployment config revision ${updated.revision}.`,
        `Settings: ${settingsUrl}`,
        'Next: restart the Control Plane, Relay, and Web, then connect GitHub from the AgentConnect console.'
      ]
    )
  })

create
  .command('slack')
  .description('Create a deployment Slack App with the App Manifest API')
  .option('--name <name>', 'Slack App name', 'AgentConnect')
  .option('--env-file <path>', 'legacy: write credentials to a runtime environment file')
  .option('--format <format>', 'table or json', 'table')
  .action(async (options: { name: string; envFile?: string; format: string }) => {
    const format = parseOutputFormat(options.format)
    let config: ProviderAppConfig
    let manifest: Record<string, unknown>
    const configToken = process.env[SLACK_CONFIG_TOKEN_ENV]?.trim()

    let current: DeploymentConfigAdmin | undefined
    let adminClient: TenantAdminClient | undefined
    if (options.envFile) {
      const legacyConfig = await loadSetupConfig(program.opts().config)
      requireExternalRelay(legacyConfig)
      config = legacyConfig
      manifest = buildSlackDeploymentManifest(config, options.name)
      const configuredPath = await providerConfigurationPath('Slack', options.envFile, SLACK_DEPLOYMENT_ENV_KEYS)
      if (configuredPath) {
        const values = await readEnvFileValues(options.envFile, ['SLACK_PLATFORM_APP_ID'])
        const appId = values.SLACK_PLATFORM_APP_ID
        if (!appId) throw new Error(`${configuredPath} does not contain a usable SLACK_PLATFORM_APP_ID`)
        let verified = false
        if (configToken) {
          try {
            await verifySlackApp(configToken, appId, manifest)
            verified = true
          } catch (error) {
            throw new Error(
              `Slack App ${appId} is configured, but manifest verification failed: ${(error as Error).message}`
            )
          }
        }
        printCreateResult(
          {
            schemaVersion: '1',
            operation: 'create.slack',
            status: 'already-configured',
            changed: false,
            sink: 'env-file',
            app: { id: appId },
            verified,
            revision: null,
            restartRequired: false,
            settingsUrl: `https://api.slack.com/apps/${appId}`,
            environmentFile: configuredPath
          },
          format,
          verified
            ? [`Slack App ${appId} is already configured and its manifest was verified; nothing changed.`]
            : [
                `Slack App is already configured in ${configuredPath}; no provider call was made.`,
                `Set ${SLACK_CONFIG_TOKEN_ENV} and rerun to verify its manifest without creating another App.`
              ]
        )
        return
      }
    } else {
      adminClient = tenantAdminClient()
      current = await adminClient.get()
      config = providerConfigFromDeployment(current)
      manifest = buildSlackDeploymentManifest(config, options.name)
      if (current.values.slack) {
        const appId = current.values.slack.appId
        let verified = false
        if (configToken) {
          try {
            await verifySlackApp(configToken, appId, manifest)
            verified = true
          } catch (error) {
            throw new Error(
              `Slack App ${appId} is configured, but manifest verification failed: ${(error as Error).message}`
            )
          }
        }
        printCreateResult(
          {
            schemaVersion: '1',
            operation: 'create.slack',
            status: 'already-configured',
            changed: false,
            sink: 'deployment-config',
            app: { id: appId },
            verified,
            revision: current.revision,
            restartRequired: false,
            settingsUrl: `https://api.slack.com/apps/${appId}`
          },
          format,
          verified
            ? [
                `Slack App ${appId} is already configured in deployment config revision ${current.revision} and its manifest was verified.`
              ]
            : [
                `Slack App ${appId} is already configured in deployment config revision ${current.revision}; no provider call was made.`,
                `Set ${SLACK_CONFIG_TOKEN_ENV} and rerun to verify its manifest without creating another App.`
              ]
        )
        return
      }
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
    let envPath: string | undefined
    let updated: DeploymentConfigAdmin | undefined
    if (options.envFile) {
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
    } else {
      try {
        const latest = await adminClient!.get()
        if (latest.values.slack) {
          throw new Error('another Slack App was configured while this App was being created')
        }
        if (!sameProviderEndpoints(config, providerConfigFromDeployment(latest))) {
          throw new Error('deployment public URLs changed while the Slack App was being created')
        }
        updated = await adminClient!.put(slackDeploymentPut(latest, credentials), latest.revision)
      } catch {
        throw new Error(
          `Slack App ${credentials.appId} was created, but its credentials could not be saved to tenant-admin; delete the App before retrying`
        )
      }
    }

    try {
      await verifySlackApp(configToken, credentials.appId, manifest)
    } catch (error) {
      const savedTo = envPath ? envPath : `deployment config revision ${updated!.revision}`
      throw new Error(
        `Slack App ${credentials.appId} was created and its credentials were saved to ${savedTo}, but manifest verification failed: ${(error as Error).message}. Rerun with ${SLACK_CONFIG_TOKEN_ENV} to retry verification without creating another App`
      )
    }

    const sink = envPath ? 'env-file' : 'deployment-config'
    const revision = updated?.revision ?? null
    printCreateResult(
      {
        schemaVersion: '1',
        operation: 'create.slack',
        status: 'created',
        changed: true,
        sink,
        app: { id: credentials.appId },
        verified: true,
        revision,
        restartRequired: updated?.restartRequired ?? true,
        settingsUrl: `https://api.slack.com/apps/${credentials.appId}`,
        ...(envPath ? { environmentFile: envPath } : {})
      },
      format,
      [
        `Created and verified Slack App ${credentials.appId}.`,
        envPath
          ? `Saved ${SLACK_DEPLOYMENT_ENV_KEYS.join(', ')} to ${envPath}.`
          : `Saved its write-only credentials to deployment config revision ${revision}.`,
        `Settings: https://api.slack.com/apps/${credentials.appId}`,
        'Before installing it in other workspaces, activate Public Distribution in Slack App settings.',
        'Next: restart the Control Plane, Relay, and Web, then install Slack from the AgentConnect console.'
      ]
    )
  })

program
  .command('check [scope]')
  .description('Check deployment or Logto readiness without changing it')
  .option('--format <format>', 'table or json', 'table')
  .action(async (scope: string = 'deployment', options: { format: string }) => {
    const format = parseOutputFormat(options.format)
    if (scope === 'logto') {
      const result = await tenantAdminClient().checkLogto()
      console.log(
        format === 'json'
          ? JSON.stringify(result, null, 2)
          : result.findings
              .map((finding) => `${finding.status.toUpperCase().padEnd(7)} ${finding.id.padEnd(29)} ${finding.message}`)
              .join('\n')
      )
      process.exitCode = reportExitCode(result.findings)
      return
    }
    if (scope !== 'deployment') {
      throw new Error(`unknown check scope '${scope}' (use deployment or logto)`)
    }
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
