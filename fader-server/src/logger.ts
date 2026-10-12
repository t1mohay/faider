/** Простой цветной логгер для консоли, без зависимостей. */

const codes = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

// NO_COLOR=1 — отключить цвета (если терминал показывает мусор вместо цветов)
const c: typeof codes = process.env.NO_COLOR
  ? (Object.fromEntries(Object.keys(codes).map((k) => [k, ''])) as typeof codes)
  : codes

function time(): string {
  const d = new Date()
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function out(color: string, tag: string, msg: string) {
  console.log(`${c.gray}${time()}${c.reset} ${color}${tag.padEnd(5)}${c.reset} ${msg}`)
}

export const log = {
  info: (msg: string) => out(c.cyan, 'INFO', msg),
  ok: (msg: string) => out(c.green, 'OK', msg),
  recv: (msg: string) => out(c.blue, 'RECV', msg),
  sent: (msg: string) => out(c.magenta, 'SENT', msg),
  warn: (msg: string) => out(c.yellow, 'WARN', msg),
  error: (msg: string) => out(c.red, 'ERROR', msg),
  http: (msg: string) => out(c.gray, 'HTTP', msg),
}

/** Полоска для наглядности: 0..127 -> ████░░░░ */
export function bar(value: number, max = 127, width = 24): string {
  const filled = Math.round((value / max) * width)
  return `${c.green}${'█'.repeat(filled)}${c.gray}${'░'.repeat(width - filled)}${c.reset}`
}
