'use strict'

const { ipcRenderer } = require('electron')

function getArg(prefix) {
  const entry = process.argv.find((x) => typeof x === 'string' && x.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : ''
}

const profileName = getArg('--zalomask-profile=') || ''
const zUuidArg = getArg('--zalomask-zuuid=') || ''

function readFingerprintFromMain() {
  try {
    const rs = ipcRenderer.sendSync('v2:get-fingerprint-seed', { profileName })
    const obj = rs && rs.fingerprint
    return obj && typeof obj === 'object' ? obj : {}
  } catch (_) {
    return {}
  }
}

const fingerprint = readFingerprintFromMain()

function defineNavigatorGetter(key, value) {
  try {
    Object.defineProperty(Navigator.prototype, key, {
      configurable: true,
      get: () => value,
    })
  } catch (_) {}
}

function applyFingerprint() {
  try {
    const ua = String(fingerprint.userAgent || '')
    const language = String(fingerprint.language || 'vi-VN')
    const languages = Array.isArray(fingerprint.languages) && fingerprint.languages.length
      ? fingerprint.languages.map((x) => String(x || '').trim()).filter(Boolean)
      : [language, 'en-US', 'en']

    if (ua) defineNavigatorGetter('userAgent', ua)
    defineNavigatorGetter('platform', String(fingerprint.platform || 'Win32'))
    defineNavigatorGetter('vendor', String(fingerprint.vendor || 'Google Inc.'))
    defineNavigatorGetter('language', language)
    defineNavigatorGetter('languages', languages)
    defineNavigatorGetter('hardwareConcurrency', Number(fingerprint.hardwareConcurrency || 8))
    defineNavigatorGetter('deviceMemory', Number(fingerprint.deviceMemory || 8))
    defineNavigatorGetter('maxTouchPoints', Number(fingerprint.maxTouchPoints || 0))

    const tz = String(fingerprint.timezone || '')
    if (tz) {
      const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
      Intl.DateTimeFormat.prototype.resolvedOptions = function patchedResolvedOptions(...args) {
        const rs = originalResolvedOptions.apply(this, args)
        return { ...rs, timeZone: tz }
      }
    }

    const webglVendor = String(fingerprint.webglVendor || '')
    const webglRenderer = String(fingerprint.webglRenderer || '')
    const VENDOR_CONST = 37445
    const RENDERER_CONST = 37446

    function patchWebGL(proto) {
      if (!proto || typeof proto.getParameter !== 'function') return
      const original = proto.getParameter
      Object.defineProperty(proto, 'getParameter', {
        configurable: true,
        value(parameter) {
          if (parameter === VENDOR_CONST && webglVendor) return webglVendor
          if (parameter === RENDERER_CONST && webglRenderer) return webglRenderer
          return original.apply(this, arguments)
        },
      })
    }

    patchWebGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype)
    patchWebGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype)

    try {
      Object.defineProperty(window, '__zalomaskFingerprint', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: {
          id: String(fingerprint.id || ''),
          userAgent: ua,
          language,
          timezone: tz,
        },
      })
    } catch (_) {}
  } catch (_) {}
}

function readSeedFromMain() {
  try {
    const rs = ipcRenderer.sendSync('v2:get-ls-seed', { profileName })
    const obj = rs && rs.seed
    return obj && typeof obj === 'object' ? obj : {}
  } catch (_) {
    return {}
  }
}

const seed = readSeedFromMain()
applyFingerprint()

function seedLocalStorage() {
  try {
    if (!window.localStorage) return
    const keys = Object.keys(seed)
    for (const k of keys) {
      try {
        window.localStorage.setItem(k, String(seed[k]))
      } catch (_) {}
    }

    const zUuid = zUuidArg || seed.z_uuid || seed.sh_z_uuid || ''
    if (zUuid) {
      try { window.localStorage.setItem('z_uuid', zUuid) } catch (_) {}
      try { window.localStorage.setItem('sh_z_uuid', zUuid) } catch (_) {}
    }
  } catch (_) {}
}

function capture(reason) {
  try {
    const data = {}
    const ls = window.localStorage
    if (!ls) return

    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i)
      if (!k) continue
      data[k] = ls.getItem(k)
    }

    const zUuid = data.z_uuid || data.sh_z_uuid || zUuidArg || ''
    ipcRenderer.send('v2:web-session-snapshot', {
      profileName,
      reason,
      zUuid,
      localStorage: data,
      href: location.href,
      capturedAt: Date.now(),
    })
  } catch (_) {}
}

seedLocalStorage()

window.addEventListener('DOMContentLoaded', () => {
  seedLocalStorage()
})

window.addEventListener('load', () => {
  seedLocalStorage()
  setTimeout(() => capture('load+5s'), 5000)
  setTimeout(() => capture('load+20s'), 20000)
})

window.addEventListener('beforeunload', () => {
  capture('beforeunload')
})
