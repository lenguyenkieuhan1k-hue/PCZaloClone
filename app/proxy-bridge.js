'use strict'

const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const { URL } = require('url')

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

  const server = http.createServer()

  server.on('request', (req, res) => {
    let targetUrl
    try {
      targetUrl = new URL(req.url)
    } catch (error) {
      res.writeHead(400)
      res.end('Bad proxy request URL')
      return
    }

    const headers = { ...req.headers }
    delete headers['proxy-connection']
    if (authHeader) headers['proxy-authorization'] = authHeader
    headers.host = targetUrl.host

    const upstreamReq = (useTlsUpstream ? https : http).request({
      host: upstreamHost,
      port: upstreamPort,
      servername: useTlsUpstream ? upstreamHost : undefined,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.statusMessage || '', upstreamRes.headers)
      upstreamRes.pipe(res)
    })

    upstreamReq.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502)
      res.end(`Proxy bridge error: ${error.message}`)
    })

    req.pipe(upstreamReq)
  })

  server.on('connect', (req, clientSocket, head) => {
    const fail = (message) => {
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

    // Use http(s).request CONNECT to avoid subtle formatting differences.
    const connectHeaders = {
      Host: req.url,
      'User-Agent': BRIDGE_UA,
      Connection: 'keep-alive',
      'Proxy-Connection': 'Keep-Alive',
    }
    if (authHeader) connectHeaders['Proxy-Authorization'] = authHeader

    const upstreamReq = (useTlsUpstream ? https : http).request({
      host: upstreamHost,
      port: upstreamPort,
      servername: useTlsUpstream ? upstreamHost : undefined,
      method: 'CONNECT',
      path: req.url,
      headers: connectHeaders,
    })

    const timer = setTimeout(() => {
      try { upstreamReq.destroy(new Error('upstream CONNECT timeout')) } catch (_) {}
      fail('Proxy bridge timeout waiting for upstream CONNECT response')
    }, 6500)

    upstreamReq.once('connect', (upstreamRes, upstreamSocket, upstreamHead) => {
      clearTimeout(timer)
      try { upstreamSocket.setNoDelay(true) } catch (_) {}
      const statusCode = Number(upstreamRes && upstreamRes.statusCode || 0)
      if (statusCode !== 200) {
        const statusLine = `HTTP/${upstreamRes.httpVersion || '1.1'} ${statusCode} ${upstreamRes.statusMessage || ''}`.trim()
        try { upstreamSocket.destroy() } catch (_) {}
        fail(statusLine || 'CONNECT failed')
        return
      }

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead)
      if (head && head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)

      upstreamSocket.on('error', () => {
        try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch (_) {}
      })
      clientSocket.on('error', () => {
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
      resolve({
        server,
        host: listenHost,
        port: address && typeof address === 'object' ? address.port : listenPort,
        close: () => new Promise((closeResolve) => server.close(() => closeResolve())),
      })
    })
  })
}

module.exports = {
  startProxyBridge,
}
