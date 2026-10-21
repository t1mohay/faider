import { useCallback, useEffect, useRef, useState } from 'react'
import { DevicePanel } from './components/DevicePanel'
import { PhonePanel } from './components/PhonePanel'
import { Fader } from './components/Fader'
import { LogPanel } from './components/LogPanel'
import { StatusPanel } from './components/StatusPanel'
import { useLogger } from './hooks/useLogger'
import { useWebSocket } from './hooks/useWebSocket'
import { FADER_MAX, clampFader, makeFaderMessage } from './lib/protocol'
import type { FaderSource, HwStatusMessage, LockOwner, ServerMessage, StateMessage } from './lib/protocol'
import type { RttStats } from './components/StatusPanel'
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

function describeOwner(owner: Exclude<LockOwner, null>): string {
  return owner === 'hw' ? 'физический фейдер' : `другой интерфейс (клиент #${owner})`
}

/** За какое время считаем средний и максимальный отклик. */
const RTT_WINDOW_MS = 5000

export default function App() {
  const { entries, log, clear, verbose, setVerbose } = useLogger()
  const [myClientId, setMyClientId] = useState<number | null>(null)
  const [lastChange, setLastChange] = useState<LastChange | null>(null)
  /** Кто сейчас управляет выбранным фейдером (захват на сервере). */
  const [owner, setOwner] = useState<LockOwner>(null)
  /** Физическое устройство на сервере; null — пока нет соединения. */
  const [hwStatus, setHwStatus] = useState<HwStatusMessage | null>(null)
  /** Пока пользователь держит ручку, значения с сервера её не двигают — иначе она прыгает под пальцем. */
  const draggingRef = useRef(false)
  // refs объявлены до useWebSocket — они нужны обработчику входящих сообщений
  const lastSentValueRef = useRef<number | null>(null)
  const settingsRef = useRef<Settings | null>(null)
  const myClientIdRef = useRef<number | null>(null)
  /** Захваты всех фейдеров — чтобы при смене «ID фейдера» сразу знать, занят ли он. */
  const locksRef = useRef(new Map<number, Exclude<LockOwner, null>>())
  const pendingRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const wsSendRef = useRef<((payload: unknown) => boolean) | null>(null)
  /** seq → когда отправили (performance.now). Ответ ack с тем же seq даёт отклик «туда-обратно». */
  const sentAtRef = useRef(new Map<number, number>())
  /** Замеры отклика за последние RTT_WINDOW_MS. */
  const rttSamplesRef = useRef<{ at: number; ms: number }[]>([])
  /** Последний пришедший state; применяется раз за кадр — промежуточные рисовать незачем. */
  const incomingRef = useRef<StateMessage | null>(null)
  const frameRef = useRef<number | null>(null)

  /** Отменить отложенную (троттлинг) отправку. */
  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    pendingRef.current = null
  }, [])

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      if (msg.type === 'hello') {
        setMyClientId(msg.clientId)
        myClientIdRef.current = msg.clientId
        locksRef.current.clear()
        setOwner(null)
        return
      }
      if (msg.type === 'hw-status') {
        setHwStatus(msg)
        return
      }
      if (msg.type === 'lock') {
        if (msg.owner === null) locksRef.current.delete(msg.id)
        else locksRef.current.set(msg.id, msg.owner)
        if (msg.id !== settingsRef.current?.faderId) return
        setOwner(msg.owner)
        const me = myClientIdRef.current
        if (msg.owner !== null && msg.owner !== me && draggingRef.current) {
          // кто-то взял фейдер раньше нас (или двинули железо) — бросаем ручку, следом придёт state с его значением
          draggingRef.current = false
          cancelPending()
          log('warn', `Фейдер занят: ${describeOwner(msg.owner)} — движение прервано`)
        }
        if (msg.owner === me && msg.held && !draggingRef.current) {
          // захват пришёл, когда ручку уже отпустили или движение прервали — отдаём фейдер обратно
          wsSendRef.current?.({ type: 'release', id: msg.id })
        }
        return
      }
      if (msg.type === 'ack') {
        const sentAt = sentAtRef.current.get(msg.seq)
        if (sentAt === undefined) return
        sentAtRef.current.delete(msg.seq)
        const now = performance.now()
        rttSamplesRef.current.push({ at: now, ms: now - sentAt })
        return
      }
      if (msg.id !== settingsRef.current?.faderId) return
      // Значения приходят десятками в секунду, а экран обновляется раз в кадр: копим последнее
      // и применяем перед отрисовкой. Во фоновой вкладке кадров нет — применится, когда её откроют.
      incomingRef.current = msg
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        const m = incomingRef.current
        incomingRef.current = null
        // за кадр могли сменить «ID фейдера» или взять ручку
        if (!m || m.id !== settingsRef.current?.faderId || draggingRef.current) return
        setValue(m.value)
        // чтобы следующее движение ручкой не посчиталось «тем же значением» и ушло на сервер
        lastSentValueRef.current = m.value
        setLastChange({ source: m.source, by: m.by })
      })
    },
    [log, cancelPending],
  )

  const ws = useWebSocket(log, handleServerMessage)
  wsSendRef.current = ws.send

  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [value, setValue] = useState(0)
  const [lastSent, setLastSent] = useState<number | null>(null)
  const [seq, setSeq] = useState(0)
  const [rate, setRate] = useState(0)
  const [rtt, setRtt] = useState<RttStats | null>(null)
  const [manual, setManual] = useState('64')

  settingsRef.current = settings

  // refs для троттлинга — чтобы не зависеть от перерисовок
  const seqRef = useRef(0)
  const lastSendTimeRef = useRef(0)
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

  // счётчик сообщений в секунду и отклик — на экран 4 раза в секунду, а не на каждое сообщение
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now()
      const cutoff = now - 1000
      sendTimesRef.current = sendTimesRef.current.filter((x) => x > cutoff)
      setRate(sendTimesRef.current.length)

      const rttCutoff = now - RTT_WINDOW_MS
      const samples = (rttSamplesRef.current = rttSamplesRef.current.filter((s) => s.at > rttCutoff))
      // без ответа дольше окна — сервер отклонил (фейдер занят) или ответ потерялся; не копим
      for (const [seq, at] of sentAtRef.current) if (at < rttCutoff) sentAtRef.current.delete(seq)
      if (samples.length === 0) {
        setRtt(null)
        return
      }
      const next: RttStats = {
        last: Math.round(samples[samples.length - 1].ms),
        avg: Math.round(samples.reduce((sum, s) => sum + s.ms, 0) / samples.length),
        max: Math.round(Math.max(...samples.map((s) => s.ms))),
      }
      setRtt((prev) => (prev && prev.last === next.last && prev.avg === next.avg && prev.max === next.max ? prev : next))
    }, 250)
    return () => clearInterval(t)
  }, [])

  const sendValue = useCallback(
    (v: number, force = false) => {
      if (!force && lastSentValueRef.current === v) return // не дублируем одно и то же значение
      seqRef.current += 1
      const sentAt = performance.now()
      const ok = ws.send(makeFaderMessage(settings.faderId, v, seqRef.current))
      if (ok) sentAtRef.current.set(seqRef.current, sentAt)
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
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  const lockedByOther = owner !== null && owner !== myClientId

  const handleChange = (v: number) => {
    setValue(v)
    setLastChange({ source: 'me' })
    scheduleSend(v)
  }

  const setExact = (v: number) => {
    if (lockedByOther) return
    const c = clampFader(v)
    setValue(c)
    setLastChange({ source: 'me' })
    sendValue(c, true)
  }

  // переключили «ID фейдера» — показать, занят ли он
  useEffect(() => {
    setOwner(locksRef.current.get(settings.faderId) ?? null)
  }, [settings.faderId])

  // после отключения номер клиента, захват и «кто двигал» больше не актуальны
  useEffect(() => {
    if (ws.status !== 'connected') {
      setMyClientId(null)
      myClientIdRef.current = null
      setOwner(null)
      setHwStatus(null)
      setLastChange(null)
      // ответы на отправленное до обрыва уже не придут
      sentAtRef.current.clear()
      rttSamplesRef.current = []
      setRtt(null)
    }
  }, [ws.status])

  const resetStats = () => {
    ws.resetStats()
    seqRef.current = 0
    setSeq(0)
    sendTimesRef.current = []
    // seq начинается заново — старые ожидания ack перепутались бы с новыми
    sentAtRef.current.clear()
    rttSamplesRef.current = []
    setRtt(null)
    log('info', 'Счётчики сброшены')
  }

  const isConnected = ws.status === 'connected'
  const isReconnecting = ws.status === 'reconnecting'
  // «занят» — есть соединение или мы его добиваемся; кнопка тогда «Отключить»
  const isBusy = ws.status === 'connecting' || isReconnecting || isConnected

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
            disabled={lockedByOther}
            onChange={handleChange}
            onGrab={() => {
              draggingRef.current = true
              // без соединения захватывать нечего — не шумим в логе «НЕ отправлено»
              if (isConnected) ws.send({ type: 'grab', id: settings.faderId })
            }}
            onRelease={(v) => {
              // последнее значение должно уйти до release, иначе оно опоздает и отбросится как «не по захвату»
              const p = pendingRef.current
              cancelPending()
              if (p !== null) sendValue(p)
              draggingRef.current = false
              if (isConnected) ws.send({ type: 'release', id: settings.faderId })
              log('info', `Фейдер отпущен на ${v}`)
            }}
          />
          {isReconnecting && <p className="hint">Связь потеряна — переподключаемся, значения пока не отправляются</p>}
          {!isConnected && !isReconnecting && (
            <p className="hint">Нет соединения — значения не отправляются (видно в логах)</p>
          )}
          {isConnected && lockedByOther && <p className="hint">Сейчас управляет: {describeOwner(owner)}</p>}
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
            retry={ws.retry}
            onRetryNow={ws.retryNow}
            rate={rate}
            rtt={rtt}
            lastSent={lastSent}
            seq={seq}
            onResetStats={resetStats}
          />

          <DevicePanel
            status={isConnected ? hwStatus : null}
            onRefresh={() => ws.send({ type: 'hw-list' })}
            onConnect={(device) => ws.send({ type: 'hw-connect', device })}
            onDisconnect={() => ws.send({ type: 'hw-disconnect' })}
          />

          {/* QR нужен только на самом ПК — на телефоне страница уже открыта */}
          {LOCAL_HOSTS.includes(location.hostname) && <PhonePanel />}

          <section className="panel controls">
            <h2>Тестовые действия</h2>
            <div className="row">
              <button disabled={lockedByOther} onClick={() => setExact(0)}>0</button>
              <button disabled={lockedByOther} onClick={() => setExact(64)}>64</button>
              <button disabled={lockedByOther} onClick={() => setExact(FADER_MAX)}>127</button>
              <input
                type="number"
                min={0}
                max={FADER_MAX}
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                className="num"
              />
              <button disabled={lockedByOther} onClick={() => setExact(Number(manual) || 0)}>Отправить</button>
              <button disabled={lockedByOther} onClick={() => sendValue(value, true)} title="Повторно отправить текущее значение">
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

        <LogPanel entries={entries} onClear={clear} verbose={verbose} onVerboseChange={setVerbose} />
      </main>
    </div>
  )
}
