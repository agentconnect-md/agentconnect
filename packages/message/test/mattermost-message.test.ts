import { describe, expect, it } from 'vitest'
import { NormalizedPlatformMessageSchema, type NormalizedPlatformMessage } from '@agentconnect.md/protocol'
import { commandText } from '../src/command-text.js'
import {
  MATTERMOST_RESPONSE_FINAL_EVENT_TAG,
  extractMattermostAttachmentsText,
  extractMattermostUsernameMentions,
  mattermostMentionsBot,
  mattermostTextAddressesAnyone,
  normalizeMattermostMessage,
  normalizeMattermostResponseFinalization,
  parseMattermostMentions,
  readMattermostAgentAuthorshipClaim,
  toMattermostAttachment,
  type MattermostNormalizeContext,
  type MattermostPostedEvent
} from '../src/mattermost-message.js'
import {
  ALICE_USER_ID,
  BOB_USER_ID,
  BOT_POST_ID,
  BOT_USER_ID,
  BOT_USERNAME,
  DM_CHANNEL_ID,
  DM_POST_ID,
  FILE_POST_ID,
  GROUP_DM_CHANNEL_ID,
  GROUP_DM_POST_ID,
  IMAGE_FILE_ID,
  OTHER_BOT_USER_ID,
  PDF_FILE_ID,
  PRIVATE_CHANNEL_ID,
  PUBLIC_CHANNEL_ID,
  REPLY_POST_ID,
  RICH_POST_ID,
  ROOT_POST_ID,
  SERVER_URL,
  agentBotFinalEdit,
  directMessage,
  groupDmMentionFallback,
  postWithFiles,
  postWithRichAttachments,
  privateChannelReply,
  publicChannelMention
} from './fixtures/mattermost-messages.js'

const normalize = (event: MattermostPostedEvent, context: Partial<MattermostNormalizeContext> = {}) =>
  normalizeMattermostMessage(event, {
    botUserId: BOT_USER_ID,
    botUsername: BOT_USERNAME,
    serverUrl: SERVER_URL,
    traceId: 'trace-1',
    ...context
  })

function messageOf(
  event: MattermostPostedEvent,
  context?: Partial<MattermostNormalizeContext>
): NormalizedPlatformMessage {
  const msg = normalize(event, context)
  if (!msg) throw new Error('expected normalized Mattermost message')
  expect(NormalizedPlatformMessageSchema.parse(msg)).toEqual(msg)
  return msg
}

describe('Mattermost normalization', () => {
  it('normalizes a JSON-encoded public channel posted event with root_id || id threading', () => {
    const msg = messageOf(publicChannelMention)
    expect(msg).toEqual({
      msgId: `mattermost:${PUBLIC_CHANNEL_ID}:${ROOT_POST_ID}`,
      traceId: 'trace-1',
      source: 'user',
      platform: 'mattermost',
      channel: PUBLIC_CHANNEL_ID,
      thread: ROOT_POST_ID,
      sender: { id: ALICE_USER_ID, isBot: false, name: 'alice' },
      text: `@${BOT_USERNAME} please summarize the incident`,
      mentionedBots: [BOT_USER_ID],
      mentionedUsers: [BOT_USER_ID],
      leadingMentions: [{ id: BOT_USER_ID, text: `@${BOT_USERNAME}` }],
      isDm: false,
      platformTimeMs: 1767225600123
    })
  })

  it('keeps root_id as thread and replyThread for a private channel reply', () => {
    const msg = messageOf(privateChannelReply)
    expect(msg).toMatchObject({
      msgId: `mattermost:${PRIVATE_CHANNEL_ID}:${REPLY_POST_ID}`,
      channel: PRIVATE_CHANNEL_ID,
      thread: ROOT_POST_ID,
      replyThread: ROOT_POST_ID,
      isDm: false,
      sender: { id: BOB_USER_ID, isBot: false, name: 'bob' }
    })
    expect(msg.isGroupDm).toBeUndefined()
    expect(msg.mentionedBots).toEqual([])
  })

  it('normalizes DMs with isDm=true and Group DMs with isGroupDm=true and isDm=false', () => {
    const dm = messageOf(directMessage)
    expect(dm.channel).toBe(DM_CHANNEL_ID)
    expect(dm.thread).toBe(DM_POST_ID)
    expect(dm.isDm).toBe(true)
    expect(dm.isGroupDm).toBeUndefined()

    const gm = messageOf(groupDmMentionFallback)
    expect(gm.channel).toBe(GROUP_DM_CHANNEL_ID)
    expect(gm.thread).toBe(GROUP_DM_POST_ID)
    expect(gm.isDm).toBe(false)
    expect(gm.isGroupDm).toBe(true)
    expect(gm.mentionedBots).toEqual([BOT_USER_ID])
  })

  it('does not treat a broadcast mention as addressing the bot, though the server lists it as mentioned', () => {
    const withText = (message: string): MattermostPostedEvent => ({
      event: 'posted',
      data: {
        channel_type: 'O',
        sender_name: '@alice',
        mentions: JSON.stringify([BOT_USER_ID, BOB_USER_ID]),
        post: JSON.stringify({
          id: ROOT_POST_ID,
          create_at: 1767225600123,
          user_id: ALICE_USER_ID,
          channel_id: PUBLIC_CHANNEL_ID,
          root_id: '',
          message,
          type: '',
          props: {}
        })
      }
    })
    for (const text of ['@channel lunch is here', 'heads up @all', '@here: standup']) {
      expect(messageOf(withText(text)).mentionedBots, text).toEqual([BOB_USER_ID])
    }
    // Naming the bot beside the broadcast, or a handle that merely starts like one, still addresses it.
    for (const text of [
      `@channel and @${BOT_USERNAME} please look`,
      '@channelops can you check',
      'plain mention list'
    ]) {
      expect(messageOf(withText(text)).mentionedBots, text).toContain(BOT_USER_ID)
    }
  })

  it('matches @botUsername fallback strictly on username boundaries and strips leading mentions for commands', () => {
    expect(mattermostMentionsBot('ping @acbot.', 'acbot')).toBe(true)
    expect(mattermostMentionsBot('ping @AcBot, help', 'acbot')).toBe(true)
    expect(mattermostMentionsBot('(@acbot)', 'acbot')).toBe(true)
    expect(mattermostMentionsBot('mail user@acbot.com', 'acbot')).toBe(false)
    expect(mattermostMentionsBot('ping @acbot2', 'acbot')).toBe(false)
    expect(mattermostMentionsBot('ping @acbot.smith', 'acbot')).toBe(false)
    expect(mattermostMentionsBot('See [details](@acbot) or `ping @acbot`', 'acbot')).toBe(false)
    expect(mattermostMentionsBot('See ``code with ` and @acbot`` or ``multi\nline @acbot``', 'acbot')).toBe(false)
    expect(mattermostMentionsBot('See [details](\n@acbot) or [nested](https://a.test/(x)\n@acbot)', 'acbot')).toBe(
      false
    )
    expect(mattermostMentionsBot('```\n@acbot help\n```', 'acbot')).toBe(false)
    expect(mattermostMentionsBot('````\n```\n@acbot help\n````', 'acbot')).toBe(false)
    // Unclosed fences/links must not swallow mentions in subsequent paragraphs.
    expect(mattermostMentionsBot('[broken](https://a.test/\n\n@acbot hi', 'acbot')).toBe(true)
    expect(mattermostMentionsBot('``unclosed\n\n@acbot hi', 'acbot')).toBe(true)
    expect(extractMattermostUsernameMentions('[click](@alice) `@bob` @Carol, please review @channel')).toEqual([
      'carol'
    ])
    expect(mattermostTextAddressesAnyone('[click](@alice) `@bob`')).toBe(false)
    expect(mattermostTextAddressesAnyone('FYI @channel')).toBe(true)
    expect(messageOf(publicChannelMention, { appId: 'mm-1234567890abcdef' }).sender.appId).toBe('mm-1234567890abcdef')

    // REST backfill: prefer verified context.senderName over spoofable props.override_username for human posts,
    // while still honoring override_username on incoming webhook posts.
    const spoofedHuman = messageOf(
      {
        event: 'posted',
        data: {
          channel_type: 'O',
          post: {
            id: ROOT_POST_ID,
            user_id: ALICE_USER_ID,
            channel_id: PUBLIC_CHANNEL_ID,
            message: 'hello',
            props: { override_username: 'admin-spoof' }
          }
        }
      },
      { senderName: 'alice' }
    )
    expect(spoofedHuman.sender).toEqual({ id: ALICE_USER_ID, isBot: false, name: 'alice' })

    const spoofedHumanNoContext = messageOf({
      event: 'posted',
      data: {
        channel_type: 'O',
        post: {
          id: ROOT_POST_ID,
          user_id: ALICE_USER_ID,
          channel_id: PUBLIC_CHANNEL_ID,
          message: 'hello',
          props: { override_username: 'admin-spoof' }
        }
      }
    })
    expect(spoofedHumanNoContext.sender).toEqual({ id: ALICE_USER_ID, isBot: false })

    const webhookBackfill = messageOf(
      {
        event: 'posted',
        data: {
          channel_type: 'O',
          post: {
            id: ROOT_POST_ID,
            user_id: ALICE_USER_ID,
            channel_id: PUBLIC_CHANNEL_ID,
            message: 'deploy complete',
            props: { from_webhook: 'true', override_username: 'DeployHook' }
          }
        }
      },
      { senderName: 'hook-owner' }
    )
    expect(webhookBackfill.sender).toEqual({ id: ALICE_USER_ID, isBot: true, name: 'DeployHook' })

    const cmdMsg = messageOf({
      event: 'posted',
      data: {
        channel_type: 'O',
        post: {
          id: ROOT_POST_ID,
          user_id: ALICE_USER_ID,
          channel_id: PUBLIC_CHANNEL_ID,
          message: '@AcBot !stop'
        }
      }
    })
    expect(cmdMsg.leadingMentions).toEqual([{ id: BOT_USER_ID, text: '@AcBot' }])
    expect(commandText(cmdMsg, [BOT_USER_ID]).trim()).toBe('!stop')

    const otherUserCmd = messageOf({
      event: 'posted',
      data: {
        channel_type: 'O',
        post: {
          id: ROOT_POST_ID,
          user_id: ALICE_USER_ID,
          channel_id: PUBLIC_CHANNEL_ID,
          message: '@alice !stop'
        }
      }
    })
    expect(otherUserCmd.leadingMentions).toBeUndefined()
    expect(commandText(otherUserCmd, [BOT_USER_ID])).toBe('@alice !stop')
  })

  it('extracts metadata.files attachments with thumbnailUrl when serverUrl is provided and falls back to file.id otherwise', () => {
    const withServer = messageOf(postWithFiles)
    expect(withServer.msgId).toBe(`mattermost:${PUBLIC_CHANNEL_ID}:${FILE_POST_ID}`)
    expect(withServer.attachments).toEqual([
      {
        id: IMAGE_FILE_ID,
        name: 'error-screenshot.png',
        mimeType: 'image/png',
        size: 4096,
        sourceUrl: `${SERVER_URL}/api/v4/files/${IMAGE_FILE_ID}`,
        thumbnailUrl: `${SERVER_URL}/api/v4/files/${IMAGE_FILE_ID}/thumbnail`
      },
      {
        id: PDF_FILE_ID,
        name: 'trace_report_1_.pdf',
        mimeType: 'application/pdf',
        size: 16384,
        sourceUrl: `${SERVER_URL}/api/v4/files/${PDF_FILE_ID}`
      }
    ])

    const withoutServer = messageOf(postWithFiles, { serverUrl: undefined })
    expect(withoutServer.attachments?.[0]).toEqual({
      id: IMAGE_FILE_ID,
      name: 'error-screenshot.png',
      mimeType: 'image/png',
      size: 4096,
      sourceUrl: IMAGE_FILE_ID
    })

    // Unsafe path-traversal file ids are dropped.
    expect(toMattermostAttachment({ id: '../../secret', name: 'x.txt' }, SERVER_URL)).toBeNull()
    expect(toMattermostAttachment({ id: IMAGE_FILE_ID, delete_at: 1000 }, SERVER_URL)).toBeNull()
  })

  it('supports image-only posts without text and file_ids fallback when metadata.files is omitted', () => {
    const msg = messageOf({
      event: 'posted',
      data: {
        channel_type: 'D',
        post: {
          id: DM_POST_ID,
          user_id: ALICE_USER_ID,
          channel_id: DM_CHANNEL_ID,
          message: '',
          file_ids: [IMAGE_FILE_ID]
        }
      }
    })
    expect(msg.text).toBe('')
    expect(msg.attachments).toEqual([
      {
        id: IMAGE_FILE_ID,
        name: IMAGE_FILE_ID,
        mimeType: 'application/octet-stream',
        sourceUrl: `${SERVER_URL}/api/v4/files/${IMAGE_FILE_ID}`
      }
    ])
  })

  it('extracts readable text from props.attachments and marks props.from_bot as sender.isBot', () => {
    const msg = messageOf(postWithRichAttachments)
    expect(msg.msgId).toBe(`mattermost:${PUBLIC_CHANNEL_ID}:${RICH_POST_ID}`)
    expect(msg.sender).toEqual({ id: OTHER_BOT_USER_ID, isBot: true, name: 'alertbot' })
    expect(msg.mentionedBots).toEqual([BOT_USER_ID])
    expect(msg.text).toBe(
      [
        'Deployment Alert',
        'Release Bot',
        '[api-server v2.1.0 failed](https://deploy.example.test/runs/42)',
        `Paging @${BOT_USERNAME} to triage`,
        'Environment: staging',
        'Exit code: 137',
        'changelogue'
      ].join('\n')
    )
    expect(extractMattermostAttachmentsText([{ fallback: 'Only fallback text' }])).toBe('Only fallback text')
  })

  it('reads props.agentconnect_thread_event authorship claims and unwraps closing post_edited finalizations', () => {
    const claim = readMattermostAgentAuthorshipClaim({
      props: {
        agentconnect_thread_event: {
          author_agent_id: 'agent-1',
          response_id: 'r-1',
          delivery_state: 'streaming',
          hop_count: 0,
          mentioned_agent_ids: []
        }
      }
    })
    expect(claim).toEqual({
      authorAgentId: 'agent-1',
      responseId: 'r-1',
      deliveryState: 'streaming',
      hopCount: 0,
      mentionedAgentIds: []
    })
    // Invalid hop_count drops the whole claim.
    expect(
      readMattermostAgentAuthorshipClaim({
        props: {
          agentconnect_thread_event: {
            author_agent_id: 'agent-1',
            response_id: 'r-1',
            delivery_state: 'final',
            hop_count: -1,
            mentioned_agent_ids: []
          }
        }
      })
    ).toBeUndefined()

    // Ordinary `posted` normalizer drops `post_edited`.
    expect(normalize(agentBotFinalEdit)).toBeNull()

    const finalMsg = normalizeMattermostResponseFinalization(agentBotFinalEdit, {
      botUserId: BOT_USER_ID,
      botUsername: BOT_USERNAME,
      serverUrl: SERVER_URL
    })
    expect(finalMsg).not.toBeNull()
    expect(NormalizedPlatformMessageSchema.parse(finalMsg)).toEqual(finalMsg)
    expect(finalMsg!.msgId).toBe(`mattermost:${PUBLIC_CHANNEL_ID}:${BOT_POST_ID}`)
    expect(finalMsg!.ingressEventTag).toBe(MATTERMOST_RESPONSE_FINAL_EVENT_TAG)
    expect(finalMsg!.sender.isBot).toBe(true)
    expect(finalMsg!.agentAuthorship).toEqual({
      authorAgentId: 'agent-author',
      responseId: 'resp-1',
      deliveryState: 'final',
      hopCount: 1,
      mentionedAgentIds: ['agent-reviewer'],
      addressedAnyone: true
    })

    // Streaming edits are never emitted as response finalizations.
    expect(
      normalizeMattermostResponseFinalization(
        {
          event: 'post_edited',
          data: {
            channel_type: 'O',
            post: {
              id: BOT_POST_ID,
              user_id: OTHER_BOT_USER_ID,
              channel_id: PUBLIC_CHANNEL_ID,
              message: 'partial...',
              props: {
                from_bot: 'true',
                agentconnect_thread_event: {
                  author_agent_id: 'agent-author',
                  response_id: 'resp-1',
                  delivery_state: 'streaming',
                  hop_count: 1,
                  mentioned_agent_ids: []
                }
              }
            }
          }
        },
        { botUserId: BOT_USER_ID }
      )
    ).toBeNull()
  })

  it('drops non-posted events, deleted posts, system posts, and malformed payloads', () => {
    expect(normalize({ event: 'typing', data: {} })).toBeNull()
    expect(normalize({ event: 'posted', data: { post: '{invalid-json' } })).toBeNull()
    expect(
      normalize({
        event: 'posted',
        data: {
          channel_type: 'O',
          post: { id: ROOT_POST_ID, user_id: ALICE_USER_ID, channel_id: PUBLIC_CHANNEL_ID, message: 'hi', delete_at: 1 }
        }
      })
    ).toBeNull()
    expect(
      normalize({
        event: 'posted',
        data: {
          channel_type: 'O',
          post: {
            id: ROOT_POST_ID,
            user_id: ALICE_USER_ID,
            channel_id: PUBLIC_CHANNEL_ID,
            message: 'joined',
            type: 'system_join_channel'
          }
        }
      })
    ).toBeNull()
    expect(
      normalize({
        event: 'posted',
        data: {
          channel_type: 'O',
          post: { id: ROOT_POST_ID, user_id: ALICE_USER_ID, channel_id: PUBLIC_CHANNEL_ID, message: '   ' }
        }
      })
    ).toBeNull()
    expect(
      normalize({
        event: 'posted',
        data: {
          channel_type: 'O',
          post: { id: 'bad:id', user_id: ALICE_USER_ID, channel_id: PUBLIC_CHANNEL_ID, message: 'hi' }
        }
      })
    ).toBeNull()
    expect(parseMattermostMentions('not-json')).toEqual([])
    expect(parseMattermostMentions('["u1", "", "u1", "u2"]')).toEqual(['u1', 'u2'])
  })
})
