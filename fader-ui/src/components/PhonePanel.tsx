import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** Адрес компьютера в сети — отдаёт плагин в vite.config.ts по /__fader/lan. */
interface LanAddress {
  address: string
  iface: string
  virtual: boolean
}

/** Подсеть мобильного хот-спота Windows: ноутбук в ней всегда 192.168.137.1. */
const HOTSPOT_PREFIX = '192.168.137.'

function describe(a: LanAddress): string {
  if (a.address.startsWith(HOTSPOT_PREFIX)) return `${a.address} — хот-спот ноутбука`
  return `${a.address} — ${a.iface}${a.virtual ? ' (виртуальная сеть)' : ''}`
}

/**
 * QR-код с адресом интерфейса для телефона: навёл камеру — открылось, IP вводить не нужно.
 * Показывается только на самом ПК (страница открыта как localhost): на телефоне он не нужен.
 */
export function PhonePanel() {
  const [addresses, setAddresses] = useState<LanAddress[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/__fader/lan', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const list = (await res.json()) as LanAddress[]
      setAddresses(list)
      setFailed(false)
      // выбранный адрес мог пропасть (переподключились к другой сети) — тогда берём первый
      setSelected((cur) => (cur && list.some((a) => a.address === cur) ? cur : (list[0]?.address ?? null)))
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const url = selected ? `${location.protocol}//${selected}${location.port ? `:${location.port}` : ''}` : null

  useEffect(() => {
    if (!url) {
      setQr(null)
      return
    }
    let cancelled = false
    // QR всегда тёмный на белом, даже в тёмной теме: так его надёжнее читают камеры
    QRCode.toDataURL(url, { margin: 2, width: 320, color: { dark: '#000000', light: '#ffffff' } })
      .then((data) => !cancelled && setQr(data))
      .catch(() => !cancelled && setQr(null))
    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <section className="panel phone">
      <h2>Открыть на телефоне</h2>
      {failed && (
        <p className="muted small">
          Адреса компьютера недоступны (интерфейс запущен не через <code>npm run dev</code>). Откройте на телефоне адрес
          из строки «В сети» в логах сервера, порт 5173.
        </p>
      )}
      {addresses && addresses.length === 0 && (
        <p className="muted small">Компьютер не подключён к сети. Подключитесь к Wi-Fi или включите хот-спот и нажмите «Обновить».</p>
      )}
      {url && (
        <div className="phone__body">
          {qr ? <img className="phone__qr" src={qr} alt={`QR-код: ${url}`} /> : <div className="phone__qr" />}
          <div className="phone__info">
            <code className="phone__url">{url}</code>
            {addresses && addresses.length > 1 && (
              <select
                value={selected ?? ''}
                onChange={(e) => setSelected(e.target.value)}
                aria-label="Сеть, в которой телефон"
              >
                {addresses.map((a) => (
                  <option key={a.address} value={a.address}>
                    {describe(a)}
                  </option>
                ))}
              </select>
            )}
            <p className="muted small">
              Телефон должен быть в той же сети. Если страница не открывается — файрвол Windows или выбрана не та сеть.
            </p>
            <button type="button" className="link" onClick={() => void load()}>
              Обновить
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
