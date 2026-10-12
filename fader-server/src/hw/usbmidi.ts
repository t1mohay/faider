import { Input, Output } from '@julusian/midi'
import { log } from '../logger.js'
import type { HwDevice, HwTransport } from './transport.js'

let loadErrorLogged = false

/** Имена портов; если нативная библиотека не загрузилась — пусто, но сервер работает дальше. */
function portNames(kind: 'in' | 'out'): string[] {
  try {
    return kind === 'in' ? Input.getPortNames() : Output.getPortNames()
  } catch (e) {
    if (!loadErrorLogged) {
      loadErrorLogged = true
      log.error(`USB-MIDI недоступен: ${(e as Error).message}`)
    }
    return []
  }
}

/**
 * Выход для входа с тем же именем. В Windows у одной платы вход и выход обычно называются одинаково,
 * но бывает, что одно имя — часть другого («Arduino Leonardo» / «MIDIOUT2 (Arduino Leonardo)»).
 */
function matchOutput(input: string, outputs: string[]): string | undefined {
  return outputs.find((o) => o === input) ?? outputs.find((o) => o.includes(input) || input.includes(o))
}

/**
 * Плата, которая сама представляется USB-MIDI устройством (Leonardo/Micro/Pro Micro, ESP32-S2/S3),
 * или любой готовый MIDI-контроллер. Устройство без входа нам бесполезно, поэтому список — по входам.
 */
export function usbMidiTransport(): HwTransport {
  return {
    kind: 'midi',

    async list(): Promise<HwDevice[]> {
      const outputs = portNames('out')
      return portNames('in').map((name) => ({
        id: `midi:${name}`,
        kind: 'midi',
        name,
        detail: matchOutput(name, outputs) ? undefined : 'только вход — мотор управляться не будет',
      }))
    },

    async open(device, { onBytes }) {
      const name = device.id.slice('midi:'.length)
      const outName = matchOutput(name, portNames('out'))
      const input = new Input()
      const output = outName ? new Output() : null
      try {
        input.openPortByName(name)
        if (output && outName) output.openPortByName(outName)
      } catch (e) {
        input.destroy()
        output?.destroy()
        // в Windows MIDI-порт может держать только одна программа
        throw new Error(`${name}: не удалось открыть (${(e as Error).message}) — порт занят DAW или другой программой?`)
      }
      input.on('message', (_dt, message) => onBytes(message))
      // RtMidi не сообщает об отключении — пропажу устройства замечает менеджер по списку портов
      return {
        send: (bytes) => output?.send(bytes),
        close: async () => {
          input.closePort()
          input.destroy()
          output?.closePort()
          output?.destroy()
        },
      }
    },
  }
}
