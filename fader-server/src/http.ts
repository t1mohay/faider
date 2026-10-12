import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { log } from './logger.js'
import { FADER_MAX, FADER_MIN } from './protocol.js'
import { resetState, snapshot, state } from './state.js'
import { setFader } from './ws.js'

/** Мини-страница статуса: открыть http://localhost:8765 в браузере и смотреть значение вживую. */
const STATUS_PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>fader-server</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:16px;background:#121417;color:#e6e8eb;font:14px system-ui,sans-serif}
  h1{font-size:18px} .muted{color:#8b929c} pre{background:#0c0d0f;padding:12px;border-radius:6px;overflow:auto;font-size:12px}
  .f{display:flex;gap:12px;align-items:center;margin:8px 0;font-family:monospace;font-size:18px}
  .b{width:300px;max-width:60vw;height:12px;background:#23272e;border-radius:6px;overflow:hidden}
  .b i{display:block;height:100%;background:#f5a524}
</style></head><body>
<h1>fader-server <span class="muted">· тестовый сервер</span></h1>
<div id="faders" class="muted">Фейдеры ещё не присылали значений</div>
<pre id="state">загрузка…</pre>
<script>
async function tick(){
  try{
    const s = await (await fetch('/api/state')).json();
    document.getElementById('state').textContent = JSON.stringify({uptimeSec:s.uptimeSec,totals:s.totals,clients:s.clients,config:s.config},null,2);
    if(s.faders.length) document.getElementById('faders').innerHTML = s.faders.map(f =>
      '<div class="f">#'+f.id+' <b>'+String(f.value).padStart(3,'\\u00a0')+'</b><div class="b"><i style="width:'+(f.value/127*100)+'%"></i></div></div>').join('');
  }catch(e){ document.getElementById('state').textContent = 'сервер недоступен'; }
}
setInterval(tick, 300); tick();
</script></body></html>`

export function createApp() {
  const app = express()
  app.use(express.json())

  // CORS — чтобы фронт с другого порта (Vite, 5173) мог дёргать HTTP-ручки
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  // лог HTTP-запросов (кроме опроса состояния страницей статуса — он слишком частый)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    res.on('finish', () => {
      if (req.path === '/api/state') return
      log.http(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start} мс)`)
    })
    next()
  })

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(STATUS_PAGE)
  })

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - state.startedAt) / 1000) })
  })

  /** Текущее состояние: значения фейдеров, клиенты, счётчики. */
  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(snapshot())
  })

  /** Последние принятые сообщения. ?limit=50 */
  app.get('/api/history', (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, state.history.length || 1))
    res.json(state.history.slice(-limit))
  })

  /**
   * Как будто физический фейдер подвинули рукой: значение уходит всем интерфейсам с source = 'hw'.
   * Пример: curl -X POST localhost:8765/api/fader/1 -H "Content-Type: application/json" -d '{"value":100}'
   */
  app.post('/api/fader/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id)
    const value = (req.body as { value?: unknown } | undefined)?.value
    if (!Number.isInteger(id) || id < 0) {
      res.status(400).json({ error: 'id должен быть целым числом >= 0' })
      return
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < FADER_MIN || value > FADER_MAX) {
      res.status(400).json({ error: `value должен быть целым ${FADER_MIN}..${FADER_MAX}` })
      return
    }
    setFader(id, value, 'hw')
    log.info(`ЖЕЛЕЗО (вручную через HTTP): fader#${id} = ${value}`)
    res.json({ ok: true })
  })

  /** Сбросить значения, историю и счётчики. */
  app.post('/api/reset', (_req: Request, res: Response) => {
    resetState()
    log.info('Состояние сброшено через POST /api/reset')
    res.json({ ok: true })
  })

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `нет такого маршрута: ${req.method} ${req.path}` })
  })

  return app
}
