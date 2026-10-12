/**
 * Формат сообщений — зеркало фронтового src/lib/protocol.ts.
 * Клиент -> сервер: FaderMessage
 * Сервер -> клиент: HelloMessage | AckMessage | StateMessage | ErrorMessage
 */

export const FADER_MIN = 0
export const FADER_MAX = 127

export interface FaderMessage {
  type: 'fader'
  id: number
  value: number
  seq: number
  ts: number
}

export interface HelloMessage {
  type: 'hello'
  clientId: number
  serverTs: number
  message: string
}

export interface AckMessage {
  type: 'ack'
  id: number
  value: number
  seq: number
  serverTs: number
  /** serverTs - ts клиента. Имеет смысл, только если часы клиента и сервера совпадают (одна машина). */
  deltaMs: number
}

/**
 * Текущее положение фейдера. Рассылается всем клиентам, кроме автора изменения,
 * и новому клиенту сразу после подключения — чтобы все интерфейсы показывали одно и то же.
 */
export interface StateMessage {
  type: 'state'
  id: number
  value: number
  /** Кто изменил: 'client' — один из интерфейсов (его номер в by), 'hw' — физический фейдер. */
  source: FaderSource
  by?: number
  serverTs: number
}

export type FaderSource = 'client' | 'hw'

export interface ErrorMessage {
  type: 'error'
  reason: string
  raw?: string
}

export type ServerMessage = HelloMessage | AckMessage | StateMessage | ErrorMessage

export type ParseResult = { ok: true; msg: FaderMessage } | { ok: false; reason: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Разбор и проверка входящего сообщения. Возвращает понятную причину ошибки — она уйдёт клиенту и в лог. */
export function parseMessage(raw: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'не JSON' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'ожидался JSON-объект' }
  }
  const m = data as Record<string, unknown>
  if (m.type !== 'fader') return { ok: false, reason: `неизвестный type: ${JSON.stringify(m.type)}` }
  if (!isInt(m.id) || m.id < 0) return { ok: false, reason: 'id должен быть целым числом >= 0' }
  if (!isInt(m.value) || m.value < FADER_MIN || m.value > FADER_MAX) {
    return { ok: false, reason: `value должен быть целым ${FADER_MIN}..${FADER_MAX}, пришло ${JSON.stringify(m.value)}` }
  }
  if (!isInt(m.seq) || m.seq < 0) return { ok: false, reason: 'seq должен быть целым числом >= 0' }
  if (typeof m.ts !== 'number') return { ok: false, reason: 'ts должен быть числом (мс)' }
  return { ok: true, msg: { type: 'fader', id: m.id, value: m.value, seq: m.seq, ts: m.ts } }
}
