import { useState } from 'react'
import type { HwDevice, HwState, HwStatusMessage } from '../lib/protocol'

interface DevicePanelProps {
  /** null — нет соединения с сервером, о железе ничего не известно. */
  status: HwStatusMessage | null
  onRefresh: () => void
  onConnect: (deviceId: string) => void
  onDisconnect: () => void
}

const STATE_TEXT: Record<HwState, string> = {
  disconnected: 'Не подключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  waiting: 'Ждём устройство',
  error: 'Ошибка',
}

/** Класс точки-индикатора — те же цвета, что у соединения с сервером. */
const STATE_DOT: Record<HwState, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting',
  connected: 'connected',
  waiting: 'connecting',
  error: 'error',
}

const GROUPS: { kind: HwDevice['kind']; label: string }[] = [
  { kind: 'serial', label: 'COM-порт (Uno, Nano, ESP32)' },
  { kind: 'midi', label: 'USB-MIDI (Leonardo, Pro Micro, ESP32-S2/S3)' },
  { kind: 'sim', label: 'Без железа' },
]

function optionText(d: HwDevice): string {
  return d.detail ? `${d.name} — ${d.detail}` : d.name
}

/** Выбор физического устройства (платы с фейдером). Устройство одно на весь сервер — выбор видят все интерфейсы. */
export function DevicePanel({ status, onRefresh, onConnect, onDisconnect }: DevicePanelProps) {
  const [choice, setChoice] = useState('')

  if (!status) {
    return (
      <section className="panel device">
        <h2>Устройство</h2>
        <p className="muted small">Подключитесь к серверу, чтобы выбрать плату</p>
      </section>
    )
  }

  const { devices, selected, state, error } = status
  // выбранное на сервере устройство могли выдернуть — оставляем его в списке, чтобы было видно, чего ждём
  const options = selected && !devices.some((d) => d.id === selected)
    ? [...devices, { id: selected, kind: selected.split(':')[0] as HwDevice['kind'], name: `${selected} (нет)` }]
    : devices
  const current = options.some((d) => d.id === choice) ? choice : (selected ?? options[0]?.id ?? '')
  const active = selected !== null && state !== 'disconnected'
  // выбрали в списке не то, что подключено, — кнопка переключает на него
  const switching = active && current !== selected

  return (
    <section className="panel device">
      <h2>Устройство</h2>
      <div className={`status__conn status__conn--${STATE_DOT[state]}`}>
        <span className="dot" />
        {STATE_TEXT[state]}
        {active && <span className="muted"> · {selected}</span>}
      </div>
      {error && <p className="device__error">{error}</p>}
      <div className="row">
        <select
          className="device__select"
          value={current}
          onChange={(e) => setChoice(e.target.value)}
          disabled={options.length === 0}
        >
          {options.length === 0 && <option value="">Устройств не найдено</option>}
          {GROUPS.map((g) => {
            const items = options.filter((d) => d.kind === g.kind)
            if (items.length === 0) return null
            return (
              <optgroup key={g.kind} label={g.label}>
                {items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {optionText(d)}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        <button onClick={onRefresh} title="Обновить список устройств">
          Обновить
        </button>
        {active && !switching ? (
          <button className="danger" onClick={onDisconnect}>
            Отключить
          </button>
        ) : (
          <button className="primary" disabled={!current} onClick={() => onConnect(current)}>
            {switching ? 'Переключить' : 'Подключить'}
          </button>
        )}
      </div>
      <p className="muted small">
        Фейдер N ↔ MIDI Control Change N. Касание фейдера — Note On/Off с нотой N (если на плате есть датчик).
      </p>
    </section>
  )
}
