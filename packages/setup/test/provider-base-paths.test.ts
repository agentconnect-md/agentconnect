import { describe, expect, it } from 'vitest'
import { loadDeploymentEnvironment } from '../src/deployment-environment.js'
import { buildGithubAppManifest, githubConfiguredUrls } from '../src/github-app.js'
import { gitlabConfiguredUrls } from '../src/gitlab-app.js'
import { linearConfiguredUrls } from '../src/linear-app.js'
import { buildSlackDeploymentManifest, slackConfiguredUrls } from '../src/slack-app.js'

const PREFIXED_ENVIRONMENT = {
  AGENTCONNECT_PUBLIC_WEB_URL: 'https://gateway.example.test',
  AGENTCONNECT_PUBLIC_CP_URL: 'https://gateway.example.test/cp///',
  AGENTCONNECT_PUBLIC_RELAY_URL: 'https://gateway.example.test/relay/',
  OIDC_ISSUER: 'https://identity.example.test/oidc',
  LOGTO_MGMT_ENDPOINT: 'http://logto:3001'
} as const

describe('provider service base paths', () => {
  it('preserves and normalizes Control Plane and Relay path prefixes', () => {
    expect(loadDeploymentEnvironment(PREFIXED_ENVIRONMENT).services).toEqual({
      web: 'https://gateway.example.test',
      controlPlane: 'https://gateway.example.test/cp',
      relay: 'https://gateway.example.test/relay'
    })
  })

  it('keeps credentials, query, and fragment out of service base URLs', () => {
    for (const controlPlane of [
      'https://user:password@gateway.example.test/cp',
      'https://gateway.example.test/cp?debug=true',
      'https://gateway.example.test/cp#fragment'
    ]) {
      expect(() =>
        loadDeploymentEnvironment({
          ...PREFIXED_ENVIRONMENT,
          AGENTCONNECT_PUBLIC_CP_URL: controlPlane
        })
      ).toThrow(/credentials, query, or fragment/)
    }

    expect(() =>
      loadDeploymentEnvironment({
        ...PREFIXED_ENVIRONMENT,
        AGENTCONNECT_PUBLIC_CP_URL: 'http://gateway.example.test/cp'
      })
    ).toThrow(/HTTPS/)
    expect(() =>
      loadDeploymentEnvironment({
        ...PREFIXED_ENVIRONMENT,
        AGENTCONNECT_PUBLIC_WEB_URL: 'https://gateway.example.test/console'
      })
    ).toThrow(/origin/)
  })

  it('generates Slack and GitHub provider URLs beneath the configured prefixes', () => {
    const config = { services: loadDeploymentEnvironment(PREFIXED_ENVIRONMENT).services }

    const slackUrls = slackConfiguredUrls(buildSlackDeploymentManifest(config, 'AgentConnect'))
    expect(slackUrls).toMatchObject({
      oauthRedirectUrl: 'https://gateway.example.test/cp/v1/integrations/slack/platform/callback',
      eventsUrl: 'https://gateway.example.test/relay/slack/events',
      interactionsUrl: 'https://gateway.example.test/relay/slack/interactions'
    })

    const githubManifest = buildGithubAppManifest(
      config,
      'AgentConnect',
      'https://setup.example.test/api/v1/create/github/callback'
    )
    expect(githubManifest).toMatchObject({
      setup_url: 'https://gateway.example.test/cp/v1/github/setup/callback',
      hook_attributes: {
        url: 'https://gateway.example.test/relay/webhooks/github',
        active: true
      }
    })
    expect(githubConfiguredUrls(config, githubManifest)).toMatchObject({
      setupUrl: 'https://gateway.example.test/cp/v1/github/setup/callback',
      webhookUrl: 'https://gateway.example.test/relay/webhooks/github',
      webhookActive: true
    })
  })

  it('publishes the GitLab redirect URI beneath the Control Plane prefix with the requested scopes', () => {
    const config = { services: loadDeploymentEnvironment(PREFIXED_ENVIRONMENT).services }

    expect(gitlabConfiguredUrls(config)).toEqual({
      callbackUrl: 'https://gateway.example.test/cp/v1/gitlab/oauth/callback',
      scopes: ['api'],
      instanceUrl: 'https://gitlab.com',
      applicationsUrl: 'https://gitlab.com/-/user_settings/applications',
      adminApplicationsUrl: 'https://gitlab.com/admin/applications'
    })
    expect(() => gitlabConfiguredUrls({ services: { controlPlane: 'http://localhost:8080' } })).toThrow(/HTTPS/)
  })

  it('publishes the Linear callback and webhook URLs beneath their service prefixes', () => {
    const config = { services: loadDeploymentEnvironment(PREFIXED_ENVIRONMENT).services }

    expect(linearConfiguredUrls(config)).toEqual({
      callbackUrl: 'https://gateway.example.test/cp/v1/integrations/linear/oauth/callback',
      webhookUrl: 'https://gateway.example.test/relay/linear/events',
      applicationsUrl: 'https://linear.app/settings/api/applications'
    })
  })

  it('withholds the Linear endpoints until both services are reachable over HTTPS', () => {
    const relay = 'https://gateway.example.test/relay'
    expect(() => linearConfiguredUrls({ services: { controlPlane: 'http://localhost:8080', relay } })).toThrow(
      /Control Plane/
    )
    expect(() => linearConfiguredUrls({ services: { controlPlane: 'https://gateway.example.test/cp' } })).toThrow(
      /ingress/
    )
  })

  it('targets the application links at a self-managed instance, prefix and port intact (§24.1)', () => {
    const config = { services: loadDeploymentEnvironment(PREFIXED_ENVIRONMENT).services }

    // Concatenation, never resolution: resolving an absolute path against this
    // base would drop `/gitlab` and send the operator to the wrong page.
    expect(gitlabConfiguredUrls(config, 'https://gitlab.example.test:8443/gitlab')).toMatchObject({
      instanceUrl: 'https://gitlab.example.test:8443/gitlab',
      applicationsUrl: 'https://gitlab.example.test:8443/gitlab/-/user_settings/applications',
      adminApplicationsUrl: 'https://gitlab.example.test:8443/gitlab/admin/applications'
    })
    // The redirect URI is the Control Plane's own, unchanged by the instance.
    expect(gitlabConfiguredUrls(config, 'https://gitlab.example.test/gitlab').callbackUrl).toBe(
      'https://gateway.example.test/cp/v1/gitlab/oauth/callback'
    )
  })
})
