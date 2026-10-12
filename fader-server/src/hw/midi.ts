/**
 * Разбор и сборка MIDI-сообщений. Нам нужны только Control Change (положение фейдера)
 * и Note On/Off (касание фейдера), остальное разбирается ровно настолько, чтобы не сбиться.
 */

export type MidiEvent =
  | { type: 'cc'; channel: number; controller: number; value: number }
  | { type: 'note'; channel: number; note: number; on: boolean }

/** Сколько байтов данных у сообщения канала (по старшему полубайту статуса). */
function channelDataLength(status: number): number {
  const kind = status & 0xf0
  return kind === 0xc0 || kind === 0xd0 ? 1 : 2
}

/**
 * Потоковый разборщик: по COM-порту байты приходят кусками как попало, поэтому сообщение
 * собирается по байту. Поддерживает running status (статус не повторяется у сообщений подряд),
 * пропускает SysEx и realtime-байты. Данные без статуса (например, лог загрузки ESP32) игнорирует.
 */
export class MidiParser {
  private status: number | null = null
  private data: number[] = []
  private inSysex = false

  feed(bytes: Iterable<number>): MidiEvent[] {
    const out: MidiEvent[] = []
    for (const b of bytes) {
      if (b >= 0xf8) continue // realtime (clock, active sensing…) может влезть посреди сообщения
      if (b === 0xf0) {
        this.inSysex = true
        this.status = null
        continue
      }
      if (b === 0xf7) {
        this.inSysex = false
        continue
      }
      if (this.inSysex) {
        if (b < 0x80) continue
        this.inSysex = false // SysEx оборвали новым статусом — обрабатываем его ниже
      }
      if (b >= 0xf0) {
        this.status = null // system common сбрасывает running status, его данные нам не нужны
        continue
      }
      if (b >= 0x80) {
        this.status = b
        this.data = []
        continue
      }
      if (this.status === null) continue
      this.data.push(b)
      if (this.data.length < channelDataLength(this.status)) continue
      const ev = decode(this.status, this.data)
      if (ev) out.push(ev)
      this.data = []
    }
    return out
  }
}

function decode(status: number, [d1, d2]: number[]): MidiEvent | null {
  const channel = (status & 0x0f) + 1
  switch (status & 0xf0) {
    case 0xb0:
      return { type: 'cc', channel, controller: d1, value: d2 }
    case 0x90:
      // Note On с velocity 0 по стандарту — это Note Off
      return { type: 'note', channel, note: d1, on: d2 > 0 }
    case 0x80:
      return { type: 'note', channel, note: d1, on: false }
    default:
      return null
  }
}

/** Control Change. channel — 1..16, как пишут в документации к MIDI. */
export function controlChange(channel: number, controller: number, value: number): number[] {
  return [0xb0 | ((channel - 1) & 0x0f), controller & 0x7f, value & 0x7f]
}

/** Касание фейдера: Note On (on = true) или Note Off. */
export function touchNote(channel: number, note: number, on: boolean): number[] {
  return on ? [0x90 | ((channel - 1) & 0x0f), note & 0x7f, 127] : [0x80 | ((channel - 1) & 0x0f), note & 0x7f, 0]
}
