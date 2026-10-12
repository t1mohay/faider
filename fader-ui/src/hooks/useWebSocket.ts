import { useCallback, useEffect, useRef, useState } from 'react'
import { parseServerMessage } from '../lib/protocol'
import type { ServerMessage } from '../lib/protocol'
import type { Logger } from './useLogger'

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface WsStats {
  sent: number
  received: number
  /** Сообщения, которые не ушли, потому что соединения не было. */
  dropped: number
  bytesSent: number
}

const EMPTY_STATS: WsStats = { sent: 0, received: 0, dropped: 0, bytesSent: 0 }

/** Расшифровка кодов закрытия WebSocket для логов. */
function describeClose(code: number): string {
  const map: Record<number, string> = {
    1000: 'нормальное закрытие',
    1001: 'сервер/вкладка уходит',
    1002: 'ошибка протокола',
    1003: 'неподдерживаемые данные',
    1006: 'соединение оборвано (сервер не запущен или недоступен)',
    1008: 'нарушение политики',
    1011: 'внутренняя ошибка сервера',
  }
  return map[code] ?? 'неизвестная причина'
}

export function useWebSocket(log: Logger, onMessage?: (msg: ServerMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  // через ref, чтобы не пересоздавать соединение при каждой новой функции-обработчике
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage
  const [status, setStatus] = useState<ConnStatus>('disconnected')
  const [stats, setStats] = useState<WsStats>(EMPTY_STATS)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)

  const connect = useCallback(
    (url: string) => {
      if (wsRef.current) {
        log('warn', 'Уже есть соединение — сначала отключитесь')
        return
      }
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (e) {
        // например, неверный адрес (без ws:// или wss://)
        log('error', `Не удалось создать WebSocket: ${(e as Error).message}`)
        setStatus('error')
        return
      }
      wsRef.current = ws
      setStatus('connecting')
      log('info', `Подключение к ${url}…`)
      const startedAt = performance.now()

      ws.onopen = () => {
        if (wsRef.current !== ws) return
        setStatus('connected')
        setConnectedAt(Date.now())
        log('info', `Соединение установлено за ${Math.round(performance.now() - startedAt)} мс`)
      }

      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return
        setStats((s) => ({ ...s, received: s.received + 1 }))
        const data = typeof ev.data === 'string' ? ev.data : `[бинарные данные, ${(ev.data as Blob).size ?? '?'} байт]`
        log('recv', data)
        if (typeof ev.data !== 'string') return
        const msg = parseServerMessage(ev.data)
        if (msg) onMessageRef.current?.(msg)
      }

      ws.onerror = () => {
        if (wsRef.current !== ws) return
        // браузер не даёт подробностей об ошибке — причина будет в onclose
        log('error', 'Ошибка WebSocket')
        setStatus('error')
      }

      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return
        wsRef.current = null
        setConnectedAt(null)
        setStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'))
        log(
          ev.code === 1000 ? 'info' : 'warn',
          `Соединение закрыто: код ${ev.code} (${describeClose(ev.code)})${ev.reason ? `, причина: ${ev.reason}` : ''}`,
        )
      }
    },
    [log],
  )

  const disconnect = useCallback(() => {
    const ws = wsRef.current
    if (!ws) return
    log('info', 'Отключение по запросу пользователя')
    ws.close(1000, 'client disconnect')
  }, [log])

  /** Отправить объект как JSON. Возвращает true, если ушло в сокет. */
  const send = useCallback(
    (payload: unknown): boolean => {
      const ws = wsRef.current
      const text = JSON.stringify(payload)
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setStats((s) => ({ ...s, dropped: s.dropped + 1 }))
        log('warn', `НЕ отправлено (нет соединения): ${text}`)
        return false
      }
      ws.send(text)
      setStats((s) => ({ ...s, sent: s.sent + 1, bytesSent: s.bytesSent + text.length }))
      log('sent', text)
      return true
    },
    [log],
  )

  const resetStats = useCallback(() => setStats(EMPTY_STATS), [])

  // закрыть сокет при уходе со страницы / размонтировании
  useEffect(() => () => wsRef.current?.close(1000, 'unmount'), [])

  return { status, stats, connectedAt, connect, disconnect, send, resetStats }
}
