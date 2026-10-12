import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HwManager } from './manager.js'
import type { HwStatus } from './manager.js'
import type { HwConnection, HwHandlers, HwTransport } from './transport.js'

/** Поддельный COM-порт: устройства задаются руками, отправленное копится в sent. */
function fakeSerial() {
  const fake = {
    ports: ['COM3'],
    failOpen: null as string | null,
    handlers: null as HwHandlers | null,
    sent: [] as number[][],
    opened: 0,
    closed: 0,
    transport: null as unknown as HwTransport,
  }
  fake.transport = {
    kind: 'serial',
    list: async () => fake.ports.map((p) => ({ id: `serial:${p}`, kind: 'serial' as const, name: p })),
    open: async (_d, h) => {
      if (fake.failOpen) throw new Error(fake.failOpen)
      fake.opened++
      fake.handlers = h
      const conn: HwConnection = {
        send: (b) => fake.sent.push(b),
        close: async () => {
          fake.closed++
        },
      }
      return conn
    },
  }
  return fake
}

function setup(values: [number, number][] = []) {
  const fake = fakeSerial()
  let time = 1000
  const events: string[] = []
  const statuses: HwStatus[] = []
  const hw = new HwManager(
    [fake.transport],
    {
      onValue: (id, v) => events.push(`value ${id}=${v}`),
      onTouch: (id, t) => events.push(`touch ${id} ${t}`),
      onStatus: (s) => statuses.push(s),
      currentValues: () => values,
    },
    { channel: 1, now: () => time },
  )
  return {
    fake,
    hw,
    events,
    statuses,
    last: () => statuses.at(-1)!,
    advance: (ms: number) => {
      time += ms
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

test('подключение: статус connected, моторы встают в текущие положения', async () => {
  const t = setup([[1, 64]])
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  assert.equal(t.last().state, 'connected')
  assert.equal(t.last().selected, 'serial:COM3')
  await tick()
  assert.deepEqual(t.fake.sent, [[0xb0, 1, 64]])
})

test('CC с железа — движение фейдера; другой канал игнорируется', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  t.fake.handlers!.onBytes([0xb0, 1, 100, 0xb1, 1, 5])
  assert.deepEqual(t.events, ['value 1=100'])
})

test('эхо мотора не считается движением руками, а настоящее движение после — считается', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  t.hw.sendFader(1, 80)
  t.fake.handlers!.onBytes([0xb0, 1, 79]) // мотор доехал почти до цели
  assert.deepEqual(t.events, [])
  t.fake.handlers!.onBytes([0xb0, 1, 60]) // далеко от цели — это рука
  t.advance(500)
  t.fake.handlers!.onBytes([0xb0, 1, 80]) // окно эха прошло
  assert.deepEqual(t.events, ['value 1=60', 'value 1=80'])
})

test('пока фейдер касаются, защита от эха не работает — это точно рука', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  t.hw.sendFader(1, 80)
  t.fake.handlers!.onBytes([0x90, 1, 127, 0xb0, 1, 80, 0x80, 1, 0])
  assert.deepEqual(t.events, ['touch 1 true', 'value 1=80', 'touch 1 false'])
})

test('выдернули плату: касание снимается, состояние waiting; вставили — переподключение', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  t.fake.handlers!.onBytes([0x90, 1, 127])
  t.fake.handlers!.onClose('COM3 отключён')
  assert.equal(t.last().state, 'waiting')
  assert.deepEqual(t.events, ['touch 1 true', 'touch 1 false'])

  t.fake.ports = []
  await t.hw.refresh(false)
  assert.equal(t.last().state, 'waiting')
  t.fake.ports = ['COM3']
  await t.hw.refresh(false)
  assert.equal(t.last().state, 'connected')
  assert.equal(t.fake.opened, 2)
})

test('устройство пропало из списка без события close (USB-MIDI) — закрываем и ждём', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  t.fake.ports = []
  await t.hw.refresh(false)
  assert.equal(t.last().state, 'waiting')
  assert.equal(t.fake.closed, 1)
})

test('порт занят: error, при следующем опросе пробуем снова', async () => {
  const t = setup()
  await t.hw.refresh()
  t.fake.failOpen = 'COM3 занят другой программой'
  await t.hw.connect('serial:COM3')
  assert.equal(t.last().state, 'error')
  assert.equal(t.last().error, 'COM3 занят другой программой')
  t.fake.failOpen = null
  await t.hw.refresh(false)
  assert.equal(t.last().state, 'connected')
})

test('отключение пользователем: соединение закрыто, после опроса не переподключаемся', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  await t.hw.disconnect()
  await t.hw.refresh(false)
  assert.equal(t.last().state, 'disconnected')
  assert.equal(t.last().selected, null)
  assert.equal(t.fake.opened, 1)
  assert.equal(t.fake.closed, 1)
})

test('после отключения sendFader ничего не шлёт', async () => {
  const t = setup()
  await t.hw.refresh()
  await t.hw.connect('serial:COM3')
  await t.hw.disconnect()
  t.hw.sendFader(1, 5)
  assert.deepEqual(t.fake.sent, [])
})

test('два быстрых connect подряд открывают порт один раз', async () => {
  const t = setup()
  await t.hw.refresh()
  await Promise.all([t.hw.connect('serial:COM3'), t.hw.connect('serial:COM3')])
  assert.equal(t.fake.opened, 1)
})
