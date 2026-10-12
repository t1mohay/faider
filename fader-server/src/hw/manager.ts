import { log } from '../logger.js'
import { MidiParser, controlChange } from './midi.js'
import type { HwConnection, HwDevice, HwTransport } from './transport.js'

/**
 * disconnected — ничего не выбрано; connecting — открываем; connected — работаем;
 * waiting — выбранного устройства сейчас нет (выдернули, перепрошивают), подключимся, когда появится;
 * error — устройство есть, но открыть не вышло (порт занят) — пробуем снова при каждом опросе.
 */
export type HwState = 'disconnected' | 'connecting' | 'connected' | 'waiting' | 'error'

export interface HwStatus {
  devices: HwDevice[]
  selected: string | null
  state: HwState
  error?: string
}

export interface HwCallbacks {
  /** Фейдер подвинули на железе. */
  onValue: (id: number, value: number) => void
  /** Фейдер на железе взяли рукой (touched = true) или отпустили. */
  onTouch: (id: number, touched: boolean) => void
  onStatus: (status: HwStatus) => void
  /** Текущие положения — после подключения моторы встают в них. */
  currentValues: () => Iterable<[id: number, value: number]>
}

export interface HwOptions {
  /** MIDI-канал 1..16. */
  channel: number
  /** Значение с железа в пределах tolerance от отправленной цели в течение echoMs — это доехал мотор, а не рука. */
  echoMs?: number
  echoTolerance?: number
  now?: () => number
}

const MIDI_CC_MAX = 127

/**
 * Одно выбранное устройство на весь сервер. Переводит MIDI в фейдеры и обратно,
 * сам переподключается, если плату выдернули и вставили снова.
 */
export class HwManager {
  private devices: HwDevice[] = []
  private selected: string | null = null
  private state: HwState = 'disconnected'
  private error: string | undefined
  private conn: HwConnection | null = null
  private parser = new MidiParser()
  private touched = new Set<number>()
  private lastSent = new Map<number, { value: number; at: number }>()
  private queue: Promise<unknown> = Promise.resolve()
  private lastStatusJson = ''

  private readonly echoMs: number
  private readonly echoTolerance: number
  private readonly now: () => number

  constructor(
    private readonly transports: HwTransport[],
    private readonly cb: HwCallbacks,
    private readonly opts: HwOptions,
  ) {
    this.echoMs = opts.echoMs ?? 300
    this.echoTolerance = opts.echoTolerance ?? 2
    this.now = opts.now ?? Date.now
  }

  status(): HwStatus {
    return { devices: this.devices, selected: this.selected, state: this.state, error: this.error }
  }

  /** Операции открытия/закрытия идут строго по очереди — иначе быстрые клики «подключить» откроют порт дважды. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private emit() {
    const s = this.status()
    const json = JSON.stringify(s)
    if (json === this.lastStatusJson) return
    this.lastStatusJson = json
    this.cb.onStatus(s)
  }

  private transportOf(id: string): HwTransport | undefined {
    return this.transports.find((t) => (t.kind === 'sim' ? id === 'sim' : id.startsWith(`${t.kind}:`)))
  }

  /**
   * Обновить список устройств и состояние: заметить пропажу подключённого, переподключиться к выбранному.
   * full = false — опрос по таймеру: USB-MIDI перечисляем, только если выбрано MIDI-устройство
   * (RtMidi в Windows пишет в консоль предупреждение при каждом перечислении без MIDI-входов).
   */
  refresh(full = true): Promise<void> {
    return this.serial(async () => {
      const lists = await Promise.all(
        this.transports.map(async (t) => {
          const skip = !full && t.kind === 'midi' && !this.selected?.startsWith('midi:')
          if (skip) return this.devices.filter((d) => d.kind === t.kind)
          try {
            return await t.list()
          } catch (e) {
            log.warn(`Не удалось получить список (${t.kind}): ${(e as Error).message}`)
            return this.devices.filter((d) => d.kind === t.kind)
          }
        }),
      )
      this.devices = lists.flat()
      const present = this.selected !== null && this.devices.some((d) => d.id === this.selected)

      if (this.conn && !present) {
        await this.closeConn()
        this.setState('waiting', 'устройство отключено — подключусь, когда появится')
      } else if (!this.conn && this.selected && present && (this.state === 'waiting' || this.state === 'error')) {
        await this.open(this.selected)
      }
      this.emit()
    })
  }

  connect(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.selected === id && this.conn) return
      await this.closeConn()
      this.selected = id
      if (!this.devices.some((d) => d.id === id)) {
        this.setState('waiting', 'устройство не найдено — подключусь, когда появится')
        this.emit()
        return
      }
      await this.open(id)
      this.emit()
    })
  }

  disconnect(): Promise<void> {
    return this.serial(async () => {
      if (this.selected) log.info(`Устройство отключено пользователем: ${this.selected}`)
      this.selected = null
      await this.closeConn()
      this.setState('disconnected')
      this.emit()
    })
  }

  /** Фейдер изменили в интерфейсе — отправить на железо, чтобы мотор подвинул ручку. */
  sendFader(id: number, value: number) {
    if (!this.conn || id > MIDI_CC_MAX) return
    this.lastSent.set(id, { value, at: this.now() })
    this.conn.send(controlChange(this.opts.channel, id, value))
  }

  /** Опрос раз в pollMs: появление/пропажа устройств. Возвращает функцию остановки. */
  start(pollMs = 2000): () => void {
    void this.refresh(true)
    const t = setInterval(() => void this.refresh(false), pollMs)
    return () => {
      clearInterval(t)
      void this.serial(() => this.closeConn())
    }
  }

  private setState(state: HwState, error?: string) {
    if (state !== this.state || error !== this.error) {
      const name = this.selected ?? ''
      if (state === 'connected') log.ok(`Устройство подключено: ${name}`)
      else if (error) log.warn(`Устройство ${name}: ${error}`)
    }
    this.state = state
    this.error = error
  }

  private async open(id: string) {
    const transport = this.transportOf(id)
    const device = this.devices.find((d) => d.id === id)
    if (!transport || !device) {
      this.setState('error', 'неизвестное устройство')
      return
    }
    this.setState('connecting')
    this.emit()
    this.parser = new MidiParser()
    try {
      const conn = await transport.open(device, {
        onBytes: (bytes) => {
          if (this.conn === conn) this.handleBytes(bytes)
        },
        onClose: (reason) => {
          if (this.conn !== conn) return
          this.conn = null
          this.releaseTouches()
          this.setState('waiting', `${reason} — подключусь, когда появится`)
          this.emit()
        },
      })
      this.conn = conn
      this.setState('connected')
      // моторы — в текущие положения; Uno/ESP32 после открытия порта ещё перезагружаются, ждём
      setTimeout(() => {
        if (this.conn !== conn) return
        for (const [fid, value] of this.cb.currentValues()) this.sendFader(fid, value)
      }, transport.readyDelayMs ?? 0)
    } catch (e) {
      this.setState('error', (e as Error).message)
    }
  }

  private async closeConn() {
    const conn = this.conn
    this.conn = null
    this.releaseTouches()
    if (conn) await conn.close().catch(() => {})
  }

  private releaseTouches() {
    for (const id of this.touched) this.cb.onTouch(id, false)
    this.touched.clear()
  }

  private handleBytes(bytes: number[]) {
    for (const ev of this.parser.feed(bytes)) {
      if (ev.channel !== this.opts.channel) continue
      if (ev.type === 'note') {
        const id = ev.note
        if (ev.on === this.touched.has(id)) continue
        if (ev.on) this.touched.add(id)
        else this.touched.delete(id)
        this.cb.onTouch(id, ev.on)
        continue
      }
      const id = ev.controller
      const sent = this.lastSent.get(id)
      const isEcho =
        !this.touched.has(id) &&
        sent !== undefined &&
        this.now() - sent.at < this.echoMs &&
        Math.abs(ev.value - sent.value) <= this.echoTolerance
      if (!isEcho) this.cb.onValue(id, ev.value)
    }
  }
}
