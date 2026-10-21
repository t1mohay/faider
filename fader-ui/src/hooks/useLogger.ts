import { useCallback, useEffect, useRef, useState } from 'react'

export type LogLevel = 'info' | 'sent' | 'recv' | 'warn' | 'error'

export interface LogEntry {
  id: number
  time: number
  level: LogLevel
  text: string
}

/** Сколько записей держим в памяти (для «Скачать .txt»). На экране — только последние, см. LogPanel. */
const MAX_ENTRIES = 1000
/**
 * Записи копятся и попадают на экран пачкой не чаще раза в столько мс.
 * Иначе каждое сообщение (а их десятки в секунду) перерисовывало бы весь интерфейс — на телефоне это тормоза.
 */
const FLUSH_MS = 200
const VERBOSE_KEY = 'fader-ui:verbose-log'

export function formatTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export interface LogOptions {
  /**
   * Рядовое сообщение, которое идёт потоком (входящие state и ack, исходящие значения фейдера).
   * Пишется, только если включён «Подробный лог».
   */
  routine?: boolean
}

function loadVerbose(): boolean {
  try {
    return localStorage.getItem(VERBOSE_KEY) === '1'
  } catch {
    return false
  }
}

export function useLogger() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [verbose, setVerboseState] = useState(loadVerbose)
  const verboseRef = useRef(verbose)
  const nextId = useRef(1)
  const bufferRef = useRef<LogEntry[]>([])
  const flushTimerRef = useRef<number | null>(null)

  const flush = useCallback(() => {
    flushTimerRef.current = null
    const batch = bufferRef.current
    if (batch.length === 0) return
    bufferRef.current = []
    setEntries((prev) => {
      const next = prev.concat(batch)
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
    })
  }, [])

  const log = useCallback(
    (level: LogLevel, text: string, opts?: LogOptions) => {
      if (opts?.routine && !verboseRef.current) return
      const entry: LogEntry = { id: nextId.current++, time: Date.now(), level, text }
      // дублируем в консоль браузера — удобно смотреть в DevTools
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(`[fader-ui] [${level}] ${text}`)
      bufferRef.current.push(entry)
      if (flushTimerRef.current === null) flushTimerRef.current = window.setTimeout(flush, FLUSH_MS)
    },
    [flush],
  )

  const setVerbose = useCallback((v: boolean) => {
    verboseRef.current = v
    setVerboseState(v)
    try {
      localStorage.setItem(VERBOSE_KEY, v ? '1' : '0')
    } catch {
      /* localStorage может быть недоступен — не критично */
    }
  }, [])

  const clear = useCallback(() => {
    bufferRef.current = []
    setEntries([])
  }, [])

  useEffect(() => {
    // В dev React (StrictMode) монтирует компонент дважды: между монтированиями таймер снят,
    // а записи (например, «Интерфейс запущен») уже лежат в буфере — выводим их заново.
    if (bufferRef.current.length > 0 && flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(flush, FLUSH_MS)
    }
    return () => {
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
      // обязательно обнулить: иначе log() считает, что таймер ещё идёт, и больше никогда не выводит
      flushTimerRef.current = null
    }
  }, [flush])

  return { entries, log, clear, verbose, setVerbose }
}

export type Logger = ReturnType<typeof useLogger>['log']
