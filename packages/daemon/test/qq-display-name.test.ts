import { afterEach, expect, it, vi } from 'vitest'
import type { LoadedAgent } from '../src/agents/load-agents.js'
import { ChannelNameResolver } from '../src/messages/channel-name-resolver.js'
import { ConnectionReconciler, type ConnectionReconcilerHost } from '../src/platforms/connection-reconciler.js'
import { QQConnection } from '../src/platforms/qq/connection.js'

afterEach(() => vi.restoreAllMocks())

it('feeds QQ gateway sender names into the existing transcript cache under an app-scoped user id', async () => {
  vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
  const names = new Map<string, string>()
  const resolver = new ChannelNameResolver((id, name) => {
    names.set(id, name)
  })
  const onInbound = vi.fn()
  const agent = {
    id: 'agent',
    integrations: [{ id: 'qq-install', platform: 'qq', config: { appId: '100', appSecret: 'secret' } }]
  } as LoadedAgent
  const reconciler = new ConnectionReconciler({
    transportAgents: () => [agent],
    draining: () => false,
    log: () => ({ info: vi.fn(), warn: vi.fn() }),
    channelNameResolver: () => resolver,
    srcIntegrationIds: () => ['qq-install'],
    onInbound,
    bindQQ: vi.fn()
  } as unknown as ConnectionReconcilerHost)
  try {
    await reconciler.reconcileQQConnections()
    const conn = reconciler.QQPool.all()[0]!
    const message = conn.normalizeMessage({
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      kind: 'group',
      groupOpenid: 'group',
      senderId: 'openid',
      senderName: 'Alice',
      content: 'hello',
      messageId: 'message'
    })!
    const ingress = conn as unknown as { deps: { onMessage(msg: typeof message): void } }
    ingress.deps.onMessage(message)
    expect(names.get('qq:user:100:openid')).toBe('Alice')
    expect(message.sender).toMatchObject({
      id: 'qq:user:100:openid',
      name: 'Alice',
      avatarUrl: 'https://q.qlogo.cn/qqapp/100/openid/640'
    })
    expect(onInbound).toHaveBeenCalledWith(message, ['qq-install'])

    const namelessDm = conn.normalizeMessage({
      rawEventType: 'C2C_MESSAGE_CREATE',
      kind: 'c2c',
      senderId: 'openid',
      content: 'hello again',
      messageId: 'dm-message'
    })!
    ingress.deps.onMessage(namelessDm)
    await vi.waitFor(() => expect(names.get('qq:user:100:openid')).toBe('Alice'))
  } finally {
    await reconciler.dispose()
  }
})
