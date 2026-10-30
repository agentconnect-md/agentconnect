// Provider metadata shared by membership discovery and message ingress.
export function slackCodeChannelInfo(channel: { properties?: unknown } | undefined): {
  code: boolean
  owners: string[]
} {
  const properties = channel?.properties as
    | {
        record_channel?: { record_type?: string }
        agent_session?: { encoded_agent_bot_user_ids?: string[] }
      }
    | undefined
  return {
    code: properties?.record_channel?.record_type === 'agent_channel',
    owners: properties?.agent_session?.encoded_agent_bot_user_ids ?? []
  }
}
