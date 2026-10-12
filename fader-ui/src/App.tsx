import { useCallback, useEffect, useRef, useState } from 'react'
import { Fader } from './components/Fader'
import { LogPanel } from './components/LogPanel'
import { StatusPanel } from './components/StatusPanel'
import { useLogger } from './hooks/useLogger'
import { useWebSocket } from './hooks/useWebSocket'
import { FADER_MAX, clampFader, makeFaderMessage } from './lib/protocol'
import type { FaderSource, ServerMessage } from './lib/protocol'
import './App.css'

interface Settings {
  url: string
  faderId: number
  /** Минимальный интервал между отправками, мс. 0 — слать каждое изменение. */
  throttleMs: number
}

const SETTINGS_KEY = 'fader-ui:settings'
const SERVER_PORT = 8765
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/**
 * Сервер на том же компьютере, что отдал страницу: открыли http://192.168.1.42:5173 на телефоне —
 * подключаемся к ws://192.168.1.42:8765. Так по Wi-Fi ничего не надо вводить руками.
 */
function defaultUrl(): string {
  const host = location.hostname || 'localhost'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${host.includes(':') ? `[${host}]` : host}:${SERVER_PORT}`
}

function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

const DEFAULT_SETTINGS: Settings = {
  url: import.meta.env.VITE_WS_URL || defaultUrl(),
  faderId: 1,
  throttleMs: 20,
}

let startupLogged = false

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const s: Settings = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
    // сохранённый localhost на устройстве, открытом по IP, указывает на само устройство, а не на ПК
    if (isLocalUrl(s.url) && !LOCAL_HOSTS.includes(location.hostname)) s.url = defaultUrl()
    return s
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Кто последним подвинул фейдер — показывается под фейдером. */
interface LastChange {
  source: FaderSource | 'me'
  by?: number
}

function describeChange(c: LastChange): string {
  if (c.source === 'me') return 'вы'
  if (c.source === 'hw') return 'физический фейдер'
  return c.by !== undefined ? `другой интерфейс (клиент #${c.by})` : 'другой интерфейс'
}

export default function App() {
  const { entries, log, clear } = useLogger()
  const [myClientId, setMyClientId] = useState<number | null>(null)
  const [lastChange, setLastChange] = useState<LastChange | null>(null)
  /** Пока пользователь держит ручку, значения с сервера её не двигают — иначе она прыгает под пальцем. */
  const draggingRef = useRef(false)
  // объявлен до useWebSocket, а заполняется ниже — в обработчике нужны refs троттлинга
  const lastSentValueRef = useRef<number | null>(null)
  const settingsRef = useRef<Settings | null>(null)

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === 'hello') {
      setMyClientId(msg.clientId)
      return
    }
    if (msg.id !== settingsRef.current?.faderId) return
    if (draggingRef.current) return
    setValue(msg.value)
    // чтобы следующее движение ручкой не посчиталось «тем же значением» и ушло на сервер
    lastSentValueRef.current = msg.value
    setLastChange({ source: msg.source, by: msg.by })
  }, [])

  const ws = useWebSocket(log, handleServerMessage)

  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [value, setValue] = useState(0)
  const [lastSent, setLastSent] = useState<number | null>(null)
  const [seq, setSeq] = useState(0)
  const [rate, setRate] = useState(0)
  const [manual, setManual] = useState('64')

  settingsRef.current = settings

  // refs для троттлинга — чтобы не зависеть от перерисовок
  const seqRef = useRef(0)
  const lastSendTimeRef = useRef(0)
  const pendingRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const sendTimesRef = useRef<number[]>([])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* localStorage может быть недоступен — не критично */
    }
  }, [settings])

  useEffect(() => {
    // флаг на уровне модуля: в dev StrictMode эффекты запускаются дважды
    if (startupLogged) return
    startupLogged = true
    log('info', 'Интерфейс запущен. Нажмите «Подключить», чтобы соединиться с сервером.')
  }, [log])

  // счётчик сообщений в секунду
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = performance.now() - 1000
      sendTimesRef.current = sendTimesRef.current.filter((x) => x > cutoff)
      setRate(sendTimesRef.current.length)
    }, 250)
    return () => clearInterval(t)
  }, [])

  const sendValue = useCallback(
    (v: number, force = false) => {
      if (!force && lastSentValueRef.current === v) return // не дублируем одно и то же значение
      seqRef.current += 1
      const ok = ws.send(makeFaderMessage(settings.faderId, v, seqRef.current))
      setSeq(seqRef.current)
      lastSendTimeRef.current = performance.now()
      if (ok) {
        lastSentValueRef.current = v
        setLastSent(v)
        sendTimesRef.current.push(performance.now())
      }
    },
    [ws.send, settings.faderId],
  )

  /** Отправка с ограничением частоты: первое — сразу, дальше не чаще throttleMs, последнее значение всегда уходит. */
  const scheduleSend = useCallback(
    (v: number) => {
      const wait = settings.throttleMs - (performance.now() - lastSendTimeRef.current)
      if (wait <= 0) {
        sendValue(v)
        return
      }
      pendingRef.current = v
      if (timerRef.current !== null) return
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        if (pendingRef.current !== null) {
          const p = pendingRef.current
          pendingRef.current = null
          sendValue(p)
        }
      }, wait)
    },
    [settings.throttleMs, sendValue],
  )

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])

  const handleChange = (v: number) => {
    setValue(v)
    setLastChange({ source: 'me' })
    scheduleSend(v)
  }

  const setExact = (v: number) => {
    const c = clampFader(v)
    setValue(c)
    setLastChange({ source: 'me' })
    sendValue(c, true)
  }

  // после отключения номер клиента и «кто двигал» больше не актуальны
  useEffect(() => {
    if (ws.status !== 'connected') {
      setMyClientId(null)
      setLastChange(null)
    }
  }, [ws.status])

  const resetStats = () => {
    ws.resetStats()
    seqRef.current = 0
    setSeq(0)
    sendTimesRef.current = []
    log('info', 'Счётчики сброшены')
  }

  const isConnected = ws.status === 'connected'
  const isBusy = ws.status === 'connecting' || isConnected

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Fader UI <span className="muted">· прототип</span>
        </h1>
        <form
          className="conn"
          onSubmit={(e) => {
            e.preventDefault()
            if (isBusy) ws.disconnect()
            else ws.connect(settings.url.trim())
          }}
        >
          <input
            className="conn__url"
            value={settings.url}
            disabled={isBusy}
            onChange={(e) => setSettings((s) => ({ ...s, url: e.target.value }))}
            placeholder="ws://host:port"
            spellCheck={false}
          />
          <button type="submit" className={isBusy ? 'danger' : 'primary'}>
            {isBusy ? 'Отключить' : 'Подключить'}
          </button>
        </form>
      </header>

      <main className="layout">
        <section className="panel fader-panel">
          <Fader
            label={`Фейдер #${settings.faderId}`}
            value={value}
            onChange={handleChange}
            onGrab={() => {
              draggingRef.current = true
            }}
            onRelease={(v) => {
              draggingRef.current = false
              log('info', `Фейдер отпущен на ${v}`)
            }}
          />
          {!isConnected && <p className="hint">Нет соединения — значения не отправляются (видно в логах)</p>}
          {isConnected && (
            <p className="muted small">
              {lastChange ? `Последним двигал: ${describeChange(lastChange)}` : 'Фейдер ещё никто не двигал'}
              {myClientId !== null && <> · вы клиент #{myClientId}</>}
            </p>
          )}
        </section>

        <div className="side">
          <StatusPanel
            status={ws.status}
            stats={ws.stats}
            connectedAt={ws.connectedAt}
            rate={rate}
            lastSent={lastSent}
            seq={seq}
            onResetStats={resetStats}
          />

          <section className="panel controls">
            <h2>Тестовые действия</h2>
            <div className="row">
              <button onClick={() => setExact(0)}>0</button>
              <button onClick={() => setExact(64)}>64</button>
              <button onClick={() => setExact(FADER_MAX)}>127</button>
              <input
                type="number"
                min={0}
                max={FADER_MAX}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                className="num"
              />
              <button onClick={() => setExact(Number(manual) || 0)}>Отправить</button>
              <button onClick={() => sendValue(value, true)} title="Повторно отправить текущее значение">
                Повторить
              </button>
            </div>

            <h2>Настройки</h2>
            <div className="row">
              <label className="field">
                ID фейдера
                <input
                  type="number"
                  min={0}
                  className="num"
                  value={settings.faderId}
                  onChange={(e) => setSettings((s) => ({ ...s, faderId: Math.max(0, Number(e.target.value) || 0) }))}
                />
              </label>
              <label className="field">
                Интервал отправки, мс
                <input
                  type="number"
                  min={0}
                  step={5}
                  className="num"
                  value={settings.throttleMs}
                  onChange={(e) => setSettings((s) => ({ ...s, throttleMs: Math.max(0, Number(e.target.value) || 0) }))}
                />
              </label>
            </div>
            <p className="muted small">
              Формат сообщения: <code>{'{"type":"fader","id":1,"value":0..127,"seq":N,"ts":ms}'}</code>
            </p>
          </section>
        </div>

        <LogPanel entries={entries} onClear={clear} />
      </main>
    </div>
  )
}
