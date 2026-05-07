'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatVnd, DURATION_LABEL, DURATION_DAYS, type Duration } from '@/lib/plans'

interface License {
  id: string
  license_id: string
  key: string
  tier_id: string
  account_quota: number
  duration: Duration
  expires_at: string
  status: string
  active_machine_id?: string
  profileCount: number
}

interface LicenseTableProps {
  licenses: License[]
  onLicensesUpdate?: () => void
}

export default function LicenseTable({ licenses, onLicensesUpdate }: LicenseTableProps) {
  const router = useRouter()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showRenewModal, setShowRenewModal] = useState<string | null>(null)
  const [showUpgradeModal, setShowUpgradeModal] = useState<string | null>(null)
  const [showDeactivateModal, setShowDeactivateModal] = useState<string | null>(null)
  const [renewDuration, setRenewDuration] = useState<Duration>('1m')
  const [upgradeTier, setUpgradeTier] = useState<string>('')
  const [upgradeDuration, setUpgradeDuration] = useState<Duration>('1m')
  const [deactivateReason, setDeactivateReason] = useState<string>('no-longer-needed')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  const isExpired = (license: License) => new Date(license.expires_at) < new Date()

  const handleRenew = async (licenseId: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/renew-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_id: licenseId, duration: renewDuration }),
      })

      const data = await res.json()
      if (!data.ok) {
        setError(data.message)
        return
      }

      setShowRenewModal(null)
      // Redirect to renewal checkout page
      router.push(`/checkout/renew/${data.licenseId}`)
    } catch (err) {
      setError('Lỗi kết nối')
    } finally {
      setLoading(false)
    }
  }

  const handleUpgrade = async (licenseId: string) => {
    if (!upgradeTier) {
      setError('Chọn gói nâng cấp')
      return
    }

    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/upgrade-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          licenseid: licenseId,
          new_tier_id: upgradeTier,
          duration: upgradeDuration,
        }),
      })

      const data = await res.json()
      if (!data.ok) {
        setError(data.message)
        return
      }

      setShowUpgradeModal(null)
      // Redirect to upgrade checkout page
      router.push(`/checkout/upgrade/${data.newLicenseId}`)
    } catch (err) {
      setError('Lỗi kết nối')
    } finally {
      setLoading(false)
    }
  }

  const handleDeactivate = async (licenseId: string) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/deactivate-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_id: licenseId, reason: deactivateReason }),
      })

      const data = await res.json()
      if (!data.ok) {
        setError(data.message)
        return
      }

      setShowDeactivateModal(null)
      alert(`License đã huỷ bỏ.\n\n⚠️ Profiles sẽ bị xoá sau 24h.\nBạn vẫn có thể khôi phục từ đám mây trong thời gian này.`)
      onLicensesUpdate?.()
    } catch (err) {
      setError('Lỗi kết nối')
    } finally {
      setLoading(false)
    }
  }

  if (!licenses || licenses.length === 0) {
    return (
      <div className="mt-4 p-8 border border-dashed rounded-xl">
        <p className="text-gray-700 font-medium">Bạn chưa kích hoạt key trả phí.</p>
        <p className="mt-2 text-sm text-gray-600">Hiện tại bạn vẫn dùng được theo gói miễn phí: tối đa 1 tài khoản Zalo.</p>
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-4">
      {licenses.map((license) => (
        <div key={license.id} className="border border-gray-200 rounded-xl overflow-hidden">
          <div
            className="p-5 cursor-pointer hover:bg-gray-50 flex items-center justify-between"
            onClick={() => setExpandedId(expandedId === license.id ? null : license.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3">
                <div>
                  <div className="font-mono text-lg font-semibold">{license.key}</div>
                  <div className="mt-1 text-sm text-gray-600">
                    {license.tier_id} • {license.account_quota} Zalo • {license.profileCount} profiles
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Hợp đồng: {DURATION_LABEL[license.duration]} • Hết hạn:{' '}
                    <span className={isExpired(license) ? 'text-red-600 font-semibold' : ''}>
                      {new Date(license.expires_at).toLocaleDateString('vi-VN')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  isExpired(license)
                    ? 'bg-red-100 text-red-700'
                    : license.status === 'active'
                      ? 'bg-green-100 text-green-700'
                      : 'bg-gray-100 text-gray-700'
                }`}
              >
                {isExpired(license) ? 'Hết hạn' : license.status}
              </span>
              <svg className={`w-5 h-5 text-gray-400 transition ${expandedId === license.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
          </div>

          {expandedId === license.id && (
            <div className="border-t border-gray-200 bg-gray-50 p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-500">Gói</div>
                  <div className="font-semibold">{license.tier_id}</div>
                </div>
                <div>
                  <div className="text-gray-500">Số lượng Zalo</div>
                  <div className="font-semibold">{license.account_quota}</div>
                </div>
                <div>
                  <div className="text-gray-500">Hợp đồng</div>
                  <div className="font-semibold">{DURATION_LABEL[license.duration]}</div>
                </div>
                <div>
                  <div className="text-gray-500">Profiles</div>
                  <div className="font-semibold">{license.profileCount} / {license.account_quota}</div>
                </div>
              </div>

              <div className="pt-4 flex flex-wrap gap-2">
                {!isExpired(license) && (
                  <>
                    <button
                      onClick={() => setShowUpgradeModal(license.id)}
                      className="px-4 py-2 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 text-sm font-medium"
                    >
                      Nâng cấp tier
                    </button>
                    <button
                      onClick={() => setShowRenewModal(license.id)}
                      className="px-4 py-2 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 text-sm font-medium"
                    >
                      Gia hạn
                    </button>
                  </>
                )}
                <button
                  onClick={() => setShowDeactivateModal(license.id)}
                  className="px-4 py-2 rounded-lg bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 text-sm font-medium"
                >
                  Huỷ bỏ
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Renew Modal */}
      {showRenewModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl max-w-md w-full mx-4 p-6 shadow-xl">
            <h3 className="text-xl font-bold">Gia hạn License</h3>
            <p className="mt-2 text-sm text-gray-600">
              Key: <span className="font-mono">{licenses.find((l) => l.id === showRenewModal)?.key}</span>
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Chọn thời hạn</label>
                <select
                  value={renewDuration}
                  onChange={(e) => setRenewDuration(e.target.value as Duration)}
                  className="mt-2 w-full p-2 border border-gray-300 rounded-lg"
                >
                  <option value="1m">1 tháng</option>
                  <option value="3m">3 tháng</option>
                  <option value="6m">6 tháng</option>
                  <option value="1y">1 năm</option>
                </select>
              </div>

              {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}

              <div className="flex gap-3">
                <button
                  onClick={() => setShowRenewModal(null)}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                  disabled={loading}
                >
                  Hủy
                </button>
                <button
                  onClick={() => handleRenew(showRenewModal)}
                  className="flex-1 px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium"
                  disabled={loading}
                >
                  {loading ? 'Đang xử lý...' : 'Tiếp tục'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deactivate Modal */}
      {showDeactivateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl max-w-md w-full mx-4 p-6 shadow-xl">
            <h3 className="text-xl font-bold text-red-700">⚠️ Huỷ bỏ License</h3>
            <p className="mt-2 text-sm text-gray-600">
              Key: <span className="font-mono">{licenses.find((l) => l.id === showDeactivateModal)?.key}</span>
            </p>

            <div className="mt-4 p-3 rounded-lg bg-red-50 text-red-800 text-sm">
              <p className="font-semibold">⚠️ Chú ý quan trọng:</p>
              <ul className="mt-2 space-y-1 text-xs">
                <li>• Tất cả profiles sẽ bị xoá sau 24 giờ</li>
                <li>• Nhưng bạn vẫn có thể khôi phục từ đám mây</li>
                <li>• Nếu cần, mở lại app trong 24h để huỷ hành động</li>
              </ul>
            </div>

            <div className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Lý do huỷ bỏ (optional)</label>
                <select
                  value={deactivateReason}
                  onChange={(e) => setDeactivateReason(e.target.value)}
                  className="mt-2 w-full p-2 border border-gray-300 rounded-lg text-sm"
                >
                  <option value="no-longer-needed">Không cần nữa</option>
                  <option value="switching-key">Chuyển sang key khác</option>
                  <option value="testing">Chỉ để test</option>
                  <option value="other">Lý do khác</option>
                </select>
              </div>

              {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeactivateModal(null)}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                  disabled={loading}
                >
                  Hủy
                </button>
                <button
                  onClick={() => handleDeactivate(showDeactivateModal)}
                  className="flex-1 px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium"
                  disabled={loading}
                >
                  {loading ? 'Đang xử lý...' : 'Xác nhận huỷ bỏ'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upgrade Modal */}
      {showUpgradeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl max-w-md w-full mx-4 p-6 shadow-xl">
            <h3 className="text-xl font-bold">Nâng cấp Tier</h3>
            <p className="mt-2 text-sm text-gray-600">
              Key: <span className="font-mono">{licenses.find((l) => l.id === showUpgradeModal)?.key}</span>
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Tier mới</label>
                <select
                  value={upgradeTier}
                  onChange={(e) => setUpgradeTier(e.target.value)}
                  className="mt-2 w-full p-2 border border-gray-300 rounded-lg"
                >
                  <option value="">-- Chọn --</option>
                  <option value="tier-test-1k">Tier-Test (2 Zalo) - 3.000đ</option>
                  <option value="tier-10">Tier-10 (10 Zalo)</option>
                  <option value="tier-15">Tier-15 (15 Zalo)</option>
                  <option value="tier-25">Tier-25 (25 Zalo)</option>
                  <option value="tier-50">Tier-50 (50 Zalo)</option>
                  <option value="tier-100">Tier-100 (100 Zalo)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Thời hạn</label>
                <select
                  value={upgradeDuration}
                  onChange={(e) => setUpgradeDuration(e.target.value as Duration)}
                  className="mt-2 w-full p-2 border border-gray-300 rounded-lg"
                >
                  <option value="1m">1 tháng</option>
                  <option value="3m">3 tháng</option>
                  <option value="6m">6 tháng</option>
                  <option value="1y">1 năm</option>
                </select>
              </div>

              {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}

              <div className="flex gap-3">
                <button
                  onClick={() => setShowUpgradeModal(null)}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                  disabled={loading}
                >
                  Hủy
                </button>
                <button
                  onClick={() => handleUpgrade(showUpgradeModal)}
                  className="flex-1 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium"
                  disabled={loading}
                >
                  {loading ? 'Đang xử lý...' : 'Tiếp tục'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
