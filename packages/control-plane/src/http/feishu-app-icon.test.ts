import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { AgentId } from '../domain/ids.js'
import type { BotProfileIconAgent } from './bot-profile-icon.js'
import { createFeishuAppIconSyncer } from './feishu-app-icon.js'

const agent: BotProfileIconAgent = {
  id: AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  icon: { kind: 'glyph', glyph: 'bot', color: '#2563eb' },
  runtime: 'codex'
}

describe('createFeishuAppIconSyncer', () => {
  it('uploads, patches, and publishes the Agent icon through the Lark gateway', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { url: 'https://cdn.example.test/app-icon' } }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }))

    await createFeishuAppIconSyncer(undefined, fetcher)('cli_test', 'app-secret', 'lark', agent)

    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      app_id: 'cli_test',
      app_secret: 'app-secret'
    })

    expect(fetcher.mock.calls[1]?.[0]).toBe('https://open.larksuite.com/open-apis/application/v7/app_avatar/upload')
    const upload = fetcher.mock.calls[1]?.[1]?.body
    expect(upload).toBeInstanceOf(FormData)
    const avatar = (upload as FormData).get('avatar')
    expect(avatar).toBeInstanceOf(Blob)
    const metadata = await sharp(Buffer.from(await (avatar as Blob).arrayBuffer())).metadata()
    expect({ width: metadata.width, height: metadata.height, format: metadata.format }).toEqual({
      width: 512,
      height: 512,
      format: 'png'
    })

    expect(fetcher.mock.calls[2]?.[0]).toBe(
      'https://open.larksuite.com/open-apis/application/v7/applications/cli_test/base'
    )
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('PATCH')
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({ authorization: 'Bearer tenant-token' })
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      avatar_url: 'https://cdn.example.test/app-icon'
    })

    expect(fetcher.mock.calls[3]?.[0]).toBe(
      'https://open.larksuite.com/open-apis/application/v7/applications/cli_test/publish'
    )
    expect(fetcher.mock.calls[3]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      remark: 'Sync the application icon with its AgentConnect agent',
      changelog: 'Updated the application icon'
    })
  })

  it('stops before patching when the provider rejects the icon upload', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 999, msg: 'denied' }), { status: 200 }))

    await expect(
      createFeishuAppIconSyncer(undefined, fetcher)('cli_test', 'app-secret', 'feishu', agent)
    ).rejects.toThrow('Lark/Feishu icon upload returned 200')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
