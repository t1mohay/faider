import { SerialPort } from 'serialport'
import type { HwDevice, HwTransport } from './transport.js'

/** По USB VID видно, что за мост стоит на плате, — подсказка в списке, чтобы не гадать, какой из COM-портов нужный. */
const KNOWN_VIDS: Record<string, string> = {
  '2341': 'Arduino',
  '2a03': 'Arduino',
  '1a86': 'CH340 — Arduino Nano/Uno-клон или ESP32',
  '10c4': 'CP210x — скорее всего ESP32',
  '0403': 'FTDI',
  '303a': 'Espressif — ESP32-S2/S3/C3',
  '1b4f': 'SparkFun Pro Micro',
}

/** Ошибки Windows/Linux — в то, что понятно человеку. */
function explain(err: Error, path: string): string {
  const m = err.message
  if (/access denied|permission denied|EACCES|EBUSY/i.test(m)) {
    return `${path} занят другой программой (Arduino IDE, монитор порта?) или нет прав`
  }
  if (/file not found|cannot find|ENOENT|no such file/i.test(m)) return `${path} не найден — плата отключена?`
  return `${path}: ${m}`
}

/**
 * Плата без USB-MIDI (Uno, Nano, Mega, обычный ESP32) шлёт MIDI-байты прямо в Serial.
 * baudRate должен совпадать с Serial.begin() в прошивке.
 */
export function serialTransport(baudRate: number): HwTransport {
  return {
    kind: 'serial',
    // Uno/Nano и ESP32 перезагружаются при открытии порта — первые ~1.5 с они ничего не принимают
    readyDelayMs: 2000,

    async list(): Promise<HwDevice[]> {
      const ports = await SerialPort.list()
      return ports.map((p) => {
        const known = p.vendorId ? KNOWN_VIDS[p.vendorId.toLowerCase()] : undefined
        const detail = [p.manufacturer, known].filter(Boolean).join(' · ')
        return { id: `serial:${p.path}`, kind: 'serial', name: p.path, detail: detail || undefined }
      })
    },

    open(device, { onBytes, onClose }) {
      const path = device.id.slice('serial:'.length)
      const port = new SerialPort({ path, baudRate, autoOpen: false })
      let closing = false
      return new Promise((resolve, reject) => {
        port.open((err) => {
          if (err) return reject(new Error(explain(err, path)))
          port.on('data', (buf: Buffer) => onBytes([...buf]))
          port.on('close', (e?: Error & { disconnected?: boolean }) => {
            if (!closing) onClose(e?.disconnected ? `${path} отключён` : `${path} закрыт`)
          })
          port.on('error', (e: Error) => {
            if (!closing) onClose(explain(e, path))
          })
          resolve({
            send: (bytes) => {
              port.write(Buffer.from(bytes))
            },
            close: () =>
              new Promise<void>((done) => {
                closing = true
                if (!port.isOpen) return done()
                port.close(() => done())
              }),
          })
        })
      })
    },
  }
}
