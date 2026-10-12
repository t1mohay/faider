// Запускает сервер и интерфейс одновременно в одном терминале.
// Остановка: Ctrl+C (останавливает оба).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const apps = [
  { name: 'server', dir: 'fader-server', color: '\x1b[35m' },
  { name: 'ui    ', dir: 'fader-ui', color: '\x1b[36m' },
]

for (const app of apps) {
  if (!existsSync(join(root, app.dir, 'node_modules'))) {
    console.error(`Нет зависимостей в ${app.dir}. Сначала выполните в корне проекта: npm install`)
    process.exit(1)
  }
}

const children = apps.map((app) => {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: join(root, app.dir),
    shell: true, // нужно для Windows (npm.cmd)
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  const prefix = `${app.color}[${app.name}]\x1b[0m `
  const pipe = (stream, out) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) out.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    console.log(`${prefix}процесс завершился (код ${code})`)
    shutdown()
  })
  return child
})

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill()
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('\nЗапускаю сервер и интерфейс…')
console.log('  Интерфейс:        http://localhost:5173')
console.log('  Статус сервера:   http://localhost:8765')
console.log('  Остановить:       Ctrl+C\n')
