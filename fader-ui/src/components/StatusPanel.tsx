import { useEffect, useState } from 'react'
import type { ConnStatus, WsStats } from '../hooks/useWebSocket'

interface StatusPanelProps {
  status: ConnStatus
  stats: WsStats
  connectedAt: number | null
  rate: number
  lastSent: number | null
  seq: number
  onResetStats: () => void
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  disconnected: 'Отключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  error: 'Ошибка',
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function StatusPanel({ status, stats, connectedAt, rate, lastSent, seq, onResetStats }: StatusPanelProps) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!connectedAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [connectedAt])

  return (
    <section className="panel status">
      <div className={`status__conn status__conn--${status}`}>
        <span className="dot" />
        {STATUS_TEXT[status]}
        {connectedAt && <span className="muted"> · {formatUptime(now - connectedAt)}</span>}
      </div>
      <dl className="stats">
        <div>
          <dt>Отправлено</dt>
          <dd>{stats.sent}</dd>
        </div>
        <div>
          <dt>Получено</dt>
          <dd>{stats.received}</dd>
        </div>
        <div className={stats.dropped > 0 ? 'is-warn' : ''}>
          <dt>Не ушло</dt>
          <dd>{stats.dropped}</dd>
        </div>
        <div>
          <dt>Сообщ./сек</dt>
          <dd>{rate}</dd>
        </div>
        <div>
          <dt>Последнее отпр.</dt>
          <dd>{lastSent ?? '—'}</dd>
        </div>
        <div>
          <dt>seq</dt>
          <dd>{seq}</dd>
        </div>
        <div>
          <dt>Байт отпр.</dt>
          <dd>{stats.bytesSent}</dd>
        </div>
      </dl>
      <button className="link" onClick={onResetStats}>
        Сбросить счётчики
      </button>
    </section>
  )
}
