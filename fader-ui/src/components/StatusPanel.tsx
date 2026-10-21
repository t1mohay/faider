import { useEffect, useState } from 'react'
import type { ConnStatus, RetryInfo, WsStats } from '../hooks/useWebSocket'

/** Отклик «отправил → получил ack» по часам этого устройства, мс, за последние 5 с. */
export interface RttStats {
  last: number
  avg: number
  max: number
}

interface StatusPanelProps {
  status: ConnStatus
  stats: WsStats
  connectedAt: number | null
  retry: RetryInfo | null
  onRetryNow: () => void
  rate: number
  rtt: RttStats | null
  lastSent: number | null
  seq: number
  onResetStats: () => void
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  disconnected: 'Отключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  reconnecting: 'Переподключение…',
  error: 'Ошибка',
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function StatusPanel({
  status,
  stats,
  connectedAt,
  retry,
  onRetryNow,
  rate,
  rtt,
  lastSent,
  seq,
  onResetStats,
}: StatusPanelProps) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!connectedAt && !retry) return
    setNow(Date.now())
    // обратный отсчёт до попытки — чаще, чтобы секунды не «залипали»
    const t = setInterval(() => setNow(Date.now()), retry ? 250 : 1000)
    return () => clearInterval(t)
  }, [connectedAt, retry])

  const retryIn = retry ? Math.max(0, Math.ceil((retry.at - now) / 1000)) : 0

  return (
    <section className="panel status">
      <div className={`status__conn status__conn--${status}`}>
        <span className="dot" />
        {STATUS_TEXT[status]}
        {connectedAt && <span className="muted"> · {formatUptime(now - connectedAt)}</span>}
        {retry && (
          <span className="muted">
            {' '}
            · попытка {retry.attempt}
            {retryIn > 0 && <>, через {retryIn} с</>}
          </span>
        )}
        {retry && retryIn > 0 && (
          <button type="button" className="link status__retry" onClick={onRetryNow}>
            Сейчас
          </button>
        )}
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
        <div title="Время от отправки значения до ответа сервера (ack) по часам этого устройства. Среднее и максимум — за последние 5 с.">
          <dt>Отклик, мс</dt>
          <dd>
            {rtt ? rtt.last : '—'}
            {rtt && (
              <span className="muted small-inline">
                {' '}
                ср. {rtt.avg} · макс {rtt.max}
              </span>
            )}
          </dd>
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
