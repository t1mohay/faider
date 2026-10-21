import { useCallback, useEffect, useRef, useState } from 'react'
import { parseServerMessage } from '../lib/protocol'
import type { ServerMessage } from '../lib/protocol'
import type { Logger } from './useLogger'

/** reconnecting — связь пропала не по кнопке «Отключить», ждём следующую попытку или пробуем подключиться. */
export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** Плановая попытка переподключения: номер и когда будет (Date.now()). */
export interface RetryInfo {
  attempt: number
  at: number
}

/** Паузы между попытками, мс: растут, чтобы не долбить недоступный сервер; дальше — каждые 10 с. */
const RETRY_DELAYS = [1000, 2000, 5000, 10000]

export interface WsStats {
  sent: number
  received: number
  /** Сообщения, которые не ушли, потому что соединения не было. */
  dropped: number
  bytesSent: number
}

const EMPTY_STATS: WsStats = { sent: 0, received: 0, dropped: 0, bytesSent: 0 }
/** Счётчики считаются на каждое сообщение, а на экран попадают раз в столько мс — без перерисовки на каждое. */
const STATS_FLUSH_MS = 250

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
  const statsRef = useRef<WsStats>({ ...EMPTY_STATS })
  const statsTimerRef = useRef<number | null>(null)
  /** Изменить счётчики; на экран — пачкой, см. STATS_FLUSH_MS. */
  const bumpStats = useCallback((patch: (s: WsStats) => void) => {
    patch(statsRef.current)
    if (statsTimerRef.current !== null) return
    statsTimerRef.current = window.setTimeout(() => {
      statsTimerRef.current = null
      setStats({ ...statsRef.current })
    }, STATS_FLUSH_MS)
  }, [])
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [retry, setRetry] = useState<RetryInfo | null>(null)

  /** Пользователь хочет быть на связи: нажал «Подключить» и не нажимал «Отключить». */
  const wantedRef = useRef(false)
  const urlRef = useRef('')
  /** Номер текущей попытки переподключения; 0 — обычное подключение. */
  const attemptRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  // open и scheduleRetry вызывают друг друга — разрываем круг через ref
  const openRef = useRef<() => void>(() => {})

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }, [])

  const scheduleRetry = useCallback(() => {
    const attempt = attemptRef.current + 1
    attemptRef.current = attempt
    const delay = RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)]
    setStatus('reconnecting')
    setRetry({ attempt, at: Date.now() + delay })
    clearRetryTimer()
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null
      openRef.current()
    }, delay)
    return delay
  }, [clearRetryTimer])

  const open = useCallback(() => {
    const url = urlRef.current
    const isRetry = attemptRef.current > 0
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      // например, неверный адрес (без ws:// или wss://) — повторять бессмысленно
      log('error', `Не удалось создать WebSocket: ${(e as Error).message}`)
      wantedRef.current = false
      attemptRef.current = 0
      setRetry(null)
      setStatus('error')
      return
    }
    wsRef.current = ws
    setStatus(isRetry ? 'reconnecting' : 'connecting')
    log('info', isRetry ? `Переподключение к ${url} (попытка ${attemptRef.current})…` : `Подключение к ${url}…`)
    const startedAt = performance.now()
    let opened = false

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      opened = true
      attemptRef.current = 0
      setRetry(null)
      setStatus('connected')
      setConnectedAt(Date.now())
      log(
        'info',
        `Соединение ${isRetry ? 'восстановлено' : 'установлено'} за ${Math.round(performance.now() - startedAt)} мс`,
      )
    }

    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return
      bumpStats((s) => {
        s.received++
      })
      if (typeof ev.data !== 'string') {
        log('recv', `[бинарные данные, ${(ev.data as Blob).size ?? '?'} байт]`)
        return
      }
      const msg = parseServerMessage(ev.data)
      // state и ack идут потоком, пока двигают фейдер — в лог только в «подробном» режиме
      log('recv', ev.data, { routine: msg?.type === 'state' || msg?.type === 'ack' })
      if (msg) onMessageRef.current?.(msg)
    }

    ws.onerror = () => {
      if (wsRef.current !== ws) return
      // браузер не даёт подробностей об ошибке — причина будет в onclose; неудачные повторы не шумят
      if (!isRetry || opened) log('error', 'Ошибка WebSocket')
    }

    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return
      wsRef.current = null
      setConnectedAt(null)
      if (wantedRef.current) {
        const delay = scheduleRetry()
        const reason = `код ${ev.code} (${describeClose(ev.code)})`
        const next = `через ${delay / 1000} с`
        let text: string
        if (opened) text = `Связь потеряна: ${reason}. Переподключение ${next}`
        else if (isRetry) text = `Попытка не удалась, следующая ${next}`
        else text = `Не удалось подключиться: ${reason}. Повтор ${next}`
        log('warn', text)
        return
      }
      // сюда попадаем только после «Отключить»: если в этот момент шла попытка подключения,
      // браузер закрывает сокет с кодом 1006 — это не ошибка, отключились мы сами
      setStatus('disconnected')
      log('info', opened ? `Соединение закрыто: код ${ev.code}` : 'Попытка подключения прервана')
    }
  }, [log, scheduleRetry, bumpStats])
  openRef.current = open

  const connect = useCallback(
    (url: string) => {
      if (wsRef.current) {
        log('warn', 'Уже есть соединение — сначала отключитесь')
        return
      }
      wantedRef.current = true
      urlRef.current = url
      attemptRef.current = 0
      clearRetryTimer()
      setRetry(null)
      open()
    },
    [log, open, clearRetryTimer],
  )

  const disconnect = useCallback(() => {
    wantedRef.current = false
    attemptRef.current = 0
    clearRetryTimer()
    setRetry(null)
    const ws = wsRef.current
    if (ws) {
      log('info', 'Отключение по запросу пользователя')
      ws.close(1000, 'client disconnect')
    } else {
      // сокета нет — ждали паузу перед следующей попыткой
      setStatus('disconnected')
      log('info', 'Переподключение отменено')
    }
  }, [log, clearRetryTimer])

  /** Не ждать паузу — попробовать переподключиться прямо сейчас. */
  const retryNow = useCallback(() => {
    if (!wantedRef.current || wsRef.current || retryTimerRef.current === null) return
    clearRetryTimer()
    open()
  }, [open, clearRetryTimer])

  // Телефон: вернулась сеть или снова открыли вкладку (экран засыпал) — пробуем сразу, без паузы
  useEffect(() => {
    const onOnline = () => retryNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') retryNow()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [retryNow])

  /** Отправить объект как JSON. Возвращает true, если ушло в сокет. */
  const send = useCallback(
    (payload: unknown): boolean => {
      const ws = wsRef.current
      const text = JSON.stringify(payload)
      // значения фейдера идут потоком — в лог только в «подробном» режиме
      const routine = (payload as { type?: unknown } | null)?.type === 'fader'
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        bumpStats((s) => {
          s.dropped++
        })
        log('warn', `НЕ отправлено (нет соединения): ${text}`, { routine })
        return false
      }
      ws.send(text)
      bumpStats((s) => {
        s.sent++
        s.bytesSent += text.length
      })
      log('sent', text, { routine })
      return true
    },
    [log, bumpStats],
  )

  const resetStats = useCallback(() => {
    statsRef.current = { ...EMPTY_STATS }
    setStats({ ...EMPTY_STATS })
  }, [])

  // закрыть сокет при уходе со страницы / размонтировании и не переподключаться
  useEffect(
    () => () => {
      wantedRef.current = false
      clearRetryTimer()
      if (statsTimerRef.current !== null) clearTimeout(statsTimerRef.current)
      wsRef.current?.close(1000, 'unmount')
    },
    [clearRetryTimer],
  )

  return { status, stats, connectedAt, retry, connect, disconnect, retryNow, send, resetStats }
}
