'use strict'

const { spawnSync } = require('child_process')

const proxyCheckCache = new Map()

function normalizeProxy(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const protocol = String(raw.protocol || 'HTTP').toUpperCase()
  const host = String(raw.host || '').trim()
  const portNum = Number(raw.port)
  const port = Number.isFinite(portNum) ? Math.trunc(portNum) : 0
  const authEnabled = !!raw.authEnabled
  const username = String(raw.username || '').trim()
  const password = String(raw.password || '')
  const enabled = !!raw.enabled && !!host && port > 0
  return {
    enabled,
    protocol: ['HTTP', 'HTTPS', 'SOCKS5'].includes(protocol) ? protocol : 'HTTP',
    host,
    port,
    authEnabled,
    username,
    password,
  }
}

function humanizeProxyError(rawMessage) {
  const text = String(rawMessage || '').trim()
  const low = text.toLowerCase()
  if (!text) return 'Không kết nối được proxy'
  if (low.includes('timed out') || low.includes('timeout')) return 'Proxy timeout: không phản hồi kịp thời gian chờ'
  if (low.includes('407')) return 'Proxy yêu cầu xác thực: sai username/password hoặc chưa cấp quyền'
  if (low.includes('could not resolve') || low.includes('name or service not known') || low.includes('dns')) {
    return 'Không phân giải được host proxy (DNS lỗi hoặc host sai)'
  }
  if (low.includes('refused')) return 'Proxy từ chối kết nối (connection refused)'
  if (low.includes('failed to connect') || low.includes('no route to host')) {
    return 'Không kết nối được tới server proxy (host/port có thể sai)'
  }
  if (low.includes('tunnel') && low.includes('failed')) return 'Lỗi tunnel qua proxy (thường do auth hoặc policy proxy)'
  if (low.includes('ssl') || low.includes('tls') || low.includes('handshake')) return 'Proxy kết nối được nhưng lỗi SSL/TLS handshake'
  return text.slice(0, 240)
}

/**
 * Live proxy check: ipify JSON + optional chat.zalo.me reachability.
 * When requireZaloReachable, success means traffic path suitable for Zalo PC with proxy on.
 */
function checkProxyViaCurl(proxy, options = {}) {
  const p = normalizeProxy(proxy)
  if (!p.enabled) return { ok: false, message: 'Proxy chưa đủ thông tin host/port' }
  const bypassCache = !!options?.bypassCache
  const requireZaloReachable = !!options?.requireZaloReachable

  const cacheKey = [p.protocol, p.host, p.port, p.authEnabled ? p.username : '', p.authEnabled ? p.password : ''].join('|')
  const cached = bypassCache ? null : proxyCheckCache.get(cacheKey)
  if (cached && cached.ok && (Date.now() - cached.at) < 120000 && (!requireZaloReachable || cached.zaloOk)) {
    return { ok: true, ip: cached.ip, cached: true }
  }

  const scheme = p.protocol === 'SOCKS5' ? 'socks5h' : (p.protocol === 'HTTPS' ? 'https' : 'http')
  const proxyUrl = `${scheme}://${p.host}:${p.port}`
  const args = [
    '-sS',
    '--max-time', '8',
    '--connect-timeout', '5',
    '--proxy', proxyUrl,
    'https://api.ipify.org?format=json',
  ]

  if (p.authEnabled && p.username) {
    args.splice(args.length - 1, 0, '--proxy-user', `${p.username}:${p.password || ''}`)
  }

  try {
    const rs = spawnSync('curl.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    const status = typeof rs.status === 'number' ? rs.status : 1
    const stdout = String(rs.stdout || '').trim()
    const stderr = String(rs.stderr || '').trim()

    if (status === 0) {
      try {
        const json = JSON.parse(stdout || '{}')
        if (json.ip) {
          let zaloOk = false
          if (requireZaloReachable) {
            const argsZalo = [
              '-sS',
              '--max-time', '10',
              '--connect-timeout', '5',
              '--proxy', proxyUrl,
              '-o', 'NUL',
              '-w', '%{http_code}',
              'https://chat.zalo.me/',
            ]
            if (p.authEnabled && p.username) {
              argsZalo.splice(argsZalo.length - 1, 0, '--proxy-user', `${p.username}:${p.password || ''}`)
            }
            const rsZalo = spawnSync('curl.exe', argsZalo, { encoding: 'utf8', windowsHide: true, timeout: 12000 })
            const statusZalo = typeof rsZalo.status === 'number' ? rsZalo.status : 1
            const codeText = String(rsZalo.stdout || '').trim()
            const code = Number.parseInt(codeText, 10)
            if (statusZalo !== 0 || !Number.isFinite(code) || code <= 0 || code >= 500) {
              const errText = String(rsZalo.stderr || rsZalo.stdout || '').trim()
              return {
                ok: false,
                message: errText
                  ? `Proxy live nhưng không tới được chat.zalo.me: ${humanizeProxyError(errText)}`
                  : 'Proxy live nhưng không tới được chat.zalo.me',
              }
            }
            zaloOk = true
          }

          proxyCheckCache.set(cacheKey, { ok: true, ip: json.ip, at: Date.now(), zaloOk })
          return { ok: true, ip: json.ip, zaloOk }
        }
      } catch (_) {}
      return { ok: false, message: 'Proxy phản hồi nhưng dữ liệu không hợp lệ' }
    }

    const errText = stderr || stdout || 'Không kết nối được proxy'
    return { ok: false, message: humanizeProxyError(errText) }
  } catch (error) {
    return { ok: false, message: humanizeProxyError(error?.message || 'Kiểm tra proxy thất bại') }
  }
}

module.exports = {
  normalizeProxy,
  checkProxyViaCurl,
  humanizeProxyError,
}
