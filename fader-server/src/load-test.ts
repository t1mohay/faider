/**
 * Нагрузочный тест: N виртуальных интерфейсов одновременно двигают фейдер и шлют значения на сервер.
 * Проверяет обе стороны: как сервер принимает (ack на каждое сообщение) и как рассылает (state всем остальным).
 *
 * Запуск (сервер уже должен работать, лучше с LOG_EACH=0 — иначе тормозит вывод в консоль, а не сервер):
 *   npm run load -- --clients 20 --interval 20 --duration 10
 */
import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'

interface Options {
  url: string
  clients: number
  /** Интервал отправки одного клиента, мс (как «Интервал отправки» в интерфейсе). */
  interval: number
  /** Длительность отправки, с. */
  duration: number
}

function parseArgs(): Options {
  const opts: Options = { url: 'ws://localhost:8765', clients: 10, interval: 20, duration: 10 }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '')
    const val = args[i + 1]
    if (key === 'url') opts.url = val
    else if (key === 'clients' || key === 'interval' || key === 'duration') {
      const n = Number(val)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} должен быть числом > 0, пришло ${val}`)
      opts[key] = n
    } else throw new Error(`неизвестный параметр --${key}. Есть: --url --clients --interval --duration`)
  }
  return opts
}

interface Client {
  ws: WebSocket
  /** Момент следующей отправки по плану (performance.now). */
  nextAt: number
  seq: number
  sent: number
  acks: number
  /** Сколько state пришло от других клиентов (рассылка сервера). */
  states: number
  errors: number
  /** seq → момент отправки, для подсчёта времени до ack. */
  pending: Map<number, number>
  rtt: number[]
}

/** Считать state только после старта отправки: при подключении сервер присылает текущее положение. */
let counting = false

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/** Порог отклика для вердикта: дольше — уже заметная на слух задержка. */
const SLOW_MS = 20

const fmt = (n: number, digits = 1) => n.toFixed(digits)

async function serverStats(httpUrl: string) {
  try {
    const s = (await (await fetch(`${httpUrl}/api/state`)).json()) as {
      process?: { rssMb: number; heapUsedMb: number; cpuMs: number }
    }
    return s.process ?? null
  } catch {
    return null
  }
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const c: Client = { ws, nextAt: 0, seq: 0, sent: 0, acks: 0, states: 0, errors: 0, pending: new Map(), rtt: [] }
    ws.on('message', (data) => {
      const now = performance.now()
      const text = data.toString()
      // state приходит в десятки раз чаще ack — считаем без разбора JSON
      if (text.startsWith('{"type":"state"')) {
        if (counting) c.states++
        return
      }
      let m: { type?: string; seq?: number }
      try {
        m = JSON.parse(text)
      } catch {
        return
      }
      if (m.type === 'ack' && typeof m.seq === 'number') {
        const t = c.pending.get(m.seq)
        if (t !== undefined) {
          c.pending.delete(m.seq)
          c.rtt.push(now - t)
        }
        c.acks++
      } else if (m.type === 'error') c.errors++
    })
    ws.once('open', () => resolve(c))
    ws.once('error', reject)
  })
}

async function main() {
  const o = parseArgs()
  const httpUrl = o.url.replace(/^ws/, 'http')
  const perSecond = 1000 / o.interval

  console.log(`Нагрузочный тест: ${o.url}`)
  console.log(
    `  клиентов: ${o.clients}, интервал: ${o.interval} мс (${fmt(perSecond, 0)} сообщ./с с клиента), длительность: ${o.duration} с`,
  )
  console.log(
    `  ожидаемо: сервер принимает ~${fmt(o.clients * perSecond, 0)} сообщ./с, ` +
      `рассылает ~${fmt(o.clients * (o.clients - 1) * perSecond, 0)} state/с\n`,
  )

  const before = await serverStats(httpUrl)
  const statsFrom = performance.now()
  if (!before) console.log('  (статистика процесса сервера недоступна — /api/state не ответил или сервер старой версии)\n')

  let clients: Client[]
  try {
    clients = await Promise.all(Array.from({ length: o.clients }, () => connect(o.url)))
  } catch (e) {
    console.error(`Не удалось подключиться к ${o.url}: ${(e as Error).message}. Сервер запущен?`)
    process.exit(1)
  }
  console.log(`Подключено ${clients.length} клиентов, отправка…`)

  await sleep(300) // дать прийти начальным state, чтобы не посчитать их
  counting = true
  const started = performance.now()
  const deadline = started + o.duration * 1000
  clients.forEach((c, i) => {
    // разносим клиентов по времени, как живых людей, а не все в одну миллисекунду
    c.nextAt = started + (i / clients.length) * o.interval
  })
  // Таймеры Windows шагают по ~15.6 мс, поэтому setInterval(20) реально срабатывает раз в ~31 мс.
  // Вместо этого тикаем часто и отправляем столько сообщений, сколько положено к этому моменту.
  const tick = setInterval(() => {
    const now = Math.min(performance.now(), deadline)
    clients.forEach((c, i) => {
      // у каждого клиента своя фаза, чтобы значения отличались
      const phase = (i / clients.length) * Math.PI * 2
      while (c.nextAt <= now && c.ws.readyState === WebSocket.OPEN) {
        const t = (c.nextAt - started) / 1000
        const value = Math.round(63.5 + 63.5 * Math.sin(t * 2 + phase))
        c.seq++
        c.pending.set(c.seq, performance.now())
        // у каждого клиента свой фейдер: с захватом фейдера второй клиент на том же id получил бы отказ
        c.ws.send(JSON.stringify({ type: 'fader', id: i + 1, value, seq: c.seq, ts: Date.now() }))
        c.sent++
        c.nextAt += o.interval
      }
    })
  }, 1)

  const progress = setInterval(() => {
    const sent = clients.reduce((s, c) => s + c.sent, 0)
    const acks = clients.reduce((s, c) => s + c.acks, 0)
    process.stdout.write(`\r  ${fmt((performance.now() - started) / 1000)} с: отправлено ${sent}, ack ${acks}   `)
  }, 500)

  await sleep(o.duration * 1000)
  clearInterval(tick)
  const elapsed = (performance.now() - started) / 1000
  clearInterval(progress)
  await sleep(1000) // дождаться ответов на последние сообщения
  const after = await serverStats(httpUrl)
  // если сервер отстал, /api/state ответит только после разбора очереди — считаем по реальному времени
  const statsWindowS = (performance.now() - statsFrom) / 1000
  for (const c of clients) c.ws.close(1000, 'load test done')

  const sent = clients.reduce((s, c) => s + c.sent, 0)
  const acks = clients.reduce((s, c) => s + c.acks, 0)
  const states = clients.reduce((s, c) => s + c.states, 0)
  const errors = clients.reduce((s, c) => s + c.errors, 0)
  const lostAcks = clients.reduce((s, c) => s + c.pending.size, 0)
  // каждое сообщение клиента сервер должен разослать всем остальным
  const expectedStates = sent * (clients.length - 1)
  const rtt = clients.flatMap((c) => c.rtt).sort((a, b) => a - b)

  console.log('\n\nРезультат')
  console.log(`  отправлено:            ${sent} (${fmt(sent / elapsed, 0)} сообщ./с, план ${fmt(o.clients * perSecond, 0)})`)
  console.log(`  ack получено:          ${acks}, без ответа: ${lostAcks}, ошибок: ${errors}`)
  console.log(
    `  рассылка state:        ${states} из ${expectedStates} ожидаемых` +
      (expectedStates ? ` (${fmt((states / expectedStates) * 100)}%)` : ''),
  )
  if (rtt.length) {
    const avg = rtt.reduce((s, x) => s + x, 0) / rtt.length
    console.log(
      `  отклик (отправка → ack): среднее ${fmt(avg)} мс, медиана ${fmt(percentile(rtt, 50))}, ` +
        `95% ≤ ${fmt(percentile(rtt, 95))}, 99% ≤ ${fmt(percentile(rtt, 99))}, макс ${fmt(rtt[rtt.length - 1])} мс`,
    )
  } else {
    console.log('  отклик: ack не пришло ни одного (сервер запущен с ACK=0?)')
  }
  if (before && after) {
    const cpu = ((after.cpuMs - before.cpuMs) / (statsWindowS * 1000)) * 100
    console.log(
      `  сервер: процессор ~${fmt(cpu, 0)}% одного ядра, память ${after.rssMb} МБ (было ${before.rssMb} МБ)` +
        (cpu > 100 ? ' — больше 100%: кроме JS работают сеть и сборщик мусора' : ''),
    )
  }

  const p95 = percentile(rtt, 95)
  const lossOk = lostAcks === 0 && errors === 0 && states >= expectedStates * 0.99
  const latencyOk = rtt.length > 0 && p95 <= SLOW_MS
  const ok = lossOk && latencyOk
  if (ok) console.log(`\nOK: без потерь, 95% ответов быстрее ${SLOW_MS} мс`)
  else if (!lossOk) console.log('\nВНИМАНИЕ: есть потери или ошибки — см. цифры выше')
  else console.log(`\nВНИМАНИЕ: сообщения не теряются, но сервер не успевает — 95% ответов медленнее ${fmt(p95, 0)} мс (норма ≤ ${SLOW_MS} мс)`)
  console.log('Учтите: клиенты работают в этом же процессе, на большой нагрузке узким местом может быть сам тест.')
  setTimeout(() => process.exit(ok ? 0 : 2), 200)
}

main()
