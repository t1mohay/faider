import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { config } from './config.js'
import { bar, log } from './logger.js'
import { parseMessage } from './protocol.js'
import type { FaderSource, LockOwner, ServerMessage } from './protocol.js'
import type { HwManager, HwStatus } from './hw/manager.js'
import { pushHistory, state } from './state.js'
import type { ClientInfo } from './state.js'

let nextClientId = 1
/** Подключённое железо — задаётся в attachWebSocket. */
let hw: HwManager | null = null
/** Открытые соединения — для рассылки state всем клиентам. */
const sockets = new Map<WebSocket, ClientInfo>()

function send(ws: WebSocket, client: ClientInfo, msg: ServerMessage) {
  const doSend = () => {
    if (ws.readyState !== WebSocket.OPEN) return
    const text = JSON.stringify(msg)
    ws.send(text)
    // рассылки (state, lock, hw-status) логируются один раз в месте рассылки, а не по строке на клиента
    const broadcast = msg.type === 'state' || msg.type === 'lock' || msg.type === 'hw-status'
    if (!broadcast && (config.logEach || msg.type !== 'ack')) {
      log.sent(`→ client#${client.id} ${text}`)
    }
  }
  if (config.latencyMs > 0) setTimeout(doSend, config.latencyMs)
  else doSend()
}

/**
 * Новое положение фейдера: сохранить и разослать всем клиентам, кроме автора (он и так знает, у него ack).
 * Через это идут и изменения из интерфейсов, и движения физического фейдера.
 * Изменения из интерфейсов уходят и на железо — мотор двигает ручку.
 */
export function setFader(id: number, value: number, source: FaderSource, by?: number, except?: WebSocket) {
  // физический фейдер главнее интерфейсов: забирает захват, даже если ручку кто-то держит;
  // если его держат рукой (датчик касания) — захват уже долгий, не превращаем его в короткий
  const lock = state.locks.get(id)
  if (source === 'hw' && !(lock?.owner === 'hw' && lock.held)) setLock(id, 'hw', false)
  else if (source !== 'hw') hw?.sendFader(id, value)
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

/** Таймеры коротких захватов (held = false). */
const lockTimers = new Map<number, NodeJS.Timeout>()

function describeOwner(owner: LockOwner): string {
  if (owner === null) return 'свободен'
  return owner === 'hw' ? 'физический фейдер' : `client#${owner}`
}

/**
 * Захват фейдера: пока он занят, изменения от остальных клиентов отклоняются.
 * held = false — короткий захват, сам снимется через LOCK_MS после последнего вызова.
 */
export function setLock(id: number, owner: LockOwner, held: boolean) {
  clearTimeout(lockTimers.get(id))
  lockTimers.delete(id)
  const prev = state.locks.get(id)
  if (owner === null) state.locks.delete(id)
  else {
    state.locks.set(id, { id, owner, held })
    if (!held) lockTimers.set(id, setTimeout(() => setLock(id, null, false), config.lockMs))
  }
  // продление короткого захвата тем же владельцем — не новость, не рассылаем
  const same = owner === null ? !prev : prev?.owner === owner && prev.held === held
  if (same) return
  for (const [ws, client] of sockets) send(ws, client, { type: 'lock', id, owner, held })
  log.info(`fader#${id}: ${owner === null ? 'освобождён' : `захвачен — ${describeOwner(owner)}${held ? '' : ' (коротко)'}`}`)
}

/** Физический фейдер взяли рукой или отпустили (Note On/Off с платы). */
export function setHwTouch(id: number, touched: boolean) {
  if (touched) setLock(id, 'hw', true)
  else if (state.locks.get(id)?.owner === 'hw') setLock(id, null, false)
}

/** Разослать всем состояние железа (список устройств, что подключено). */
export function broadcastHwStatus(status: HwStatus) {
  for (const [ws, client] of sockets) send(ws, client, { type: 'hw-status', ...status })
  log.info(`Железо: ${status.state}${status.selected ? ` (${status.selected})` : ''}, устройств: ${status.devices.length}`)
}

/** Свободен ли фейдер для клиента: никем не занят или занят им самим. */
function canControl(id: number, client: ClientInfo): boolean {
  const owner = state.locks.get(id)?.owner
  return owner === undefined || owner === client.id
}

/** Отказ: сообщить клиенту, кто держит фейдер, и вернуть его ручку в текущее положение. */
function deny(ws: WebSocket, client: ClientInfo, id: number, what: string) {
  const lock = state.locks.get(id)!
  log.warn(`client#${client.id}: ${what} fader#${id} отклонено — занят (${describeOwner(lock.owner)})`)
  send(ws, client, { type: 'lock', id, owner: lock.owner, held: lock.held })
  const f = state.faders.get(id)
  if (f) send(ws, client, { type: 'state', id, value: f.value, source: f.source, by: f.by, serverTs: Date.now() })
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

export function attachWebSocket(server: Server, hwManager: HwManager) {
  hw = hwManager
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
      rejected: 0,
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
    for (const l of state.locks.values()) send(ws, client, { type: 'lock', id: l.id, owner: l.owner, held: l.held })
    send(ws, client, { type: 'hw-status', ...hwManager.status() })

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
      if (m.type === 'hw-list') {
        // список мог не измениться — тогда рассылки не будет, а ответ клиенту нужен
        void hwManager.refresh(true).then(() => send(ws, client, { type: 'hw-status', ...hwManager.status() }))
        return
      }
      if (m.type === 'hw-connect') {
        log.info(`client#${client.id}: подключить устройство ${m.device}`)
        void hwManager.connect(m.device)
        return
      }
      if (m.type === 'hw-disconnect') {
        log.info(`client#${client.id}: отключить устройство`)
        void hwManager.disconnect()
        return
      }
      if (m.type === 'grab') {
        if (canControl(m.id, client)) setLock(m.id, client.id, true)
        else deny(ws, client, m.id, 'захват')
        return
      }
      if (m.type === 'release') {
        if (state.locks.get(m.id)?.owner === client.id) setLock(m.id, null, false)
        return
      }

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

      if (!canControl(m.id, client)) {
        client.rejected++
        deny(ws, client, m.id, `значение ${m.value} для`)
        return
      }
      // кнопки и клавиатура двигают фейдер без grab — занимаем его коротко, чтобы и тут не было гонки
      if (!state.locks.get(m.id)?.held) setLock(m.id, client.id, false)

      if (config.ack) {
        send(ws, client, { type: 'ack', id: m.id, value: m.value, seq: m.seq, serverTs: now, deltaMs: now - m.ts })
      }
      setFader(m.id, m.value, 'client', client.id, ws)
    })

    ws.on('close', (code, reason) => {
      state.clients.delete(client.id)
      sockets.delete(ws)
      // ручку не отпустили, а соединение пропало — освобождаем, иначе фейдер останется занятым навсегда
      for (const l of [...state.locks.values()]) if (l.owner === client.id) setLock(l.id, null, false)
      log.info(
        `client#${client.id} отключился: код ${code}${reason.length ? `, ${reason.toString()}` : ''}. ` +
          `Принято ${client.received}, ошибок ${client.invalid}, отклонено ${client.rejected}, потеряно ${client.lost}`,
      )
    })

    ws.on('error', (err) => log.error(`client#${client.id}: ${err.message}`))
  })

  wss.on('close', () => clearInterval(summary))
  return wss
}
