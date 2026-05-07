'use client'
import { useState } from 'react'
import { PLAN_TIERS } from '@/lib/plans'

interface CreatedKey {
  key: string
  expiresAt: string
}

export default function CreateKeyForm() {
  const [tierId, setTierId] = useState('tier-6')
  const [accountQuota, setAccountQuota] = useState('')
  const [expiresAt, setExpiresAt] = useState(() => {
    // default: 1 tháng từ hôm nay
    const d = new Date()
    d.setMonth(d.getMonth() + 1)
    return d.toISOString().slice(0, 10)
  })
  const [userEmail, setUserEmail] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CreatedKey | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const selectedTier = PLAN_TIERS.find(t => t.id === tierId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    setError('')
    setCopied(false)
    try {
      const res = await fetch('/api/admin/create-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tierId,
          accountQuota: accountQuota ? Number(accountQuota) : undefined,
          expiresAt,
          userEmail: userEmail || undefined,
          note: note || undefined,
        }),
      })
      const json = await res.json()
      if (!json.ok) { setError(json.message || 'Lỗi không xác định'); return }
      setResult({ key: json.key, expiresAt: json.expiresAt })
    } catch (err: any) {
      setError(err?.message || 'Lỗi mạng')
    } finally {
      setLoading(false)
    }
  }

  function copyKey() {
    if (!result?.key) return
    navigator.clipboard.writeText(result.key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  return (
    <div className="border rounded-xl p-6 mt-2">
      <form onSubmit={handleSubmit} className="grid sm:grid-cols-2 gap-4">
        {/* Tier */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Gói (tier)</label>
          <select
            className="w-full border rounded-lg px-3 py-2 text-sm"
            value={tierId}
            onChange={e => { setTierId(e.target.value); setAccountQuota('') }}
            required
          >
            {PLAN_TIERS.filter(t => t.id !== 'tier-1').map(t => (
              <option key={t.id} value={t.id}>{t.label} ({t.accountQuota} acc)</option>
            ))}
          </select>
        </div>

        {/* Custom quota */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Quota tuỳ chỉnh <span className="text-gray-400">(để trống = mặc định {selectedTier?.accountQuota})</span>
          </label>
          <input
            type="number"
            min={1}
            max={9999}
            placeholder={String(selectedTier?.accountQuota ?? '')}
            className="w-full border rounded-lg px-3 py-2 text-sm"
            value={accountQuota}
            onChange={e => setAccountQuota(e.target.value)}
          />
        </div>

        {/* Ngày hết hạn */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Ngày hết hạn</label>
          <input
            type="date"
            required
            className="w-full border rounded-lg px-3 py-2 text-sm"
            value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)}
          />
        </div>

        {/* Email user (optional) */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Email user <span className="text-gray-400">(tuỳ chọn — gán ngay cho user)</span>
          </label>
          <input
            type="email"
            placeholder="user@example.com"
            className="w-full border rounded-lg px-3 py-2 text-sm"
            value={userEmail}
            onChange={e => setUserEmail(e.target.value)}
          />
        </div>

        {/* Ghi chú */}
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-600 mb-1">Ghi chú nội bộ</label>
          <input
            type="text"
            maxLength={200}
            placeholder="VD: Key tặng cho đối tác ABC"
            className="w-full border rounded-lg px-3 py-2 text-sm"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-6 py-2 rounded-lg text-sm transition"
          >
            {loading ? 'Đang tạo…' : 'Tạo key'}
          </button>
        </div>
      </form>

      {error && (
        <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 bg-green-50 border border-green-200 rounded-lg px-4 py-4">
          <p className="text-xs text-green-700 font-medium mb-1">Key đã tạo thành công</p>
          <div className="flex items-center gap-3">
            <code className="text-lg font-mono font-bold text-green-800 flex-1 break-all">{result.key}</code>
            <button
              onClick={copyKey}
              className="text-xs bg-white border border-green-300 hover:bg-green-100 px-3 py-1.5 rounded-lg transition shrink-0"
            >
              {copied ? 'Đã copy!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-green-600 mt-1">
            Hết hạn: {new Date(result.expiresAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
          </p>
        </div>
      )}
    </div>
  )
}
