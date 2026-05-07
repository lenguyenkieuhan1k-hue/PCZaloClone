/* Bảng giá ZaloMask — chốt ngày 2026-05-07.
 * Mọi nơi (landing, pricing, checkout, admin) đều đọc từ đây để tránh
 * lệch giá giữa các trang. */

export type Duration = '1m' | '3m' | '6m' | '1y'

export interface PlanTier {
  id: string
  /** Số tài khoản Zalo chạy đồng thời được phép. */
  accountQuota: number
  label: string
  /** VND (đồng) — đã nhân cho tier */
  prices: Record<Duration, number>
}

export const PLAN_TIERS: PlanTier[] = [
  {
    id: 'tier-1',
    accountQuota: 1,
    label: 'Gói Miễn phí (1 Zalo)',
    prices: { '1m': 0, '3m': 0, '6m': 0, '1y': 0 }
  },
  {
    id: 'tier-test-1k',
    accountQuota: 2,
    label: 'Gói Test 1.000đ (2 Zalo)',
    prices: { '1m': 1_000, '3m': 1_000, '6m': 1_000, '1y': 1_000 }
  },
  {
    id: 'tier-6',
    accountQuota: 6,
    label: 'Gói 6 Zalo',
    prices: { '1m': 199_000, '3m': 499_000, '6m': 999_000, '1y': 1_499_000 }
  },
  {
    id: 'tier-15',
    accountQuota: 15,
    label: 'Gói 15 Zalo',
    prices: { '1m': 399_000, '3m': 799_000, '6m': 1_499_000, '1y': 2_499_000 }
  },
  {
    id: 'tier-25',
    accountQuota: 25,
    label: 'Gói 25 Zalo',
    prices: { '1m': 499_000, '3m': 999_000, '6m': 1_999_000, '1y': 2_999_000 }
  },
  {
    id: 'tier-50',
    accountQuota: 50,
    label: 'Gói 50 Zalo',
    prices: { '1m': 799_000, '3m': 1_499_000, '6m': 2_999_000, '1y': 3_999_000 }
  },
  {
    id: 'tier-100',
    accountQuota: 100,
    label: 'Gói 100 Zalo',
    prices: { '1m': 999_000, '3m': 1_999_000, '6m': 3_999_000, '1y': 5_999_000 }
  }
]

export const DURATION_LABEL: Record<Duration, string> = {
  '1m': '1 tháng',
  '3m': '3 tháng',
  '6m': '6 tháng',
  '1y': '1 năm'
}

export const DURATION_DAYS: Record<Duration, number> = {
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '1y': 365
}

export function findPlan(tierId: string, duration: Duration): { tier: PlanTier; duration: Duration; price: number } | null {
  const tier = PLAN_TIERS.find(t => t.id === tierId)
  if (!tier) return null
  return { tier, duration, price: tier.prices[duration] }
}

export function formatVnd(amount: number): string {
  return amount.toLocaleString('vi-VN') + 'đ'
}
