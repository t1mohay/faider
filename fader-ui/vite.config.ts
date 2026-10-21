import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Адрес компьютера в сети — для QR-кода «Открыть на телефоне». Тот же тип в src/components/PhonePanel.tsx. */
interface LanAddress {
  address: string
  /** Имя сетевого адаптера в Windows, например «Беспроводная сеть». */
  iface: string
  /** VPN, WSL, виртуальные машины — телефон через них обычно не достучится. */
  virtual: boolean
}

/** Точно настоящая сеть: Wi-Fi, кабель, хот-спот Windows («Подключение по локальной сети* N»). */
const REAL_IFACE = /wi-?fi|wlan|wireless|беспровод|ethernet|подключение по локальной сети|local area connection/i
/** Точно виртуальная: VPN, прокси-клиенты, WSL, виртуальные машины. */
const VIRTUAL_IFACE =
  /vethernet|wsl|hyper-v|virtualbox|vmware|vpn|radmin|zerotier|hamachi|tailscale|outline|xray|v2ray|wireguard|clash|sing-?box|docker|\btap|\btun/i

/** 0 — настоящая сеть, 1 — непонятно, 2 — виртуальная. Имена адаптеров задаёт пользователь, поэтому это догадка. */
function rank(iface: string): number {
  if (VIRTUAL_IFACE.test(iface)) return 2
  return REAL_IFACE.test(iface) ? 0 : 1
}

/** IPv4-адреса компьютера: сначала настоящие (Wi-Fi, кабель, хот-спот), виртуальные в конце. */
function lanAddresses(): LanAddress[] {
  const list: LanAddress[] = []
  for (const [iface, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      list.push({ address: info.address, iface, virtual: VIRTUAL_IFACE.test(iface) })
    }
  }
  return list.sort((a, b) => rank(a.iface) - rank(b.iface))
}

/**
 * Страница, открытая на ПК как localhost, не знает IP компьютера в сети — его знает только Node.
 * Плагин отдаёт список адресов по /__fader/lan (в dev и preview; в собранной статике его нет).
 * Читается на каждый запрос: подключились к другой сети — достаточно нажать «Обновить».
 */
function lanAddressesPlugin(): Plugin {
  const handler = (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(lanAddresses()))
  }
  return {
    name: 'fader-lan-addresses',
    configureServer(server) {
      server.middlewares.use('/__fader/lan', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/__fader/lan', handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), lanAddressesPlugin()],
  server: {
    host: true, // доступно с других устройств в локальной сети (телефон/планшет)
    port: 5173,
  },
  // npm run serve: собранная (не отладочная) версия — для телефона она заметно быстрее
  preview: {
    host: true,
    port: 4173,
  },
})
