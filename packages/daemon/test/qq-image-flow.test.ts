import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import { transcriptChannelKey } from '../src/store/local-store.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
)
const pdf = Buffer.from('%PDF-1.4 QQ attachment')
let daemon: Daemon | undefined
let root: string | undefined

afterEach(async () => {
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('QQ images through the daemon', () => {
  it.each([true, false])(
    'delivers an image prompt and shares a workspace image through the correct integration (isDm=%s)',
    async (isDm) => {
      const channel = isDm ? 'dm:user' : 'group:group'
      const thread = isDm ? 'dm' : 'group'
      const target = isDm ? '/v2/users/user' : '/v2/groups/group'
      root = mkdtempSync(join(tmpdir(), 'ac-qq-image-'))
      const dir = join(root, 'agents', 'qq-agent')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(root, 'config.json'),
        JSON.stringify({
          version: 1,
          controlPlane: { enabled: false },
          runtimes: { claude: { command: 'node', args: ['unused'] } }
        })
      )
      const integrations = ['other', 'image'].map((id, index) => ({
        id,
        platform: 'qq' as const,
        core: {
          mode: 'direct' as const,
          bindRules: [{ match: { kind: 'dm' as const } }, { match: { kind: 'mention' as const } }],
          mutedChannels: [],
          sessionModes: [],
          gated: false
        },
        config: { appId: String(100 + index), appSecret: 'test-secret' }
      }))
      writeFileSync(
        join(dir, 'agent.json'),
        JSON.stringify({
          id: 'qq-agent',
          name: 'QQ Agent',
          runtime: 'claude',
          status: 'active',
          workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
          integrations,
          output: { mode: 'high' }
        })
      )
      vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
      vi.spyOn(TokenManager.prototype, 'getAccessToken').mockImplementation(async (appId) => `token-${appId}`)
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (String(input) === 'https://gchat.qpic.cn/invoice.pdf') return new Response(pdf)
        if (String(input) === 'https://gchat.qpic.cn/image') return new Response(png)
        if (String(input) === 'https://upload.example/image') return new Response(null, { status: 200 })
        throw new Error('Unexpected network request in QQ image test')
      })
      const request = vi.spyOn(ApiClient.prototype, 'request').mockImplementation(async (_token, _method, path) => {
        if (path.endsWith('/upload_prepare'))
          return {
            upload_id: 'upload',
            block_size: 1024,
            parts: [{ index: 1, presigned_url: 'https://upload.example/image' }]
          }
        if (path.endsWith('/files')) return { file_info: 'image-info', ttl: 300 }
        return { id: 'posted-image' }
      })
      const outcomes: unknown[] = []
      const fileReads: unknown[] = []
      const prompts: ContentBlock[][] = []
      let sessionCwd = ''
      daemon = new Daemon({
        root,
        hostFactory: () =>
          ({
            start: async () => {},
            stop: async () => {},
            cancel: async () => {},
            promptSupports: (kind: string) => kind === 'image',
            newSession: async (cwd: string) => {
              sessionCwd = cwd
              mkdirSync(cwd, { recursive: true })
              writeFileSync(join(cwd, 'picture.png'), png)
              writeFileSync(join(cwd, 'document.pdf'), '%PDF not an image')
              return 'acp-image'
            },
            prompt: async (_sid: string, blocks: ContentBlock[]) => {
              prompts.push(blocks)
              const deps = (daemon as any).mcp.deps
              fileReads.push(
                await executeTool(
                  context,
                  'readQQFile',
                  { url: 'https://gchat.qpic.cn/invoice.pdf', mimeType: 'application/pdf' },
                  deps
                )
              )
              await expect(executeTool(context, 'shareFile', { path: 'document.pdf' }, deps)).rejects.toThrow(
                'not a PNG'
              )
              await expect(executeTool(context, 'shareFile', { path: '../outside.png' }, deps)).rejects.toThrow(
                'workspace-relative'
              )
              outcomes.push(
                await executeTool(
                  context,
                  'shareFile',
                  {
                    path: 'picture.png',
                    caption: 'Here is the image'
                  },
                  deps
                )
              )
              return { stopReason: 'end_turn' }
            }
          }) as any
      })
      await daemon.start()
      await vi.waitFor(() => expect((daemon as any).QQConnByIntegration.size).toBe(2))
      const scope = (daemon as any).transportScopeForIntegrationIds(['image'])
      const context: SessionContext = Object.assign(
        {
          agentId: 'qq-agent',
          integrationId: 'image',
          platform: 'qq',
          channel,
          thread,
          transportScope: scope,
          isDm,
          tools: toolsForIntegrations(integrations)
        },
        { deliveryThread: thread }
      )
      const connection = (daemon as any).QQConnByIntegration.get('image') as QQConnection
      const received = connection.normalizeMessage({
        rawEventType: isDm ? 'C2C_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE',
        kind: isDm ? 'c2c' : 'group',
        ...(!isDm ? { groupOpenid: 'group' } : {}),
        senderId: 'user',
        messageId: 'incoming-image',
        content: isDm ? '' : '<@!101>',
        attachments: [
          { content_type: 'image/png', filename: 'received.png', url: 'https://gchat.qpic.cn/image' },
          {
            content_type: 'file',
            filename: 'invoice.pdf',
            url: 'https://gchat.qpic.cn/invoice.pdf'
          }
        ]
      })!
      const download = vi.spyOn(connection, 'downloadFile')
      const wrongDownload = vi.spyOn((daemon as any).QQConnByIntegration.get('other') as QQConnection, 'downloadFile')
      await (daemon as any).onInboundOutcome(received, ['image'])
      await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 10_000 })
      expect(prompts[0]).toContainEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
      expect(prompts[0]).toContainEqual(
        expect.objectContaining({
          type: 'resource_link',
          name: 'invoice.pdf',
          uri: 'https://gchat.qpic.cn/invoice.pdf',
          description: expect.stringContaining('readQQFile')
        })
      )
      expect(fileReads[0]).toMatchObject({
        mcpContent: [{ type: 'text', text: expect.stringContaining('uploads/invoice.pdf') }]
      })
      expect(readFileSync(join(sessionCwd, 'uploads', 'invoice.pdf'))).toEqual(pdf)
      expect(download).toHaveBeenCalled()
      expect(wrongDownload).not.toHaveBeenCalled()
      expect(outcomes[0]).toMatchObject({ ok: true, post: { platform: 'qq', channel, ts: 'posted-image' } })
      const media = request.mock.calls.filter((call) => (call[3] as { msg_type?: number })?.msg_type === 7)
      expect(media).toHaveLength(1)
      expect(media[0]).toEqual([
        'token-101',
        'POST',
        `${target}/messages`,
        {
          msg_type: 7,
          ...(!isDm ? { message_reference: { message_id: 'incoming-image' } } : {}),
          media: { file_info: 'image-info' },
          content: 'Here is the image',
          msg_id: 'incoming-image',
          msg_seq: isDm ? 1 : 2
        }
      ])
      expect(
        request.mock.calls.filter((call) => call[2].includes('/upload')).every((call) => call[2].startsWith(target))
      ).toBe(true)
      const rows = await (daemon as any).store.threadTranscript(
        transcriptChannelKey(channel, scope),
        thread,
        'qq-agent'
      )
      expect(rows.some((row: { text: string }) => row.text.includes('[shared: picture.png'))).toBe(true)
      expect(rows.filter((row: { attachmentsJson?: string }) => row.attachmentsJson)).toHaveLength(2)
    }
  )
})
