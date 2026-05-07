# CLAUDE IMPLEMENTATION REQUEST
## Option A: Multi-Key License Sync - 3 Critical Fixes

**Sent**: 2026-05-07  
**Status**: Ready for immediate implementation  
**Estimated Time**: 70 minutes  
**Complexity**: Medium (security fix + logic enhancement + validation)

---

## 📌 CONTEXT

I've implemented a multi-key license system for ZaloMask. The architecture is **95% complete and logic is sound**, but there are **3 security/logic issues** that need fixing before production testing.

**What works**:
- ✅ Web API fetches all active licenses per key
- ✅ Electron cache stores multiple licenses
- ✅ Quota summation logic (2+ keys)
- ✅ Heartbeat integration (every 30s)
- ✅ Offline fallback
- ✅ Backward compatibility (single-key fallback)

**What needs fixing**:
1. 🔒 API endpoint uses GET with key in query param (security risk)
2. ⏰ Cache has no TTL (can be stale 7+ days offline)
3. ❌ Profile opens even if license revoked (validation missing)

---

## 🚨 ISSUE #1: API SECURITY — Key Exposed in URL

**Severity**: HIGH (security)  
**File**: `/web/app/api/electron/licenses/route.ts`  
**Current Problem**:
```
GET /api/electron/licenses?key=ZM-ABC123
```
Key is exposed in:
- Server logs
- Browser history
- Proxy/firewall logs
- Support screenshots

**Required Fix**: Change to POST request
```
POST /api/electron/licenses
Content-Type: application/json
Body: { "key": "ZM-ABC123" }
```

### **Changes Needed**:

**File 1**: `/web/app/api/electron/licenses/route.ts`
```typescript
// CURRENT:
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')?.trim()

// CHANGE TO:
export async function POST(req: NextRequest) {
  const body = await req.json()
  const key = String(body?.key || '').trim()
```

**File 2**: `/app/main.v2.js` — function `syncLicensesFromWeb()` (around line ~195)
```javascript
// CURRENT:
const rs = await getJson(`${baseUrl}/api/electron/licenses?key=${encodeURIComponent(state.key)}`)

// CHANGE TO:
const rs = await postJson(`${baseUrl}/api/electron/licenses`, { key: state.key })
```

**Validation**:
- [ ] POST endpoint correctly reads key from body
- [ ] Electron sends key in POST body (not query param)
- [ ] Error handling still works (invalid key)
- [ ] Test with cURL: `curl -X POST ... -d '{"key":"ZM-ABC"}'`

---

## ⏰ ISSUE #2: Cache TTL Missing

**Severity**: MEDIUM (staleness/UX)  
**File**: `/app/main.v2.js` — function `getEffectiveProfileQuota()` (line ~146)  
**Current Problem**:
```
Cache never expires → if no internet for 7 days, quota is stale
User thinks they have 21 profiles but license actually expired
```

**Required Fix**: Add 1-hour TTL with background refresh

### **Changes Needed**:

Add at top of file (with other constants):
```javascript
// Around line 35 where other constants defined:
const CACHE_MAX_AGE = 3600000 // 1 hour in milliseconds
```

Update function `getEffectiveProfileQuota()`:
```javascript
function getEffectiveProfileQuota() {
  const now = Date.now()
  
  // NEW: Check if cache is stale (>1 hour old)
  if (activeLicensesCache.size > 0 && (now - licensesCachedAt) > CACHE_MAX_AGE) {
    // Background refresh (don't block UI)
    syncLicensesFromWeb().catch(err => 
      logRuntime('bg-sync-stale-cache', { message: err?.message })
    )
  }
  
  // Use cache (even if stale, notify in logs)
  if (activeLicensesCache.size > 0) {
    const now_check = new Date()
    let totalQuota = 0
    for (const [_licenseId, lic] of activeLicensesCache.entries()) {
      if (lic.status === 'active' && new Date(lic.expires_at) > now_check) {
        totalQuota += Number(lic.account_quota || 0)
      }
    }
    if (totalQuota > 0) {
      return { quota: totalQuota, source: 'license', licenses: Array.from(activeLicensesCache.values()) }
    }
  }
  
  // Fallback to single-key (backward compatible)
  const license = readLicenseState()
  if (license && String(license.status || '').toLowerCase() === 'active') {
    const licenseQuota = Number(license.accountQuota || 0)
    if (licenseQuota > 0) {
      return { quota: licenseQuota, source: 'license' }
    }
    return { quota: 0, source: 'license' }
  }
  return { quota: 1, source: 'free' }
}
```

**Validation**:
- [ ] Cache refresh triggered at 1h mark
- [ ] Background refresh doesn't block profile creation
- [ ] Offline mode still works (uses stale cache)
- [ ] Heartbeat still syncs every 30s (overrides TTL if internet available)

---

## ❌ ISSUE #3: License Validation Missing at Profile Open

**Severity**: MEDIUM (logic/security)  
**File**: `/app/main.v2.js` — function `openWebProfile()` (around line ~895)  
**Current Problem**:
```
User has License (tier-6, ACTIVE)
Profile 1 created → meta.license_id = <uuid>

License gets revoked → status='revoked'
User tries to open Profile 1

Current: Opens normally (bad! license invalid)
Expected: Show error "License revoked"
```

**Required Fix**: Validate license before opening profile

### **Changes Needed**:

Update function `openWebProfile()` — add validation right after meta loading:

```javascript
async function openWebProfile(profileName) {
  const meta = loadProfileMeta(profileName)
  if (!meta) throw new Error('Không tìm thấy profile')

  const existing = webWindows.get(profileName)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { ok: true }
  }

  // NEW: Validate license before opening
  if (meta.license_id) {
    const lic = activeLicensesCache.get(meta.license_id)
    const now = new Date()
    
    if (!lic) {
      // License not in cache - could be offline, allow open but warn
      logRuntime('profile-open-license-not-cached', { profileName, license_id: meta.license_id })
    } else if (lic.status !== 'active') {
      throw new Error(`License không hoạt động (status: ${lic.status}). Profile không thể mở.`)
    } else if (new Date(lic.expires_at) < now) {
      throw new Error(`License đã hết hạn (${lic.expires_at}). Vui lòng gia hạn.`)
    }
  }

  // Multi-key: use license_id from meta if available (new profiles)
  const licenseId = meta.license_id || ''
  const partition = partitionFor(profileName, licenseId)
  const ses = session.fromPartition(partition)
  
  // ... rest of function unchanged ...
}
```

**Validation**:
- [ ] Active license → opens normally ✓
- [ ] Revoked license → throws error ✓
- [ ] Expired license → throws error ✓
- [ ] Cache empty (offline) → opens with warning ✓
- [ ] Old profile (no license_id) → opens (backward compat) ✓

---

## 🎯 IMPLEMENTATION CHECKLIST

### **Step 1: Fix API Security (30 min)**
- [ ] Change `/web/app/api/electron/licenses/route.ts` to POST
- [ ] Update `/app/main.v2.js` syncLicensesFromWeb() to use POST
- [ ] Test with cURL
- [ ] Verify key NOT in logs/history

### **Step 2: Add Cache TTL (20 min)**
- [ ] Add `CACHE_MAX_AGE` constant
- [ ] Update `getEffectiveProfileQuota()` logic
- [ ] Test: cache refresh at 1h mark
- [ ] Verify offline mode still works

### **Step 3: Add License Validation (20 min)**
- [ ] Update `openWebProfile()` with validation
- [ ] Test all 5 license statuses (active, revoked, expired, etc)
- [ ] Verify error messages clear
- [ ] Confirm backward compatibility

### **Step 4: Testing (30 min)**
- [ ] Run 5 test scenarios (see below)
- [ ] Check logs for errors
- [ ] Verify no performance degradation

---

## 🧪 TEST SCENARIOS

### **Test 1: API Security**
```
1. Activate license
2. Check logs: key should NOT appear
3. Check browser DevTools network tab: POST body used (not query param)
✓ Key completely hidden from URL
```

### **Test 2: Cache TTL**
```
1. Activate license (2 keys, 21 quota)
2. Wait 1 hour (or mock time in tests)
3. No internet available
4. Check logs: "bg-sync-stale-cache" appears ✓
5. Create profile: should still work ✓
6. Plugin internet: heartbeat syncs
```

### **Test 3: License Validation - Active**
```
1. Profile with ACTIVE license
2. Click open profile
3. Expected: Opens normally ✓
```

### **Test 4: License Validation - Revoked**
```
1. Profile with REVOKED license
2. Click open profile
3. Expected: Error "License không hoạt động (status: revoked)" ✓
4. No profile window opens
```

### **Test 5: License Validation - Expired**
```
1. Profile with EXPIRED license (expires_at < now)
2. Click open profile
3. Expected: Error "License đã hết hạn ... Vui lòng gia hạn" ✓
4. Suggest renewal
```

---

## 📝 CODE LOCATIONS (Quick Reference)

| Issue | File | Line | Function | Type |
|-------|------|------|----------|------|
| #1 | `/web/app/api/electron/licenses/route.ts` | 1-70 | GET → POST | Change method |
| #1 | `/app/main.v2.js` | ~195 | syncLicensesFromWeb() | Update fetch |
| #2 | `/app/main.v2.js` | ~35 | Top level | Add constant |
| #2 | `/app/main.v2.js` | ~146 | getEffectiveProfileQuota() | Add TTL logic |
| #3 | `/app/main.v2.js` | ~895 | openWebProfile() | Add validation |

---

## 📊 RELATED DOCUMENTATION (For Reference)

1. **`IMPLEMENTATION_NOTES.md`** — Detailed architecture
2. **`LOGIC_REVIEW.md`** — Flow verification + all edge cases
3. **`CLAUDE_HANDOFF.md`** — Executive summary + test scenarios

---

## ❓ QUESTIONS FOR CLAUDE

After implementing, please answer:

1. **API Design**: POST vs other approaches (OAuth token, session)? Prefer POST for now?

2. **Cache TTL**: 1 hour reasonable, or should it be different (30min, 6h, 24h)?

3. **Validation Logic**: Should we also check `active_session_id` for single-session enforcement?

4. **Error Handling**: Should revoked profile attempt auto-cleanup, or just block with message?

5. **Offline Behavior**: Should stale cache warning appear in UI to user, or silent logging?

---

## 📎 COMMITS HISTORY

```
8f47b6e - docs: logic review + Claude handoff
6fd9e46 - feat(web+electron): multi-key license sync from web API
adb8b34 - docs: implementation notes
bd5fd7c - docs: update Phase 3-4 completion
61a85ae - feat(electron): multi-key foundation - partition by license_id
04e1fbb - feat(web): deactivate license + 24h grace period
fd3ce04 - feat(web): checkout pages (upgrade + renewal + webhook)
```

---

## ✅ DELIVERABLES

After fixes, please provide:

1. ✅ Updated `/web/app/api/electron/licenses/route.ts` (POST)
2. ✅ Updated `/app/main.v2.js` (TTL + validation + POST call)
3. ✅ Test results for 5 scenarios
4. ✅ Answers to 5 questions above
5. ✅ New commit: `fix(web+electron): API security + cache TTL + license validation`

---

## 🚀 NEXT STEPS AFTER YOUR FIXES

1. Merge fixes
2. Run full staging tests (5 scenarios)
3. Build v2.7.0 release
4. Deploy to production
5. Users can now use multi-key system!

---

## 📊 SUMMARY

| Task | Time | Status |
|------|------|--------|
| API Security (POST) | 30 min | 🔴 Ready to fix |
| Cache TTL | 20 min | 🔴 Ready to fix |
| License Validation | 20 min | 🔴 Ready to fix |
| Testing | 30 min | 🟡 After fixes |
| **TOTAL** | **70 min** | — |

---

**Thank you for taking this on! This is the last piece before production.** 🚀

Please implement, test, and let me know results!
