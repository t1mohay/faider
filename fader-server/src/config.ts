/** Настройки через переменные окружения. Пример: PORT=9000 LATENCY_MS=50 npm run dev */

function num(name: string, def: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : def
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return def
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase())
}

export const config = {
  /** Порт HTTP и WebSocket (общий). Фронт по умолчанию стучится в ws://localhost:8765 */
  port: num('PORT', 8765),
  /** Хост: 0.0.0.0 — доступно из локальной сети (телефон, другой ноут). */
  host: process.env.HOST ?? '0.0.0.0',
  /** Отвечать ли клиенту подтверждением на каждое сообщение. */
  ack: bool('ACK', true),
  /** Искусственная задержка ответа, мс — проверить, как фронт ведёт себя на «медленном» сервере. */
  latencyMs: num('LATENCY_MS', 0),
  /** Печатать в консоль каждое сообщение (при 0 — только сводку раз в секунду). */
  logEach: bool('LOG_EACH', true),
  /** Сколько последних сообщений хранить для GET /api/history. */
  historySize: num('HISTORY_SIZE', 500),
  /**
   * Устройство, к которому подключиться при запуске: 'serial:COM3', 'midi:Arduino Leonardo', 'sim'.
   * Пусто — ждать выбора в интерфейсе. SIM_HW_MS > 0 без HW_DEVICE — как раньше, сразу имитация.
   */
  hwDevice: process.env.HW_DEVICE || (num('SIM_HW_MS', 0) > 0 ? 'sim' : ''),
  /** Скорость COM-порта — как в Serial.begin() прошивки. */
  hwBaud: num('HW_BAUD', 115200),
  /** MIDI-канал платы, 1..16. */
  midiChannel: Math.min(16, Math.max(1, num('MIDI_CHANNEL', 1))),
  /** Имитация физического фейдера: раз в столько мс «рука» двигает его в случайное положение. */
  simHwMs: num('SIM_HW_MS', 0) > 0 ? num('SIM_HW_MS', 0) : 3000,
  /**
   * Короткий захват, мс: кнопки и клавиатура (а также физический фейдер) занимают фейдер на это время
   * после последнего изменения. Захват ручкой (grab) держится, пока её не отпустят.
   */
  lockMs: num('LOCK_MS', 500),
  /** Какой фейдер двигает имитация. */
  simHwId: num('SIM_HW_ID', 1),
}
