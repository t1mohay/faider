import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { FADER_MAX, FADER_MIN, clampFader, faderToPercent } from '../lib/protocol'

interface FaderProps {
  value: number
  onChange: (value: number) => void
  /** Пользователь взял ручку — пока держит, значения с сервера не должны её двигать. */
  onGrab?: () => void
  /** Вызывается, когда пользователь отпустил ручку. */
  onRelease?: (value: number) => void
  label?: string
  /** Фейдер занят другим — ручка не реагирует, а начатое движение прерывается. */
  disabled?: boolean
}

/** Деления шкалы в процентах. */
const TICKS = [0, 25, 50, 75, 100]

/**
 * Вертикальный фейдер на pointer events: работает мышью, пальцем и с клавиатуры.
 * Сделан руками, а не через повёрнутый <input type="range">, — так стабильнее на тачскринах.
 */
export function Fader({ value, onChange, onGrab, onRelease, label, disabled = false }: FaderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  // фейдер забрали прямо во время движения (кто-то успел раньше или двинули железо) — бросаем ручку
  useEffect(() => {
    if (disabled) setDragging(false)
  }, [disabled])

  const valueFromPointer = useCallback((clientY: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    const ratio = 1 - (clientY - rect.top) / rect.height // низ = 0, верх = 127
    return clampFader(FADER_MIN + ratio * (FADER_MAX - FADER_MIN))
  }, [])

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    setDragging(true)
    onGrab?.()
    onChange(valueFromPointer(e.clientY))
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    onChange(valueFromPointer(e.clientY))
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    onRelease?.(value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const steps: Record<string, number> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 10,
      PageDown: -10,
    }
    let next: number | null = null
    if (e.key in steps) next = value + steps[e.key]
    else if (e.key === 'Home') next = FADER_MIN
    else if (e.key === 'End') next = FADER_MAX
    if (next === null) return
    e.preventDefault()
    onChange(clampFader(next))
  }

  const percent = ((value - FADER_MIN) / (FADER_MAX - FADER_MIN)) * 100

  return (
    <div className={`fader${disabled ? ' is-locked' : ''}`}>
      {label && <div className="fader__label">{label}</div>}
      <div className="fader__value">
        {faderToPercent(value)}%
        <span className="fader__raw">{value}</span>
      </div>
      <div className="fader__body">
        <div className="fader__ticks" aria-hidden>
          {TICKS.map((t) => (
            <span key={t} style={{ bottom: `${t}%` }}>
              {t}%
            </span>
          ))}
        </div>
        <div
          ref={trackRef}
          className={`fader__track${dragging ? ' is-dragging' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label={label ?? 'Фейдер'}
          aria-orientation="vertical"
          aria-valuemin={FADER_MIN}
          aria-valuemax={FADER_MAX}
          aria-valuenow={value}
          aria-valuetext={`${faderToPercent(value)}%`}
          aria-disabled={disabled}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          <div className="fader__fill" style={{ height: `${percent}%` }} />
          <div className="fader__knob" style={{ bottom: `${percent}%` }} />
        </div>
      </div>
    </div>
  )
}
