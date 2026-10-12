/**
 * Формат сообщений — зеркало фронтового src/lib/protocol.ts.
 * Клиент -> сервер: FaderMessage | GrabMessage | ReleaseMessage | HwListMessage | HwConnectMessage | HwDisconnectMessage
 * Сервер -> клиент: HelloMessage | AckMessage | StateMessage | LockMessage | HwStatusMessage | ErrorMessage
 */

import type { HwStatus } from './hw/manager.js'

export const FADER_MIN = 0
export const FADER_MAX = 127

export interface FaderMessage {
  type: 'fader'
  id: number
  value: number
  seq: number
  ts: number
}

/** Пользователь взял ручку — занять фейдер, пока не придёт release. */
export interface GrabMessage {
  type: 'grab'
  id: number
}

/** Пользователь отпустил ручку — освободить фейдер. */
export interface ReleaseMessage {
  type: 'release'
  id: number
}

/** Обновить список устройств (COM-порты, USB-MIDI, имитация). Ответ — hw-status. */
export interface HwListMessage {
  type: 'hw-list'
}

/** Подключить устройство по id из списка ('serial:COM3', 'midi:Arduino Leonardo', 'sim'). Одно на весь сервер. */
export interface HwConnectMessage {
  type: 'hw-connect'
  device: string
}

export interface HwDisconnectMessage {
  type: 'hw-disconnect'
}

export type ClientMessage =
  | FaderMessage
  | GrabMessage
  | ReleaseMessage
  | HwListMessage
  | HwConnectMessage
  | HwDisconnectMessage

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

/** Кто сейчас управляет фейдером: номер клиента, 'hw' — физический фейдер, null — свободен. */
export type LockOwner = number | 'hw' | null

/**
 * Захват фейдера изменился. Рассылается всем; новому клиенту — сразу после hello.
 * Отказ в захвате (фейдер занят другим) приходит тому, кому отказали, и следом — state с текущим значением.
 */
export interface LockMessage {
  type: 'lock'
  id: number
  owner: LockOwner
  /** true — захват ручкой (до release), false — короткий, сам снимется через LOCK_MS. */
  held: boolean
}

export interface ErrorMessage {
  type: 'error'
  reason: string
  raw?: string
}

/** Устройства и что подключено. Рассылается всем при каждом изменении; новому клиенту — сразу после hello. */
export type HwStatusMessage = { type: 'hw-status' } & HwStatus

export type ServerMessage = HelloMessage | AckMessage | StateMessage | LockMessage | HwStatusMessage | ErrorMessage

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; reason: string }

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
  if (m.type === 'hw-list' || m.type === 'hw-disconnect') return { ok: true, msg: { type: m.type } }
  if (m.type === 'hw-connect') {
    if (typeof m.device !== 'string' || m.device === '') return { ok: false, reason: 'device должен быть непустой строкой' }
    return { ok: true, msg: { type: 'hw-connect', device: m.device } }
  }
  if (m.type !== 'fader' && m.type !== 'grab' && m.type !== 'release') {
    return { ok: false, reason: `неизвестный type: ${JSON.stringify(m.type)}` }
  }
  if (!isInt(m.id) || m.id < 0) return { ok: false, reason: 'id должен быть целым числом >= 0' }
  if (m.type !== 'fader') return { ok: true, msg: { type: m.type, id: m.id } }
  if (!isInt(m.value) || m.value < FADER_MIN || m.value > FADER_MAX) {
    return { ok: false, reason: `value должен быть целым ${FADER_MIN}..${FADER_MAX}, пришло ${JSON.stringify(m.value)}` }
  }
  if (!isInt(m.seq) || m.seq < 0) return { ok: false, reason: 'seq должен быть целым числом >= 0' }
  if (typeof m.ts !== 'number') return { ok: false, reason: 'ts должен быть числом (мс)' }
  return { ok: true, msg: { type: 'fader', id: m.id, value: m.value, seq: m.seq, ts: m.ts } }
}
