/**
 * Транспорт — способ достучаться до платы. Их три: COM-порт (Uno/Nano/ESP32), USB-MIDI
 * (Leonardo/Pro Micro/ESP32-S2/S3) и имитация. Менеджер работает с ними одинаково:
 * получить список, открыть, слать и получать сырые MIDI-байты.
 */

export type HwKind = 'serial' | 'midi' | 'sim'

export interface HwDevice {
  /** Уникален среди всех транспортов: 'serial:COM3', 'midi:Arduino Leonardo', 'sim'. */
  id: string
  kind: HwKind
  /** Что показать в списке. */
  name: string
  /** Подсказка: производитель, «похоже на ESP32» и т. п. */
  detail?: string
}

export interface HwHandlers {
  onBytes: (bytes: number[]) => void
  /** Устройство пропало само (выдернули кабель, плата перезагрузилась). Не вызывается после close(). */
  onClose: (reason: string) => void
}

export interface HwConnection {
  send: (bytes: number[]) => void
  close: () => Promise<void>
}

export interface HwTransport {
  kind: HwKind
  list: () => Promise<HwDevice[]>
  /** Бросает Error с понятным сообщением, если открыть не удалось. */
  open: (device: HwDevice, handlers: HwHandlers) => Promise<HwConnection>
  /** Через сколько мс после открытия плата готова принимать (Uno и ESP32 перезагружаются при открытии порта). */
  readyDelayMs?: number
}
