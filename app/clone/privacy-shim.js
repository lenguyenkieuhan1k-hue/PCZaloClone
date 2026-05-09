'use strict'

;(() => {
  const fs = require('fs')
  const path = require('path')

  // Per-profile settings file so each Zalo instance reads only its own privacy flags.
  const _profileName = (typeof process !== 'undefined' && process.env && process.env.ZALOMASK_PROFILE_NAME) || 'default'
  const _programData = (typeof process !== 'undefined' && process.env && process.env.ProgramData) || 'C:\\ProgramData'
  const SETTINGS_PATH = path.join(_programData, 'ZaloMask', 'privacy', _profileName + '.json')
  const WS_LOG_PATH = path.join(_programData, 'ZaloMask', 'privacy', _profileName + '.wslog.jsonl')
  const SHIM_MARKER_PATH = path.join(_programData, 'ZaloMask', 'privacy', _profileName + '.shim-loaded.json')
  const CACHE_TTL_MS = 1000
  const WS_LOG_THROTTLE_MS = 1200
  const WS_LOG_CANDIDATE_THROTTLE_MS = 2500
  const SUCCESS_BODY = JSON.stringify({
    error: 0,
    err: 0,
    error_code: 0,
    success: true,
    data: {
      error: 0,
      err: 0,
      success: true,
      group: {},
      oneone: {},
      data: {}
    }
  })
  const URL_RULES = [
    {
      id: 'URL.TYPING.V1',
      key: 'hideTyping',
      match: (url) => /(?:\/api\/.*\/typing|\/typing(?:v\d+)?|\btyping\b|is[_-]?typing|typing[_-]?status|composer(?:\/|$)|presence(?:\/|$)|\/chat\/typing)(?:\?|$|\/|\b)/i.test(url)
    },
    {
      id: 'URL.SEEN.V1',
      key: 'hideSeen',
      match: (url) => /(?:\/api\/(?:message|group|conversation)\/(?:seen|seenv\d+|read|mark-read|read-receipt)|\/e2ee\/pc\/t\/(?:message|group)\/seen|(?:\b|[\/_-])(?:seen|read|read[_-]?receipt)(?:v\d+)?(?:\b|[\/_-]))(?:\?|$|\/)?/i.test(url)
    },
    {
      id: 'URL.RECEIVED.V1',
      key: 'hideReceived',
      match: (url) => /(?:\/api\/(?:message|group|conversation)\/(?:delivered|deliveredv\d+|received|recv|ack|receipt)|\/e2ee\/pc\/t\/(?:message|group)\/delivered|(?:\b|[\/_-])(?:delivered|received|recv|ack|receipt)(?:v\d+)?(?:\b|[\/_-]))(?:\?|$|\/)?/i.test(url)
    }
  ]
  const PAYLOAD_RULES = [
    {
      id: 'PAYLOAD.TYPING.V1',
      key: 'hideTyping',
      match: (text) => /(?:\btyping\b|isTyping|is_typing|typing_status|\"type\"\s*:\s*\"typing\"|\"event\"\s*:\s*\"typing\"|\"composing\"\s*:\s*true)/i.test(text),
    },
    {
      id: 'PAYLOAD.SEEN.V1',
      key: 'hideSeen',
      match: (text) => /(?:\bseen\b|read_receipt|readReceipt|mark[_-]?read|\"seen\"\s*:|\"read\"\s*:|\"readAt\"\s*:)/i.test(text),
    },
    {
      id: 'PAYLOAD.RECEIVED.V1',
      key: 'hideReceived',
      match: (text) => /(?:\bdelivered\b|\breceived\b|\brecv\b|receipt|\"delivered\"\s*:|\"received\"\s*:|\"ack\"\s*:)/i.test(text),
    },
  ]

  let settingsCache = {
    expiresAt: 0,
    value: {
      hideTyping: false,
      hideSeen: false,
      hideReceived: false,
      hideLastSeen: false,
    }
  }
  const wsLogCache = new Map()

  function writeShimMarker() {
    try {
      fs.writeFileSync(SHIM_MARKER_PATH, JSON.stringify({
        loadedAt: new Date().toISOString(),
        profile: _profileName,
        version: 'privacy-shim-wsdiag-v3',
      }), 'utf8')
    } catch {}
  }

  function writeWsLog(entry, options = {}) {
    try {
      const now = Date.now()
      const key = String(options.key || entry.ruleId || entry.event || 'ws')
      const throttle = Number(options.throttleMs || WS_LOG_THROTTLE_MS)
      const last = Number(wsLogCache.get(key) || 0)
      if (throttle > 0 && (now - last) < throttle) return
      wsLogCache.set(key, now)

      const line = JSON.stringify({
        ts: new Date(now).toISOString(),
        profile: _profileName,
        ...entry,
      })
      fs.appendFileSync(WS_LOG_PATH, line + '\n', 'utf8')
    } catch {}
  }

  function previewText(input) {
    const text = String(input || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return ''
    return text.slice(0, 140)
  }

  function getPayloadHexPrefix(input, maxBytes = 24) {
    try {
      let view = null
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
        view = new Uint8Array(input)
      } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      }
      if (!view || !view.length) return ''
      const n = Math.min(Math.max(0, Number(maxBytes || 24)), view.length)
      let hex = ''
      for (let i = 0; i < n; i++) hex += view[i].toString(16).padStart(2, '0')
      return hex
    } catch {
      return ''
    }
  }

  function readSettings() {
    if (Date.now() < settingsCache.expiresAt) return settingsCache.value
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8')
      const parsed = JSON.parse(raw)
      settingsCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: {
          hideTyping: !!parsed.hideTyping,
          hideSeen: !!parsed.hideSeen,
          hideReceived: !!parsed.hideReceived,
          hideLastSeen: !!parsed.hideLastSeen,
        }
      }
    } catch {
      settingsCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: {
          hideTyping: false,
          hideSeen: false,
          hideReceived: false,
          hideLastSeen: false,
        }
      }
    }
    return settingsCache.value
  }

  function toUrlString(input) {
    if (!input) return ''
    if (typeof input === 'string') return input
    if (typeof input.url === 'string') return input.url
    return String(input)
  }

  function findRule(url) {
    if (!url) return null
    const settings = readSettings()
    return URL_RULES.find((rule) => settings[rule.key] && rule.match(url)) || null
  }

  function decodePayloadToText(input) {
    try {
      if (input == null) return ''
      if (typeof input === 'string') return input
      if (typeof URLSearchParams !== 'undefined' && input instanceof URLSearchParams) return input.toString()
      if (typeof FormData !== 'undefined' && input instanceof FormData) {
        const pairs = []
        for (const [k, v] of input.entries()) pairs.push(String(k) + '=' + String(v))
        return pairs.join('&')
      }
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
        if (typeof TextDecoder === 'function') return new TextDecoder().decode(new Uint8Array(input))
        return ''
      }
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        if (typeof TextDecoder === 'function') return new TextDecoder().decode(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))
        return ''
      }
      if (typeof Blob !== 'undefined' && input instanceof Blob) {
        // Blob cannot be inspected synchronously in send(); skip here.
        return ''
      }
      if (typeof input === 'object') {
        try { return JSON.stringify(input) } catch {}
      }
      return String(input)
    } catch {
      return ''
    }
  }

  function findPayloadRule(text) {
    if (!text) return null
    const settings = readSettings()
    const hay = String(text)
    return PAYLOAD_RULES.find((rule) => settings[rule.key] && rule.match(hay)) || null
  }

  function buildResponseBody(rule) {
    return SUCCESS_BODY
  }

  function makeFetchResponse(rule, url) {
    return new Response(buildResponseBody(rule), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-zalomask-privacy': rule.key,
        'x-zalomask-url': url
      }
    })
  }

  function dispatchEventSafe(target, name, ctorName) {
    try {
      const EventCtor = typeof window !== 'undefined' && window[ctorName] ? window[ctorName] : Event
      target.dispatchEvent(new EventCtor(name))
    } catch {}
  }

  function setValue(target, key, value) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value
      })
      return true
    } catch {
      return false
    }
  }

  function respondToXHR(xhr, rule) {
    const body = buildResponseBody(rule)
    const url = xhr.__zmUrl || ''
    queueMicrotask(() => {
      setValue(xhr, 'readyState', 2)
      setValue(xhr, 'status', 200)
      setValue(xhr, 'statusText', 'OK')
      setValue(xhr, 'responseURL', url)
      dispatchEventSafe(xhr, 'readystatechange', 'Event')

      setValue(xhr, 'readyState', 4)
      setValue(xhr, 'responseText', body)
      setValue(xhr, 'response', body)
      dispatchEventSafe(xhr, 'readystatechange', 'Event')

      if (typeof xhr.onload === 'function') {
        try { xhr.onload(new Event('load')) } catch {}
      }
      dispatchEventSafe(xhr, 'load', 'ProgressEvent')
      dispatchEventSafe(xhr, 'loadend', 'ProgressEvent')
    })
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__zalomaskWrapped) return
    const originalFetch = window.fetch.bind(window)
    const wrappedFetch = function wrappedFetch(input, init) {
      const url = toUrlString(input)
      const rule = findRule(url) || findPayloadRule(decodePayloadToText(init && init.body))
      if (rule) return Promise.resolve(makeFetchResponse(rule, url))
      return originalFetch(input, init)
    }
    wrappedFetch.__zalomaskWrapped = true
    window.fetch = wrappedFetch
  }

  function patchXHR() {
    if (typeof window.XMLHttpRequest !== 'function') return
    const proto = window.XMLHttpRequest.prototype
    if (proto.__zalomaskWrapped) return

    const originalOpen = proto.open
    const originalSend = proto.send

    proto.open = function patchedOpen(method, url) {
      this.__zmMethod = method
      this.__zmUrl = toUrlString(url)
      return originalOpen.apply(this, arguments)
    }

    proto.send = function patchedSend() {
      const body = arguments.length ? arguments[0] : undefined
      const rule = findRule(this.__zmUrl) || findPayloadRule(decodePayloadToText(body))
      if (rule) {
        respondToXHR(this, rule)
        return undefined
      }
      return originalSend.apply(this, arguments)
    }

    proto.__zalomaskWrapped = true
  }

  function patchBeacon() {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function' || navigator.sendBeacon.__zalomaskWrapped) return
    const originalSendBeacon = navigator.sendBeacon.bind(navigator)
    const wrappedBeacon = function wrappedBeacon(url, data) {
      const rule = findRule(toUrlString(url)) || findPayloadRule(decodePayloadToText(data))
      if (rule) return true
      return originalSendBeacon(url, data)
    }
    wrappedBeacon.__zalomaskWrapped = true
    navigator.sendBeacon = wrappedBeacon
  }

  function findWsRule(text) {
    return findPayloadRule(text)
  }

  let lastTypingActivityAt = 0
  let lastEnterKeyAt = 0

  function markTypingActivity() {
    lastTypingActivityAt = Date.now()
  }

  function markEnterKey() {
    lastEnterKeyAt = Date.now()
  }

  function setupTypingSignals() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    if (window.__zalomaskTypingSignalsInstalled) return

    const onInput = () => markTypingActivity()
    const onComp = () => markTypingActivity()
    const onBeforeInput = () => markTypingActivity()
    const onKeyPress = () => markTypingActivity()
    const onKeyDown = (event) => {
      const key = event && event.key ? String(event.key) : ''
      if (key === 'Enter') {
        markEnterKey()
        return
      }
      markTypingActivity()
    }

    try {
      document.addEventListener('input', onInput, true)
      document.addEventListener('beforeinput', onBeforeInput, true)
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('keypress', onKeyPress, true)
      document.addEventListener('compositionstart', onComp, true)
      document.addEventListener('compositionupdate', onComp, true)
      document.addEventListener('compositionend', onComp, true)
      window.__zalomaskTypingSignalsInstalled = true
    } catch {}
  }

  function getPayloadByteLength(input) {
    try {
      if (input == null) return 0
      if (typeof input === 'string') return input.length
      if (typeof Blob !== 'undefined' && input instanceof Blob) return Number(input.size || 0)
      if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return Number(input.byteLength || 0)
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(input)) return Number(input.byteLength || 0)
    } catch {}
    return 0
  }

  function shouldDropBinaryTypingFrame(data, decodedText) {
    const settings = readSettings()
    if (!settings.hideTyping) return false
    const wsRule = findWsRule(decodedText)
    if (wsRule) return wsRule

    const now = Date.now()
    if (now - lastEnterKeyAt < 1600) return false

    const bytes = getPayloadByteLength(data)
    if (!bytes) return false
    if ((now - lastTypingActivityAt <= 9000) && bytes <= 768) {
      return { id: 'WS.TYPING.BINARY.HEURISTIC.V2', key: 'hideTyping' }
    }
    return false
  }

  function blobToTextAsync(blob) {
    return new Promise((resolve) => {
      try {
        if (!blob || typeof blob.arrayBuffer !== 'function') {
          resolve('')
          return
        }
        blob.arrayBuffer()
          .then((ab) => {
            try {
              if (typeof TextDecoder === 'function') {
                resolve(new TextDecoder().decode(new Uint8Array(ab)))
                return
              }
            } catch {}
            resolve('')
          })
          .catch(() => resolve(''))
      } catch {
        resolve('')
      }
    })
  }

  function patchWebSocket() {
    if (typeof window === 'undefined' || typeof window.WebSocket !== 'function') return
    setupTypingSignals()
    const proto = window.WebSocket.prototype
    if (!proto || proto.__zalomaskWrappedSend) return

    const originalSend = proto.send
    proto.send = function patchedSend(data) {
      try {
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
          const ws = this
          blobToTextAsync(data).then((text) => {
            try {
              const rule = shouldDropBinaryTypingFrame(data, text)
              if (rule) {
                writeWsLog({
                  event: 'ws_drop',
                  ruleId: rule.id || 'unknown',
                  ruleKey: rule.key || '',
                  bytes: Number(data && data.size || 0),
                  payloadPreview: previewText(text),
                }, { key: 'drop:' + String(rule.id || 'unknown') })
                return
              }
              const candidate = readSettings().hideTyping && getPayloadByteLength(data) <= 768 && (Date.now() - lastTypingActivityAt <= 9000)
              if (candidate) {
                writeWsLog({
                  event: 'ws_pass_candidate',
                  ruleId: 'WS.TYPING.BINARY.HEURISTIC.V2',
                  bytes: Number(data && data.size || 0),
                  payloadPreview: previewText(text),
                }, { key: 'pass-candidate-blob', throttleMs: WS_LOG_CANDIDATE_THROTTLE_MS })
              } else if (readSettings().hideTyping) {
                writeWsLog({
                  event: 'ws_send_sample',
                  transport: 'blob',
                  bytes: Number(data && data.size || 0),
                }, { key: 'send-sample-blob', throttleMs: 10000 })
              }
              originalSend.call(ws, data)
            } catch {
              try { originalSend.call(ws, data) } catch {}
            }
          })
          return undefined
        }
        const decoded = decodePayloadToText(data)
        const rule = shouldDropBinaryTypingFrame(data, decoded)
        if (rule) {
          writeWsLog({
            event: 'ws_drop',
            ruleId: rule.id || 'unknown',
            ruleKey: rule.key || '',
            bytes: getPayloadByteLength(data),
            hexPrefix: getPayloadHexPrefix(data),
            payloadPreview: previewText(decoded),
          }, { key: 'drop:' + String(rule.id || 'unknown') })
          return undefined
        }
        if (readSettings().hideTyping && getPayloadByteLength(data) <= 768 && (Date.now() - lastTypingActivityAt <= 9000)) {
          writeWsLog({
            event: 'ws_pass_candidate',
            ruleId: 'WS.TYPING.BINARY.HEURISTIC.V2',
            bytes: getPayloadByteLength(data),
            hexPrefix: getPayloadHexPrefix(data),
            payloadPreview: previewText(decoded),
          }, { key: 'pass-candidate-binary', throttleMs: WS_LOG_CANDIDATE_THROTTLE_MS })
        } else if (readSettings().hideTyping) {
          writeWsLog({
            event: 'ws_send_sample',
            transport: 'buffer',
            bytes: getPayloadByteLength(data),
            hexPrefix: getPayloadHexPrefix(data),
          }, { key: 'send-sample-buffer', throttleMs: 10000 })
        }
      } catch {}
      return originalSend.apply(this, arguments)
    }

    proto.__zalomaskWrappedSend = true
  }

  patchFetch()
  patchXHR()
  patchBeacon()
  patchWebSocket()
  writeShimMarker()
  writeWsLog({ event: 'shim_loaded', ruleSet: 'v3' }, { key: 'shim-loaded', throttleMs: 0 })

  function pinStorageIdentity(storage, cloneImei) {
    if (!storage || !cloneImei) return
    const targetKeys = new Set(['sh_z_uuid', 'z_uuid'])
    try {
      if (!storage.__zalomaskIdentityPinned) {
        const originalGetItem = typeof storage.getItem === 'function' ? storage.getItem.bind(storage) : null
        const originalSetItem = typeof storage.setItem === 'function' ? storage.setItem.bind(storage) : null
        const originalRemoveItem = typeof storage.removeItem === 'function' ? storage.removeItem.bind(storage) : null
        const originalClear = typeof storage.clear === 'function' ? storage.clear.bind(storage) : null

        if (originalGetItem) {
          storage.getItem = function patchedGetItem(key) {
            if (targetKeys.has(String(key || ''))) return cloneImei
            return originalGetItem(key)
          }
        }

        if (originalSetItem) {
          storage.setItem = function patchedSetItem(key, value) {
            if (targetKeys.has(String(key || ''))) return originalSetItem(key, cloneImei)
            return originalSetItem(key, value)
          }
        }

        if (originalRemoveItem) {
          storage.removeItem = function patchedRemoveItem(key) {
            if (targetKeys.has(String(key || ''))) return originalSetItem ? originalSetItem(key, cloneImei) : undefined
            return originalRemoveItem(key)
          }
        }

        if (originalClear) {
          storage.clear = function patchedClear() {
            const result = originalClear()
            if (originalSetItem) {
              for (const key of targetKeys) originalSetItem(key, cloneImei)
            }
            return result
          }
        }

        try {
          Object.defineProperty(storage, '__zalomaskIdentityPinned', {
            configurable: true,
            enumerable: false,
            writable: false,
            value: true,
          })
        } catch {}
      }

      for (const key of targetKeys) {
        try { storage.setItem(key, cloneImei) } catch {}
        try {
          Object.defineProperty(storage, key, {
            configurable: true,
            enumerable: true,
            get() { return cloneImei },
            set() {
              try { storage.setItem(key, cloneImei) } catch {}
            }
          })
        } catch {}
      }
    } catch {}
  }

  try {
    const cloneImei = typeof process !== 'undefined' && process && process.env
      ? String(process.env.ZALOMASK_CLONE_IMEI || '').trim()
      : ''
    if (cloneImei && typeof window !== 'undefined') {
      pinStorageIdentity(window.localStorage, cloneImei)
      pinStorageIdentity(window.sessionStorage, cloneImei)
    }
  } catch {}
})()