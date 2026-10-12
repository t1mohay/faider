import { FADER_MAX, FADER_MIN } from '../protocol.js'
import { MidiParser, controlChange, touchNote } from './midi.js'
import type { HwTransport } from './transport.js'

const STEP_MS = 20
const MOVE_MS = 600

export interface SimOptions {
  /** Раз в столько мс «рука» берёт фейдер и плавно ведёт в случайное положение. */
  everyMs: number
  /** Какой фейдер двигает (номер CC и ноты касания). */
  faderId: number
  channel: number
}

/**
 * Имитация платы (пока нет железа): ведёт себя как прошивка из firmware/ — касание (Note On),
 * плавное движение (CC), отпускание (Note Off). Присланные CC «мотор» отрабатывает молча, не отвечая эхом.
 */
export function simTransport(opts: SimOptions): HwTransport {
  return {
    kind: 'sim',

    async list() {
      return [
        {
          id: 'sim',
          kind: 'sim',
          name: 'Имитация физического фейдера',
          detail: `fader#${opts.faderId}, раз в ${opts.everyMs} мс`,
        },
      ]
    },

    async open(_device, { onBytes }) {
      const { faderId: id, channel } = opts
      const parser = new MidiParser()
      let position = 0
      let moveTimer: NodeJS.Timeout | null = null

      const move = () => {
        if (moveTimer) return
        const from = position
        const to = FADER_MIN + Math.floor(Math.random() * (FADER_MAX - FADER_MIN + 1))
        const started = Date.now()
        onBytes(touchNote(channel, id, true))
        moveTimer = setInterval(() => {
          const t = Math.min(1, (Date.now() - started) / MOVE_MS)
          const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
          const v = Math.round(from + (to - from) * eased)
          if (v !== position) {
            position = v
            onBytes(controlChange(channel, id, v))
          }
          if (t >= 1) {
            clearInterval(moveTimer!)
            moveTimer = null
            onBytes(touchNote(channel, id, false))
          }
        }, STEP_MS)
      }
      const every = setInterval(move, opts.everyMs)

      return {
        send: (bytes) => {
          // «мотор»: встаём в присланное положение, если рука фейдер сейчас не держит
          for (const ev of parser.feed(bytes)) {
            if (ev.type === 'cc' && ev.channel === channel && ev.controller === id && !moveTimer) position = ev.value
          }
        },
        close: async () => {
          clearInterval(every)
          if (moveTimer) clearInterval(moveTimer)
        },
      }
    },
  }
}
