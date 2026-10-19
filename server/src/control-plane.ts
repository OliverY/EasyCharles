import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { isAdminPhone } from './config.ts'
import type { Config, DeviceIdentity } from './types.ts'
import type { Store } from './store.ts'
import type { RuleEngine } from './rules.ts'
import { PROTOCOL_VERSION } from './types.ts'

interface Client {
  ws: WebSocket
  role: 'sdk' | 'console' | undefined
  deviceId?: string
  sessionId?: string
  /** console 登录用户（手机号空间） */
  phone?: string
  lastSeen: number
}

function send(ws: WebSocket, type: string, payload?: unknown, id?: string): void {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type, payload, id }))
  } catch {
    /* 连接已断开，忽略 */
  }
}

export function createControlPlane(
  server: Server,
  cfg: Config,
  store: Store,
  rules: RuleEngine,
): void {
  const wss = new WebSocketServer({ server, path: '/__ec/ws' })
  const clients = new Set<Client>()

  /**
   * 某个 console 连接该看到的设备（ADR-018）：admin 全量，其余 = 自己绑定的 + 未绑定的。
   * 设备推送是**逐连接**算的——原来是一份全量列表广播给所有人，那等于把
   * 「谁在用哪台设备」泄露给每个登录用户。
   */
  const devicesFor = (c: Client) =>
    isAdminPhone(cfg, c.phone) ? store.listDevices() : store.listDevicesFor(c.phone)
  const pushDevices = () => {
    for (const c of clients) if (c.role === 'console') send(c.ws, 'device', devicesFor(c))
  }
  const toSdk = (deviceId: string, type: string, payload?: unknown) => {
    for (const c of clients) if (c.role === 'sdk' && c.deviceId === deviceId) send(c.ws, type, payload)
  }

  wss.on('connection', (ws) => {
    const client: Client = { ws, role: undefined, lastSeen: Date.now() }
    clients.add(client)

    // F-07：协议层 pong 也刷新 lastSeen（浏览器控制台不发应用层心跳，只能靠 ping/pong 判活）
    ws.on('pong', () => {
      client.lastSeen = Date.now()
    })

    ws.on('message', (raw) => {
      client.lastSeen = Date.now()
      let msg: { v?: number; type?: string; id?: string; payload?: unknown }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      const payload = (msg.payload ?? {}) as Record<string, unknown>

      if (!client.role) {
        // 控制台订阅需要已登录会话（手机号空间）；SDK hello 不受限（数据面性质）
        if (msg.type === 'subscribe') {
          const session = String(payload.session ?? '')
          const phone = store.sessionPhone(session)
          if (!phone) {
            ws.close(4001, 'EC_UNAUTHORIZED')
            return
          }
          client.phone = phone
        }
        if (msg.type === 'hello' && payload.identity) {
          client.role = 'sdk'
          const identity = payload.identity as DeviceIdentity
          client.deviceId = identity.deviceId
          client.sessionId = identity.sessionId
          store.upsertDevice(identity)
          send(ws, 'welcome', {
            serverId: 'srv_local',
            config: {
              recordMode: cfg.recordMode,
              maxBufferBytes: cfg.maxBufferBytes,
              sampleBytes: cfg.sampleBytes,
              heartbeatMs: cfg.heartbeatMs,
            },
          }, msg.id)
        } else {
          client.role = 'console'
          send(ws, 'welcome', { serverId: 'srv_local', config: { recordMode: cfg.recordMode } }, msg.id)
          send(ws, 'device', devicesFor(client))
        }
        return
      }

      if (client.role === 'sdk') {
        if (msg.type === 'heartbeat') {
          send(ws, 'heartbeat_ack', payload, msg.id)
        } else if (msg.type === 'identity_update') {
          const identity = payload.identity as DeviceIdentity | undefined
          if (identity) store.upsertDevice(identity)
        }
        return
      }

      // console 侧指令
      if (msg.type === 'command') {
        const action = String(payload.action ?? '')
        if (action === 'reset_mock') {
          // C14：只重置**这个会话自己的私有规则**的指针。旧的「一键清全服指针」
          // 在按用户隔离之后是越权——A 重置会把 B 正在走的序列归零，而 B 的界面上看不出来
          const scope = rules.resetPointers(client.phone)
          send(ws, 'command_ack', { action, scope }, msg.id)
        } else if (action === 'set_enabled') {
          const enabled = Boolean(payload.enabled)
          // 协议 §4.2：params 直接是 { enabled }，不套 params 层
          for (const c of clients) {
            if (c.role === 'sdk' && c.deviceId) {
              toSdk(c.deviceId, 'command', { action: 'set_enabled', enabled })
            }
          }
          send(ws, 'command_ack', { action }, msg.id)
        }
      }
    })

    ws.on('close', () => {
      if (client.role === 'sdk' && client.deviceId && client.sessionId) {
        store.markOffline(client.deviceId, client.sessionId)
      }
      clients.delete(client)
    })
    ws.on('error', () => clients.delete(client))
  })

  store.on('record', (rec) => {
    // 用户空间只推送自己当前绑定设备的记录；未绑定设备仅出现在设备列表，不推送其请求。
    for (const c of clients) {
      if (c.role !== 'console') continue
      if (!store.recordVisible(rec.deviceId, c.phone)) continue
      send(c.ws, 'record', rec)
    }
  })
  store.on('devices', () => pushDevices())

  const timer = setInterval(() => {
    const now = Date.now()
    for (const c of clients) {
      // F-07：每轮先 ping，存活对端会回 pong 刷新 lastSeen；静默超过 3 个心跳周期才踢
      if (c.ws.readyState === c.ws.OPEN) {
        try {
          c.ws.ping()
        } catch {
          /* ignore */
        }
      }
      if (now - c.lastSeen > cfg.heartbeatMs * 3) {
        try {
          c.ws.terminate()
        } catch {
          /* ignore */
        }
      }
    }
  }, 15_000)
  timer.unref()
}
