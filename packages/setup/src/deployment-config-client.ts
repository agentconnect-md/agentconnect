/** Typed deployment mutations used by the Setup Server provider workflows. */
import {
  DeploymentConfigValuesV1Schema,
  DeploymentSecretPatchSchema,
  type DeploymentConfigValuesV1
} from '@agentconnect.md/control-plane/deployment-config-store'
import { z } from 'zod'

export const DeploymentConfigPutSchema = z.strictObject({
  values: DeploymentConfigValuesV1Schema,
  secrets: DeploymentSecretPatchSchema.optional()
})
export type DeploymentConfigPut = z.infer<typeof DeploymentConfigPutSchema>

export interface GithubDeploymentCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
  privateKeyBase64: string
  webhookSecret?: string
}

type CurrentDeploymentConfig = { values: DeploymentConfigValuesV1 }

export function githubDeploymentPut(
  current: CurrentDeploymentConfig,
  credentials: GithubDeploymentCredentials,
  options: { webhookEnabled?: boolean; connectLogto?: boolean } = {}
): DeploymentConfigPut {
  const appId = Number(credentials.appId)
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App creation returned an invalid app id')
  const connectLogto = options.connectLogto && current.values.logto
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      github: {
        appId,
        slug: credentials.slug,
        clientId: credentials.clientId,
        webhookEnabled: options.webhookEnabled ?? true
      },
      ...(connectLogto
        ? {
            logto: {
              ...connectLogto,
              browser: connectLogto.browser
                ? {
                    ...connectLogto.browser,
                    socialProviders: [...new Set([...connectLogto.browser.socialProviders, 'github'])]
                  }
                : connectLogto.browser,
              githubConnector: {
                appId,
                slug: credentials.slug,
                clientId: credentials.clientId
              }
            }
          }
        : {})
    },
    secrets: {
      'github.privateKeyB64': credentials.privateKeyBase64,
      ...(credentials.webhookSecret ? { 'github.webhookSecret': credentials.webhookSecret } : {}),
      'github.clientSecret': credentials.clientSecret,
      ...(connectLogto ? { 'logto.githubConnectorClientSecret': credentials.clientSecret } : {})
    }
  })
}

export interface GitlabDeploymentCredentials {
  clientId: string
  /** Omitted keeps the sealed secret; GitLab shows it only once at registration. */
  clientSecret?: string
  /** The instance base URL (§24.1); null or omitted means GitLab.com. */
  baseUrl?: string | null
}

/** Null clears the application. GitLab OAuth applications are registered by hand (§18.3). */
export function gitlabDeploymentPut(
  current: CurrentDeploymentConfig,
  application: GitlabDeploymentCredentials | null
): DeploymentConfigPut {
  // A different instance is a different application, so its secret is required
  // whenever either half of the identity moves (§24.1).
  const baseUrl = application?.baseUrl ?? null
  const identityChanged =
    application !== null &&
    (current.values.gitlab?.clientId !== application.clientId || (current.values.gitlab?.baseUrl ?? null) !== baseUrl)
  if (application && !application.clientSecret && identityChanged) {
    throw new Error('the GitLab OAuth application secret is required for a new application id or instance')
  }
  const secret = application ? application.clientSecret : null
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      gitlab: application ? { clientId: application.clientId, baseUrl } : null
    },
    ...(secret === undefined ? {} : { secrets: { 'gitlab.clientSecret': secret } })
  })
}

export interface LogtoGithubConnectorCredentials {
  appId: string
  slug: string
  clientId: string
  clientSecret: string
}

export interface LocalAuthLogtoBootstrap {
  managementAppId?: string
  managementAppSecret?: string
  managementResource?: string
  socialProvider?: 'github' | 'google' | 'slack'
}

/** Fill the local Logto defaults without replacing existing provider state. */
export function localAuthLogtoPut(
  current: CurrentDeploymentConfig,
  bootstrap: LocalAuthLogtoBootstrap
): DeploymentConfigPut {
  const existing = current.values.logto
  const managementAppId = bootstrap.managementAppId ?? existing?.managementAppId
  if (!managementAppId) throw new Error('Logto Management API application id is required')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        managementAppId,
        managementResource:
          bootstrap.managementResource ?? existing?.managementResource ?? 'https://default.logto.app/api',
        browser:
          existing?.browser ??
          ({
            applicationName: 'AgentConnect',
            apiResource: null,
            socialProviders: bootstrap.socialProvider ? [bootstrap.socialProvider] : []
          } as const),
        githubConnector: existing?.githubConnector ?? null,
        ...(existing?.googleConnector ? { googleConnector: existing.googleConnector } : {}),
        ...(existing?.slackConnector ? { slackConnector: existing.slackConnector } : {})
      }
    },
    ...(bootstrap.managementAppSecret
      ? { secrets: { 'logto.managementAppSecret': bootstrap.managementAppSecret } }
      : {})
  })
}

export function logtoGithubConnectorPut(
  current: CurrentDeploymentConfig,
  credentials: LogtoGithubConnectorCredentials
): DeploymentConfigPut {
  if (!current.values.logto) throw new Error('save Logto configuration before creating its GitHub connector App')
  const appId = Number(credentials.appId)
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error('GitHub App creation returned an invalid app id')
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        ...current.values.logto,
        browser: current.values.logto.browser
          ? {
              ...current.values.logto.browser,
              socialProviders: [...new Set([...current.values.logto.browser.socialProviders, 'github'])]
            }
          : current.values.logto.browser,
        githubConnector: {
          appId,
          slug: credentials.slug,
          clientId: credentials.clientId
        }
      }
    },
    secrets: { 'logto.githubConnectorClientSecret': credentials.clientSecret }
  })
}

export interface SlackDeploymentCredentials {
  appId: string
  clientId: string
  clientSecret: string
  signingSecret: string
}

export function slackDeploymentPut(
  current: CurrentDeploymentConfig,
  credentials: SlackDeploymentCredentials,
  connectLogto = false
): DeploymentConfigPut {
  const logto = connectLogto && current.values.logto
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      slack: {
        appId: credentials.appId,
        clientId: credentials.clientId
      },
      ...(logto
        ? {
            logto: {
              ...logto,
              browser: logto.browser
                ? {
                    ...logto.browser,
                    socialProviders: [...new Set([...logto.browser.socialProviders, 'slack'])]
                  }
                : logto.browser,
              slackConnector: {
                appId: credentials.appId,
                clientId: credentials.clientId
              }
            }
          }
        : {})
    },
    secrets: {
      'slack.clientSecret': credentials.clientSecret,
      'slack.signingSecret': credentials.signingSecret
    }
  })
}

export interface LinearDeploymentCredentials {
  clientId: string
  /** Omitted keeps the sealed secret; Linear shows each value only once. */
  clientSecret?: string
  signingSecret?: string
}

/** Null clears the application. Linear OAuth applications are registered by hand (§7.1). */
export function linearDeploymentPut(
  current: CurrentDeploymentConfig,
  application: LinearDeploymentCredentials | null
): DeploymentConfigPut {
  // A different client id is a different application, so both of its write-only
  // secrets must arrive with it — the store would otherwise keep the old app's.
  const identityChanged = application !== null && current.values.linear?.clientId !== application.clientId
  if (application && identityChanged && !(application.clientSecret && application.signingSecret)) {
    throw new Error('a new Linear application id requires both its client secret and its webhook signing secret')
  }
  const secrets = application
    ? {
        ...(application.clientSecret ? { 'linear.clientSecret': application.clientSecret } : {}),
        ...(application.signingSecret ? { 'linear.signingSecret': application.signingSecret } : {})
      }
    : { 'linear.clientSecret': null, 'linear.signingSecret': null }
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      linear: application ? { clientId: application.clientId } : null
    },
    ...(Object.keys(secrets).length > 0 ? { secrets } : {})
  })
}

export interface LogtoGoogleConnectorCredentials {
  clientId: string
  clientSecret?: string
}

export function logtoGoogleConnectorPut(
  current: CurrentDeploymentConfig,
  credentials: LogtoGoogleConnectorCredentials
): DeploymentConfigPut {
  if (!current.values.logto) throw new Error('save Logto configuration before configuring its Google connector')
  if (!credentials.clientSecret && current.values.logto.googleConnector?.clientId !== credentials.clientId) {
    throw new Error('Google OAuth client secret is required for a new client id')
  }
  return DeploymentConfigPutSchema.parse({
    values: {
      ...current.values,
      logto: {
        ...current.values.logto,
        browser: current.values.logto.browser
          ? {
              ...current.values.logto.browser,
              socialProviders: [...new Set([...current.values.logto.browser.socialProviders, 'google'])]
            }
          : current.values.logto.browser,
        googleConnector: {
          clientId: credentials.clientId
        }
      }
    },
    ...(credentials.clientSecret ? { secrets: { 'logto.googleConnectorClientSecret': credentials.clientSecret } } : {})
  })
}
