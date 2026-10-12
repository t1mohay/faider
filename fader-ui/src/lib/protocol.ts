/**
 * Формат сообщений фронт <-> сервер.
 * ВНИМАНИЕ: это предложение фронта, его нужно согласовать с backend.
 * Всё, что касается формата, собрано здесь, чтобы менять в одном месте.
 */

/** Диапазон значения фейдера: как у MIDI Control Change (7 бит). */
export const FADER_MIN = 0
export const FADER_MAX = 127

export interface FaderMessage {
  type: 'fader'
  /** Номер фейдера (пока один, но поле нужно на будущее). */
  id: number
  /** Положение 0..127. */
  value: number
  /** Порядковый номер сообщения — помогает бэку заметить потери/перестановки. */
  seq: number
  /** Время отправки на клиенте, мс (Date.now()). */
  ts: number
}

/** Клиент -> сервер: пользователь взял ручку — занять фейдер, чтобы другие не могли его двигать. */
export interface GrabMessage {
  type: 'grab'
  id: number
}

/** Клиент -> сервер: пользователь отпустил ручку — освободить фейдер. */
export interface ReleaseMessage {
  type: 'release'
  id: number
}

/** Кто изменил фейдер: 'client' — один из интерфейсов, 'hw' — физический фейдер. */
export type FaderSource = 'client' | 'hw'

/** Кто сейчас управляет фейдером: номер клиента, 'hw' — физический фейдер, null — свободен. */
export type LockOwner = number | 'hw' | null

/** Сервер -> клиент: сразу после подключения. */
export interface HelloMessage {
  type: 'hello'
  clientId: number
}

/**
 * Сервер -> клиент: текущее положение фейдера. Приходит при подключении и при каждом
 * изменении другим интерфейсом или физическим фейдером (своё изменение обратно не приходит).
 */
export interface StateMessage {
  type: 'state'
  id: number
  value: number
  source: FaderSource
  /** Номер клиента, если source = 'client'. */
  by?: number
}

/**
 * Сервер -> клиент: захват фейдера изменился. Приходит при подключении, при каждой смене владельца
 * и в ответ на попытку подвинуть занятый фейдер (следом идёт state с текущим значением).
 */
export interface LockMessage {
  type: 'lock'
  id: number
  owner: LockOwner
  /** true — держат ручку (до release), false — короткий захват кнопками/клавиатурой/железом. */
  held: boolean
}

/** Входящие сообщения, на которые интерфейс реагирует. ack и error пока только пишутся в лог. */
export type ServerMessage = HelloMessage | StateMessage | LockMessage

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** Разбор входящего сообщения. null — не JSON или тип, который интерфейс не обрабатывает. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let m: Record<string, unknown>
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return null
    m = data as Record<string, unknown>
  } catch {
    return null
  }
  if (m.type === 'hello' && isInt(m.clientId)) return { type: 'hello', clientId: m.clientId }
  if (m.type === 'state' && isInt(m.id) && isInt(m.value) && (m.source === 'client' || m.source === 'hw')) {
    return {
      type: 'state',
      id: m.id,
      value: clampFader(m.value),
      source: m.source,
      by: isInt(m.by) ? m.by : undefined,
    }
  }
  if (
    m.type === 'lock' &&
    isInt(m.id) &&
    (m.owner === null || m.owner === 'hw' || isInt(m.owner)) &&
    typeof m.held === 'boolean'
  ) {
    return { type: 'lock', id: m.id, owner: m.owner, held: m.held }
  }
  return null
}

export function makeFaderMessage(id: number, value: number, seq: number): FaderMessage {
  return { type: 'fader', id, value, seq, ts: Date.now() }
}

export function clampFader(v: number): number {
  return Math.min(FADER_MAX, Math.max(FADER_MIN, Math.round(v)))
}

/** Значение 0..127 в проценты 0..100 — только для отображения, по сети уходит 0..127. */
export function faderToPercent(v: number): number {
  return Math.round(((v - FADER_MIN) / (FADER_MAX - FADER_MIN)) * 100)
}
