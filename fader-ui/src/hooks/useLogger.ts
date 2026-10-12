import { useCallback, useRef, useState } from 'react'

export type LogLevel = 'info' | 'sent' | 'recv' | 'warn' | 'error'

export interface LogEntry {
  id: number
  time: number
  level: LogLevel
  text: string
}

/** Сколько записей держим в памяти, чтобы страница не тормозила при долгом тесте. */
const MAX_ENTRIES = 1000

export function formatTime(t: number): string {
  const d = new Date(t)
  const pad = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

export function useLogger() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const nextId = useRef(1)

  const log = useCallback((level: LogLevel, text: string) => {
    const entry: LogEntry = { id: nextId.current++, time: Date.now(), level, text }
    // дублируем в консоль браузера — удобно смотреть в DevTools
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[fader-ui] [${level}] ${text}`)
    setEntries((prev) => {
      const next = prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : prev.slice()
      next.push(entry)
      return next
    })
  }, [])

  const clear = useCallback(() => setEntries([]), [])

  return { entries, log, clear }
}

export type Logger = ReturnType<typeof useLogger>['log']
