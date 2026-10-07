// The setup-only relay assignment for a Slack workspace that has not chosen an organization.
import { RcBotAssign } from '@agentconnect.md/protocol'
import type { SlackWorkspaceInstallRecord, SlackWorkspaceInstallStore } from '../../persistence/ports.js'
import type { SlackPlatformAppConfig } from '../../config/slack-platform.js'
import type { CpPlatformProvider } from '../provider.js'

export function slackWorkspaceIngress(
  installs: SlackWorkspaceInstallStore,
  platform: SlackPlatformAppConfig | undefined,
  webAppUrl: string | undefined
): CpPlatformProvider['unclaimedIngress'] {
  if (!platform || !webAppUrl?.startsWith('https://')) return undefined
  const assignment = (row: SlackWorkspaceInstallRecord) =>
    RcBotAssign.parse({
      botId: row.id,
      platform: 'slack',
      installedAgentIds: [],
      credentialRevision: row.credentialRevision,
      secrets: { botToken: row.botToken, signingSecret: platform.signingSecret },
      ingress: {
        apiAppId: row.appId,
        teamId: row.teamId,
        workspaceId: row.teamId,
        botUserId: row.botUserId,
        claimUrl: `${webAppUrl.replace(/\/+$/, '')}/slack/connect?installation=${encodeURIComponent(row.id)}`
      },
      members: [],
      agents: [],
      routes: []
    })
  return {
    async get(id) {
      const row = await installs.get(id)
      return row?.appId === platform.appId ? assignment(row) : null
    },
    async list() {
      return (await installs.list()).filter((row) => row.appId === platform.appId).map(assignment)
    },
    revoke: (id, fence) => installs.revoke(id, fence)
  }
}
