'use strict'

const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const { URL } = require('url')
const fs = require('fs')

const BRIDGE_UA = 'ZaloMask-ProxyBridge/1.0'

function makeProxyAuthHeader(proxy) {
  if (!proxy || !proxy.authEnabled || !proxy.username) return ''
  const raw = `${String(proxy.username)}:${String(proxy.password || '')}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

function startProxyBridge(proxy, options = {}) {
  const upstreamHost = String(proxy?.host || '').trim()
  const upstreamPort = Number(proxy?.port || 0)
  if (!upstreamHost || !upstreamPort) {
    throw new Error('Proxy bridge requires upstream host and port')
  }

  const upstreamProtocol = String(proxy?.protocol || 'HTTP').trim().toUpperCase()
  const useTlsUpstream = upstreamProtocol === 'HTTPS'

  const authHeader = makeProxyAuthHeader(proxy)
  const listenHost = options.host || '127.0.0.1'
  const listenPort = Number(options.port || 0)

  // Lock the log file path at construction time (don't read env each call) so
  // env restoration after bridge construction doesn't break logging.
  const logFilePath = String(
    options.logFile ||
    process.env.BRIDGE_LOG_FILE ||
    'bridge-traffic.log'
  )
  const logBridge = (msg) => {
    const now = new Date().toISOString()
    const line = `[${now}] ${msg}\n`
    try { fs.appendFileSync(logFilePath, line, 'utf8') } catch (_) {}
  }

  const server = http.createServer()
  let counter = 0

  server.on('request', (req, res) => {
    const reqId = ++counter
    logBridge(`HTTP_REQ#${reqId} ${req.method} ${req.url}`)

    let targetUrl
    try {
      targetUrl = new URL(req.url)
    } catch (error) {
      logBridge(`HTTP_REQ#${reqId} PARSE_ERROR ${error.message}`)
      res.writeHead(400)
      res.end('Bad proxy request URL')
      return
    }

    const headers = { ...req.headers }
    delete headers['proxy-connection']
    if (authHeader) {
      headers['proxy-authorization'] = authHeader
      logBridge(`HTTP_REQ#${reqId} AUTH_INJECTED`)
    }
    headers.host = targetUrl.host

    const upstreamReq = (useTlsUpstream ? https : http).request({
      host: upstreamHost,
      port: upstreamPort,
      servername: useTlsUpstream ? upstreamHost : undefined,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      logBridge(`HTTP_REQ#${reqId} UPSTREAM_STATUS=${upstreamRes.statusCode}`)
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage || '', upstreamRes.headers)
      upstreamRes.pipe(res)
    })

    upstreamReq.on('error', (error) => {
      logBridge(`HTTP_REQ#${reqId} UPSTREAM_ERROR ${error.message}`)
      if (!res.headersSent) res.writeHead(502)
      res.end(`Proxy bridge error: ${error.message}`)
    })

    req.pipe(upstreamReq)
  })

  server.on('connect', (req, clientSocket, head) => {
    const tunnelId = ++counter
    logBridge(`TUNNEL#${tunnelId} CONNECT ${req.url}`)

    const fail = (message) => {
      logBridge(`TUNNEL#${tunnelId} FAIL ${String(message || 'unknown').slice(0, 200)}`)
      try {
        clientSocket.write(
          'HTTP/1.1 502 Bad Gateway\r\n' +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          String(message || 'CONNECT failed')
        )
      } catch (_) {}
      try { clientSocket.destroy() } catch (_) {}
    }

    clientSocket.setNoDelay(true)

    const connectHeaders = {
      Host: req.url,
      'User-Agent': BRIDGE_UA,
      Connection: 'keep-alive',
      'Proxy-Connection': 'Keep-Alive',
    }
    if (authHeader) {
      connectHeaders['Proxy-Authorization'] = authHeader
      logBridge(`TUNNEL#${tunnelId} AUTH_INJECTED`)
    }

    const upstreamReq = (useTlsUpstream ? https : http).request({
      host: upstreamHost,
      port: upstreamPort,
      servername: useTlsUpstream ? upstreamHost : undefined,
      method: 'CONNECT',
      path: req.url,
      headers: connectHeaders,
    })

    const tStart = Date.now()
    const timer = setTimeout(() => {
      logBridge(`TUNNEL#${tunnelId} TIMEOUT after ${Date.now() - tStart}ms`)
      try { upstreamReq.destroy(new Error('upstream CONNECT timeout')) } catch (_) {}
      fail('Proxy bridge timeout waiting for upstream CONNECT response')
    }, 15000)

    upstreamReq.once('connect', (upstreamRes, upstreamSocket, upstreamHead) => {
      clearTimeout(timer)
      try { upstreamSocket.setNoDelay(true) } catch (_) {}
      const statusCode = Number(upstreamRes && upstreamRes.statusCode || 0)
      const statusLine = `HTTP/${upstreamRes.httpVersion || '1.1'} ${statusCode} ${upstreamRes.statusMessage || ''}`.trim()
      logBridge(`TUNNEL#${tunnelId} UPSTREAM_RESPONSE ${statusLine.slice(0, 80)} (after ${Date.now() - tStart}ms)`)
      if (statusCode !== 200) {
        try { upstreamSocket.destroy() } catch (_) {}
        fail(statusLine || 'CONNECT failed')
        return
      }

      logBridge(`TUNNEL#${tunnelId} OK piping ${req.url}`)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead)
      if (head && head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)

      upstreamSocket.on('error', (err) => {
        logBridge(`TUNNEL#${tunnelId} UPSTREAM_SOCKET_ERROR ${err.message}`)
        try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch (_) {}
      })
      clientSocket.on('error', (err) => {
        logBridge(`TUNNEL#${tunnelId} CLIENT_SOCKET_ERROR ${err.message}`)
        try { upstreamSocket.destroy() } catch (_) {}
      })
      clientSocket.on('close', () => {
        try { upstreamSocket.destroy() } catch (_) {}
      })
    })

    upstreamReq.on('error', (err) => {
      clearTimeout(timer)
      fail(`Upstream CONNECT error: ${err?.message || 'unknown'}`)
    })

    upstreamReq.end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, listenHost, () => {
      const address = server.address()
      const actualPort = address && typeof address === 'object' ? address.port : listenPort
      logBridge(`BRIDGE_LISTENING http://${listenHost}:${actualPort} -> upstream ${upstreamProtocol} ${upstreamHost}:${upstreamPort} (auth=${authHeader ? 'yes' : 'no'})`)
      resolve({
        server,
        host: listenHost,
        port: actualPort,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      })
    })
  })
}

module.exports = {
  startProxyBridge,
}
