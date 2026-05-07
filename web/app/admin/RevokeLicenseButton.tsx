'use client'

import { useState } from 'react'

export default function RevokeLicenseButton({ licenseId, keyText }: { licenseId: string; keyText: string }) {
  const [busy, setBusy] = useState(false)

  async function handleRevoke() {
    if (busy) return
    const ok = confirm(`Thu hồi key ${keyText}?`) 
    if (!ok) return

    setBusy(true)
    try {
      const rs = await fetch('/api/admin/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseId, reason: 'revoke-from-admin-ui' }),
      })
      const data = await rs.json().catch(() => ({}))
      if (!rs.ok || !data?.ok) {
        alert('Thu hồi thất bại: ' + (data?.message || `HTTP ${rs.status}`))
        return
      }
      alert(data?.alreadyRevoked ? 'Key đã bị thu hồi trước đó.' : 'Đã thu hồi key thành công.')
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="px-2 py-1 text-xs rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50"
      onClick={handleRevoke}
      disabled={busy}
    >
      {busy ? 'Đang thu hồi...' : 'Thu hồi'}
    </button>
  )
}
