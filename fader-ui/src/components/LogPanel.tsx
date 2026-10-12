import { useEffect, useMemo, useRef, useState } from 'react'
import { formatTime } from '../hooks/useLogger'
import type { LogEntry, LogLevel } from '../hooks/useLogger'

interface LogPanelProps {
  entries: LogEntry[]
  onClear: () => void
}

const LEVELS: { level: LogLevel; title: string }[] = [
  { level: 'sent', title: 'Отправлено' },
  { level: 'recv', title: 'Получено' },
  { level: 'info', title: 'Инфо' },
  { level: 'warn', title: 'Предупр.' },
  { level: 'error', title: 'Ошибки' },
]

const TAG: Record<LogLevel, string> = {
  sent: '→ SENT',
  recv: '← RECV',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
}

export function LogPanel({ entries, onClear }: LogPanelProps) {
  const [enabled, setEnabled] = useState<Record<LogLevel, boolean>>({
    sent: true,
    recv: true,
    info: true,
    warn: true,
    error: true,
  })
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => entries.filter((e) => enabled[e.level]), [entries, enabled])

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { sent: 0, recv: 0, info: 0, warn: 0, error: 0 }
    for (const e of entries) c[e.level]++
    return c
  }, [entries])

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible, autoScroll])

  const exportLog = () => {
    const text = entries.map((e) => `${formatTime(e.time)} ${TAG[e.level].padEnd(6)} ${e.text}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `fader-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <section className="panel log">
      <header className="log__header">
        <h2>Логи</h2>
        <div className="log__filters">
          {LEVELS.map(({ level, title }) => (
            <label key={level} className={`chip chip--${level}${enabled[level] ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                checked={enabled[level]}
                onChange={(e) => setEnabled((s) => ({ ...s, [level]: e.target.checked }))}
              />
              {title} <b>{counts[level]}</b>
            </label>
          ))}
        </div>
        <div className="log__actions">
          <label className="check">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Автопрокрутка
          </label>
          <button onClick={exportLog} disabled={entries.length === 0}>
            Скачать .txt
          </button>
          <button onClick={onClear} disabled={entries.length === 0}>
            Очистить
          </button>
        </div>
      </header>
      <div className="log__list" ref={listRef}>
        {visible.length === 0 && <div className="log__empty">Пока пусто</div>}
        {visible.map((e) => (
          <div key={e.id} className={`log__row log__row--${e.level}`}>
            <span className="log__time">{formatTime(e.time)}</span>
            <span className="log__tag">{TAG[e.level]}</span>
            <span className="log__text">{e.text}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
