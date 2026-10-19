import { config } from './config.js'
import type { FaderMessage, FaderSource, LockOwner } from './protocol.js'

/** Всё состояние сервера хранится в памяти — для прототипа этого достаточно. */

export interface FaderState {
  id: number
  value: number
  updatedAt: number
  /** Кто последним менял фейдер: интерфейс или физический фейдер. */
  source: FaderSource
  /** Номер клиента, если source = 'client'. */
  by?: number
}

/** Захват фейдера: кто им сейчас управляет. Свободный фейдер в карте не хранится. */
export interface FaderLock {
  id: number
  owner: Exclude<LockOwner, null>
  /** true — держат ручку (до release), false — короткий захват на LOCK_MS. */
  held: boolean
}

export interface HistoryItem extends FaderMessage {
  clientId: number
  receivedAt: number
}

export interface ClientInfo {
  id: number
  address: string
  connectedAt: number
  received: number
  invalid: number
  /** Изменения, отклонённые из-за того, что фейдер был занят другим. */
  rejected: number
  lastSeq: number | null
  lost: number
}

export const state = {
  startedAt: Date.now(),
  faders: new Map<number, FaderState>(),
  locks: new Map<number, FaderLock>(),
  history: [] as HistoryItem[],
  clients: new Map<number, ClientInfo>(),
  totals: { received: 0, invalid: 0, lost: 0, connections: 0 },
}

export function pushHistory(item: HistoryItem) {
  state.history.push(item)
  if (state.history.length > config.historySize) state.history.shift()
}

export function resetState() {
  state.faders.clear()
  state.history = []
  state.totals = { received: 0, invalid: 0, lost: 0, connections: state.totals.connections }
  for (const c of state.clients.values()) {
    c.received = 0
    c.invalid = 0
    c.rejected = 0
    c.lost = 0
    c.lastSeq = null
  }
}

/** Снимок для GET /api/state */
export function snapshot() {
  return {
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    config,
    totals: state.totals,
    faders: [...state.faders.values()],
    locks: [...state.locks.values()],
    clients: [...state.clients.values()],
    process: processStats(),
  }
}

/** Память и процессорное время сервера — нагрузочный тест сравнивает их до и после. */
function processStats() {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10
  return {
    rssMb: mb(mem.rss),
    heapUsedMb: mb(mem.heapUsed),
    /** Суммарное процессорное время с запуска, мс. */
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  }
}
