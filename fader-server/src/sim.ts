import { config } from './config.js'
import { log } from './logger.js'
import { FADER_MAX, FADER_MIN } from './protocol.js'
import { state } from './state.js'
import { setFader } from './ws.js'

const STEP_MS = 20
const MOVE_MS = 600

/**
 * Имитация физического фейдера (пока нет STM32): раз в SIM_HW_MS «рука» плавно двигает
 * фейдер в случайное положение. Значения уходят всем интерфейсам с source = 'hw'.
 * Возвращает функцию остановки.
 */
export function startHwSim(): () => void {
  if (config.simHwMs <= 0) return () => {}
  const id = config.simHwId
  let moveTimer: NodeJS.Timeout | null = null

  const move = () => {
    if (moveTimer) return
    const from = state.faders.get(id)?.value ?? 0
    const to = FADER_MIN + Math.floor(Math.random() * (FADER_MAX - FADER_MIN + 1))
    log.info(`ЖЕЛЕЗО (имитация): fader#${id} ${from} → ${to}`)
    const started = Date.now()
    let last = from
    moveTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / MOVE_MS)
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const v = Math.round(from + (to - from) * eased)
      if (v !== last) {
        last = v
        setFader(id, v, 'hw')
      }
      if (t >= 1) {
        clearInterval(moveTimer!)
        moveTimer = null
      }
    }, STEP_MS)
  }

  log.info(`Имитация физического фейдера включена: fader#${id}, раз в ${config.simHwMs} мс`)
  const every = setInterval(move, config.simHwMs)
  return () => {
    clearInterval(every)
    if (moveTimer) clearInterval(moveTimer)
  }
}
