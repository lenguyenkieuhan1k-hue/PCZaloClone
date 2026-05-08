/* Canonical SePay memo parser — single source of truth.
 *
 * Both /api/sepay-webhook and /api/payment-status use these helpers so a
 * memo string normalized to the same canonical key from either side will
 * always match. Drift between webhook parser and payment-status matcher
 * was the root cause of "pending forever" bug on production checkout.
 *
 * Memo format we generate at checkout (see web/app/checkout/[plan]/page.tsx):
 *
 *   ZM <userIdShort8> <tierId> <duration>
 *
 * Real-world drift we tolerate:
 *   - SePay or banks may strip dashes:    "ZM ABC12345 TIERTEST1K 1M"
 *   - SePay may add prefixes/refs:        "MB1234 ZM ABC12345 TIER-6 1M /Some Ref"
 *   - Mixed case / extra whitespace
 *   - Tier id with custom name + suffix:  "tier-test-1k" / "TIERTEST1K" / "TIER TEST 1K"
 *
 * canonicalKey() returns a lowercase string `userId8|tierId|duration` you
 * can use as a dictionary key on both sides. */

import type { Duration } from './plans'

export interface ParsedMemo {
  userId8: string                 // 8-char hex prefix of UUID, lowercase
  tierId: string                  // canonical "tier-<slug>" form
  duration: Duration              // 1m | 3m | 6m | 1y
}

/** Strip non-alnum-dash-space chars, collapse whitespace, uppercase. */
export function normalizeMemoText(input: string): string {
  return String(input || '')
    .replace(/[^A-Za-z0-9\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** Convert any tier string variant into canonical "tier-<slug>" form.
 *
 * Inputs handled:
 *   "tier-6"        → "tier-6"
 *   "TIER6"         → "tier-6"
 *   "TIER 6"        → "tier-6"
 *   "TIER-TEST-1K"  → "tier-test-1k"
 *   "TIER TEST 1K"  → "tier-test-1k"
 *   "TIERTEST1K"    → "tier-test-1k" (best-effort split on letters→digits boundary)
 */
export function normalizeTierId(rawTier: string): string {
  let t = String(rawTier || '').toLowerCase()
  // collapse whitespace → dashes
  t = t.replace(/\s+/g, '-')
  // letter→digit boundary (tiertest1k → tiertest-1k)
  t = t.replace(/([a-z])(\d)/g, '$1-$2')

  // crude reflow for "tiertest1k"-style: split into tier + middle + trailing-numeric
  const seg = t.match(/^tier(.+?)(\d+.*)$/)
  if (seg) {
    t = `tier-${seg[1]}-${seg[2]}`
  }
  // tier6 → tier-6
  if (/^tier\d/.test(t)) {
    t = t.replace(/^tier(\d)/, 'tier-$1')
  }
  // tier<rest> (no dash) → tier-<rest>
  if (!t.startsWith('tier-') && t.startsWith('tier')) {
    t = `tier-${t.slice(4).replace(/^-+/, '')}`
  }
  // collapse multiple dashes
  t = t.replace(/-+/g, '-')
  // strip trailing dash
  t = t.replace(/-$/, '')
  return t
}

const MEMO_REGEX = /ZM[ \-]?([A-F0-9]{8})[ \-]?(TIER[A-Z0-9\- ]+?)[ \-]?(1M|3M|6M|1Y)/

/** Returns null when the memo doesn't contain a complete ZM marker triple. */
export function parseMemo(input: string): ParsedMemo | null {
  const cleaned = normalizeMemoText(input)
  const match = cleaned.match(MEMO_REGEX)
  if (!match) return null
  return {
    userId8: match[1].toLowerCase(),
    tierId: normalizeTierId(match[2]),
    duration: match[3].toLowerCase() as Duration,
  }
}

/** Stable lowercase key for cross-endpoint dictionary matching. */
export function canonicalKey(input: string): string | null {
  const p = parseMemo(input)
  return p ? `${p.userId8}|${p.tierId}|${p.duration}` : null
}

/** Build the canonical memo we put on QR + send to SePay. Same shape both
 *  sides expect — keeps drift impossible if everyone uses this builder. */
export function buildMemo(userId: string, tierId: string, duration: Duration): string {
  const userId8 = String(userId || '').replace(/-/g, '').slice(0, 8)
  const tier = normalizeTierId(tierId)
  return `ZM ${userId8} ${tier} ${duration}`.toUpperCase()
}
