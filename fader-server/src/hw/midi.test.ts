import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MidiParser, controlChange, touchNote } from './midi.js'

test('CC на канале 1', () => {
  assert.deepEqual(new MidiParser().feed([0xb0, 1, 64]), [{ type: 'cc', channel: 1, controller: 1, value: 64 }])
})

test('сообщение, разорванное между кусками', () => {
  const p = new MidiParser()
  assert.deepEqual(p.feed([0xb3]), [])
  assert.deepEqual(p.feed([7]), [])
  assert.deepEqual(p.feed([100]), [{ type: 'cc', channel: 4, controller: 7, value: 100 }])
})

test('running status: статус не повторяется', () => {
  const ev = new MidiParser().feed([0xb0, 1, 10, 1, 11, 1, 12])
  assert.deepEqual(
    ev.map((e) => e.type === 'cc' && e.value),
    [10, 11, 12],
  )
})

test('Note On / Note Off / Note On с velocity 0', () => {
  const ev = new MidiParser().feed([0x90, 1, 127, 0x80, 1, 0, 0x90, 1, 0])
  assert.deepEqual(
    ev.map((e) => e.type === 'note' && e.on),
    [true, false, false],
  )
})

test('мусор до первого статуса (лог загрузки ESP32) пропускается', () => {
  const junk = [...Buffer.from('ets Jun  8 2016 rst:0x1\r\n')]
  assert.deepEqual(new MidiParser().feed([...junk, 0xb0, 1, 5]), [{ type: 'cc', channel: 1, controller: 1, value: 5 }])
})

test('realtime-байт посреди сообщения не ломает его', () => {
  assert.deepEqual(new MidiParser().feed([0xb0, 0xf8, 1, 0xfe, 9]), [{ type: 'cc', channel: 1, controller: 1, value: 9 }])
})

test('SysEx пропускается, после него разбор продолжается', () => {
  assert.deepEqual(new MidiParser().feed([0xf0, 0x7e, 1, 2, 0xf7, 0xb0, 1, 3]), [
    { type: 'cc', channel: 1, controller: 1, value: 3 },
  ])
})

test('Program Change (1 байт данных) не сдвигает следующие сообщения', () => {
  assert.deepEqual(new MidiParser().feed([0xc0, 5, 0xb0, 1, 3]), [{ type: 'cc', channel: 1, controller: 1, value: 3 }])
})

test('system common сбрасывает running status', () => {
  assert.deepEqual(new MidiParser().feed([0xb0, 1, 3, 0xf3, 2, 1, 4]), [{ type: 'cc', channel: 1, controller: 1, value: 3 }])
})

test('сборка сообщений', () => {
  assert.deepEqual(controlChange(1, 1, 127), [0xb0, 1, 127])
  assert.deepEqual(controlChange(16, 7, 0), [0xbf, 7, 0])
  assert.deepEqual(touchNote(1, 1, true), [0x90, 1, 127])
  assert.deepEqual(touchNote(2, 1, false), [0x81, 1, 0])
})
