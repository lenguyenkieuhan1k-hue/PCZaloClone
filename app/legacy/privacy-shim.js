'use strict'

;(() => {
  const fs = require('fs')

  const SETTINGS_PATH = 'C:\\ProgramData\\ZaloMask\\privacy\\settings.json'
  const CACHE_TTL_MS = 1000
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
  const RULES = [
    {
      key: 'hideTyping',
      match: (url) => /\/api\/(message|group)\/typing(?:\?|$)/i.test(url)
    },
    {
      key: 'hideSeen',
      match: (url) => /\/api\/(message\/seen|message\/seenv2|group\/seen|group\/seenv2|e2ee\/pc\/t\/message\/seen|e2ee\/pc\/t\/group\/seen)(?:\?|$)/i.test(url)
    },
    {
      key: 'hideReceived',
      match: (url) => /\/api\/(message\/delivered|message\/deliveredv2|group\/delivered|group\/deliveredv2|e2ee\/pc\/t\/message\/delivered|e2ee\/pc\/t\/group\/delivered)(?:\?|$)/i.test(url)
    }
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
    return RULES.find((rule) => settings[rule.key] && rule.match(url)) || null
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
      const rule = findRule(url)
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
      const rule = findRule(this.__zmUrl)
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
      const rule = findRule(toUrlString(url))
      if (rule) return true
      return originalSendBeacon(url, data)
    }
    wrappedBeacon.__zalomaskWrapped = true
    navigator.sendBeacon = wrappedBeacon
  }

  patchFetch()
  patchXHR()
  patchBeacon()

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