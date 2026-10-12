import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { config } from './config.js'
import { bar, log } from './logger.js'
import { parseMessage } from './protocol.js'
import type { FaderSource, ServerMessage } from './protocol.js'
import { pushHistory, state } from './state.js'
import type { ClientInfo } from './state.js'

let nextClientId = 1
/** Открытые соединения — для рассылки state всем клиентам. */
const sockets = new Map<WebSocket, ClientInfo>()

function send(ws: WebSocket, client: ClientInfo, msg: ServerMessage) {
  const doSend = () => {
    if (ws.readyState !== WebSocket.OPEN) return
    const text = JSON.stringify(msg)
    ws.send(text)
    // рассылку state логирует setFader одной строкой, а не по строке на клиента
    if (msg.type !== 'state' && (config.logEach || msg.type !== 'ack')) log.sent(`→ client#${client.id} ${text}`)
  }
  if (config.latencyMs > 0) setTimeout(doSend, config.latencyMs)
  else doSend()
}

/**
 * Новое положение фейдера: сохранить и разослать всем клиентам, кроме автора (он и так знает, у него ack).
 * Через это идут и изменения из интерфейсов, и движения физического фейдера.
 */
export function setFader(id: number, value: number, source: FaderSource, by?: number, except?: WebSocket) {
  const now = Date.now()
  state.faders.set(id, { id, value, updatedAt: now, source, by })
  const msg: ServerMessage = { type: 'state', id, value, source, by, serverTs: now }
  let n = 0
  for (const [ws, client] of sockets) {
    if (ws === except) continue
    send(ws, client, msg)
    n++
  }
  if (config.logEach && n > 0) log.sent(`→ всем (${n}) ${JSON.stringify(msg)}`)
}

/** Проверка seq: ловим пропуски, дубли и перестановки внутри одного соединения. */
function checkSeq(client: ClientInfo, seq: number) {
  const last = client.lastSeq
  // запоминаем максимум, чтобы опоздавшее сообщение не «откатывало» счётчик; seq=1 — клиент начал заново
  client.lastSeq = last === null || seq === 1 ? seq : Math.max(last, seq)
  if (last === null) return
  if (seq === last + 1) return
  if (seq > last + 1) {
    const gap = seq - last - 1
    client.lost += gap
    state.totals.lost += gap
    log.warn(`client#${client.id}: пропуск seq ${last} → ${seq} (потеряно ${gap})`)
  } else if (seq === 1) {
    log.info(`client#${client.id}: seq начался заново (клиент сбросил счётчики)`)
  } else {
    log.warn(`client#${client.id}: seq ${seq} после ${last} — дубликат или не по порядку`)
  }
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server })

  // Сводка раз в секунду — когда LOG_EACH=0 и сообщений слишком много для построчного лога
  let perSecond = 0
  const summary = setInterval(() => {
    if (!config.logEach && perSecond > 0) {
      const f = [...state.faders.values()].map((x) => `#${x.id}=${x.value}`).join(' ')
      log.recv(`за 1 с: ${perSecond} сообщ. | ${f}`)
    }
    perSecond = 0
  }, 1000)

  wss.on('connection', (ws, req) => {
    const client: ClientInfo = {
      id: nextClientId++,
      address: req.socket.remoteAddress ?? '?',
      connectedAt: Date.now(),
      received: 0,
      invalid: 0,
      lastSeq: null,
      lost: 0,
    }
    state.clients.set(client.id, client)
    sockets.set(ws, client)
    state.totals.connections++
    log.ok(`client#${client.id} подключился (${client.address}), всего клиентов: ${state.clients.size}`)

    send(ws, client, {
      type: 'hello',
      clientId: client.id,
      serverTs: Date.now(),
      message: 'fader-server: соединение установлено',
    })
    // новый клиент сразу получает текущие положения, чтобы не показывать 0 вместо реального значения
    for (const f of state.faders.values()) {
      send(ws, client, { type: 'state', id: f.id, value: f.value, source: f.source, by: f.by, serverTs: Date.now() })
    }

    ws.on('message', (data, isBinary) => {
      const raw = isBinary ? `[binary ${(data as Buffer).length} bytes]` : data.toString()
      const parsed = isBinary ? ({ ok: false, reason: 'бинарные данные не поддерживаются' } as const) : parseMessage(raw)

      if (!parsed.ok) {
        client.invalid++
        state.totals.invalid++
        log.error(`client#${client.id}: неверное сообщение (${parsed.reason}): ${raw}`)
        send(ws, client, { type: 'error', reason: parsed.reason, raw: raw.slice(0, 200) })
        return
      }

      const m = parsed.msg
      const now = Date.now()
      client.received++
      state.totals.received++
      perSecond++
      checkSeq(client, m.seq)

      pushHistory({ ...m, clientId: client.id, receivedAt: now })

      if (config.logEach) {
        log.recv(
          `client#${client.id} fader#${m.id} = ${String(m.value).padStart(3)} ${bar(m.value)} seq=${m.seq} Δ=${now - m.ts}мс`,
        )
      }

      if (config.ack) {
        send(ws, client, { type: 'ack', id: m.id, value: m.value, seq: m.seq, serverTs: now, deltaMs: now - m.ts })
      }
      setFader(m.id, m.value, 'client', client.id, ws)
    })

    ws.on('close', (code, reason) => {
      state.clients.delete(client.id)
      sockets.delete(ws)
      log.info(
        `client#${client.id} отключился: код ${code}${reason.length ? `, ${reason.toString()}` : ''}. ` +
          `Принято ${client.received}, ошибок ${client.invalid}, потеряно ${client.lost}`,
      )
    })

    ws.on('error', (err) => log.error(`client#${client.id}: ${err.message}`))
  })

  wss.on('close', () => clearInterval(summary))
  return wss
}
