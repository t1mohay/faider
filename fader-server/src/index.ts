import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { config } from './config.js'
import { HwManager } from './hw/manager.js'
import { serialTransport } from './hw/serial.js'
import { simTransport } from './hw/sim.js'
import { usbMidiTransport } from './hw/usbmidi.js'
import { createApp } from './http.js'
import { log } from './logger.js'
import { state } from './state.js'
import { attachWebSocket, broadcastHwStatus, setFader, setHwTouch } from './ws.js'

const hw = new HwManager(
  [
    serialTransport(config.hwBaud),
    usbMidiTransport(),
    simTransport({ everyMs: config.simHwMs, faderId: config.simHwId, channel: config.midiChannel }),
  ],
  {
    onValue: (id, value) => setFader(id, value, 'hw'),
    onTouch: setHwTouch,
    onStatus: broadcastHwStatus,
    currentValues: () => [...state.faders.values()].map((f) => [f.id, f.value] as [number, number]),
  },
  { channel: config.midiChannel },
)

const app = createApp()
// Express и WebSocket живут на одном HTTP-сервере и одном порту
const server = createServer(app)
const wss = attachWebSocket(server, hw)
const stopHw = hw.start()
if (config.hwDevice) void hw.connect(config.hwDevice)

/** IPv4-адреса в локальной сети — чтобы подключиться с телефона. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address)
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log.error(`Порт ${config.port} занят. Запустите с другим: PORT=8766 npm run dev`)
  else log.error(err.message)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  log.ok(`fader-server запущен`)
  log.info(`WebSocket:  ws://localhost:${config.port}`)
  log.info(`Статус:     http://localhost:${config.port}`)
  for (const ip of lanAddresses()) log.info(`В сети:     ws://${ip}:${config.port}`)
  log.info(
    `ACK=${config.ack ? 'on' : 'off'}  LATENCY_MS=${config.latencyMs}  LOG_EACH=${config.logEach ? 'on' : 'off'}  ` +
      `LOCK_MS=${config.lockMs}  MIDI_CHANNEL=${config.midiChannel}  HW_BAUD=${config.hwBaud}  ` +
      `HW_DEVICE=${config.hwDevice || '—'}`,
  )
})

function shutdown() {
  log.info(`Остановка… Всего принято ${state.totals.received}, ошибок ${state.totals.invalid}`)
  stopHw()
  for (const ws of wss.clients) ws.close(1001, 'server shutdown')
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
