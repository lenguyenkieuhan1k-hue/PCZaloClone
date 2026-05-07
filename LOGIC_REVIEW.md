# LOGIC REVIEW & ISSUES ANALYSIS
## Option A: Multi-Key License Sync for Electron

**Date**: 2026-05-07  
**Status**: Ready for Claude Implementation Review  
**Commits Referenced**: `6fd9e46` + `adb8b34`

---

## 🎯 LOGIC FLOW VERIFICATION

### **Flow 1: Initial Activation → License Sync**
```
User enters key ZM-ABC in UI
  ↓
IPC: activate-license({key})
  ↓
app/main.v2.js:
  1. Clear old cache: activeLicensesCache.clear()
  2. Verify key with web API /api/activate (existing)
  3. Save license-state.json (existing)
  4. Call syncLicensesFromWeb()
     → GET /api/electron/licenses?key=ZM-ABC
     → Cache updated with 1 license (tier-6)
  ↓
getEffectiveProfileQuota() returns quota=6 ✓
  ↓
Dashboard: "6 profiles available"
```

**✅ LOGIC SOUND**: New license synced immediately.

---

### **Flow 2: User Upgrades → Web Creates New Key → Heartbeat Detects**
```
Dashboard → "Nâng cấp tier"
  → POST /api/upgrade-license
  → New license created (status=pending, tier-15)
  → Redirect /checkout/upgrade/[newLicenseId]
  ↓
User pays → Webhook activates new license (status=active)
  ↓
Electron heartbeat runs (30s later)
  → runHeartbeatOnce()
  → Calls syncLicensesFromWeb()
     → GET /api/electron/licenses?key=ZM-ABC (original key)
     → Web API fetches ALL licenses for this user
     → Returns: [License 1 (tier-6), License 2 (tier-15)]
  → Cache updated: { lic1_uuid: {...}, lic2_uuid: {...} }
  ↓
getEffectiveProfileQuota() sums: 6 + 15 = 21 ✓
  ↓
Dashboard: "21 profiles available" ✓
```

**✅ LOGIC SOUND**: Multi-key detection automatic via heartbeat.

---

### **Flow 3: Network Offline**
```
App starts → try syncLicensesFromWeb()
  ↓
Network error (no internet)
  → catch error → log → return { ok: false }
  ↓
BUT: cache still has licenses from last sync (if any)
  ↓
getEffectiveProfileQuota() checks:
  IF cache.size > 0:
    RETURN summed quota from cache ✓
  ELSE:
    FALLBACK to license-state.json (single key)
  ↓
User can still create profiles (offline mode)
```

**✅ LOGIC SOUND**: Offline fallback works.

---

### **Flow 4: License Expires**
```
License 1: expires tomorrow → ACTIVE
License 2: expires next month → ACTIVE

Next sync: /api/electron/licenses returns both
Cache: { lic1: {..., expires: tomorrow}, lic2: {...} }

Day after:
Heartbeat syncs
  → Web API filters: now > expires_at for lic1
  → Returns only lic2 in active list
  → Cache updated: only lic2
  ↓
getEffectiveProfileQuota(): 15 ✓
User can still add profiles (under tier-15)
```

**✅ LOGIC SOUND**: Expired licenses auto-excluded.

---

### **Flow 5: License Revoked (Status = 'revoked')**
```
Web API returns: [{ status: 'active', ...}, { status: 'revoked', ...}]

Cache updated with BOTH

getEffectiveProfileQuota():
  FOR each lic IN cache:
    IF lic.status === 'active' AND not expired:
      totalQuota += lic.account_quota
  
Revoked license SKIPPED ✓
Effective quota excludes revoked key
```

**✅ LOGIC SOUND**: Revoked licenses filtered.

---

## 🚨 CRITICAL ISSUES (Must Fix Before Production)

### **ISSUE #1: API Security — Key in Query Param** ⚠️ HIGH
**File**: `web/app/api/electron/licenses/route.ts`

**Problem**:
```
GET /api/electron/licenses?key=ZM-ABC123
```
- Key exposed in URL → logged in browser history, server logs, proxy logs
- If user shares support screenshot, key visible
- Violates security best practice: secrets in query params

**Current Risk**: MEDIUM (key is already activated, but still bad practice)

**Fix Options**:
1. **Option A**: POST request with key in body
   ```
   POST /api/electron/licenses
   Body: { "key": "ZM-ABC123" }
   ```
   **Better**: Key not in URL. ✅

2. **Option B**: Use session token (future enhancement)
   - After license activated, generate access token
   - Electron uses token instead of key
   - More complex but industry standard

**Decision**: **Option A (POST) is enough for now**

**Action**: Change endpoint from GET to POST.

---

### **ISSUE #2: Cache TTL Missing** ⚠️ MEDIUM
**File**: `app/main.v2.js` — `getEffectiveProfileQuota()`

**Problem**:
```
App runs 7 days without restart/internet
License expires on day 5
App still shows quota = 21 (cache stale)
User adds profile → might fail on next heartbeat
```

**Current Mitigation**:
- Heartbeat every 30s (good)
- But if network down, NO SYNC for 7+ days

**Recommended Fix**:
```javascript
const CACHE_MAX_AGE = 3600000 // 1 hour

function getEffectiveProfileQuota() {
  const now = Date.now()
  
  // Force refresh if cache stale
  if (activeLicensesCache.size > 0 && (now - licensesCachedAt) > CACHE_MAX_AGE) {
    // Schedule background sync (don't block UI)
    syncLicensesFromWeb().catch(err => 
      logRuntime('bg-cache-refresh-error', { message: err?.message })
    )
  }
  
  // Use cache (even if stale, but notify)
  if (activeLicensesCache.size > 0) {
    // ... sum quotas ...
  } else {
    // fallback
  }
}
```

**Action**: Add TTL check + background refresh.

---

### **ISSUE #3: No License Validation When Opening Profile** ⚠️ MEDIUM
**File**: `app/main.v2.js` — `openWebProfile()`

**Problem**:
```
User has License 1 (tier-6, ACTIVE)
Profile 1 created → meta.license_id = lic1_uuid

Web admin revokes License 1 → status='revoked'
Profile 1 partition still exists locally

User tries to open Profile 1
  → openWebProfile() runs
  → NO CHECK if license still valid
  → Partition loads (session data still there)
  → User thinks profile works, but license invalid!
```

**Fix**:
```javascript
async function openWebProfile(profileName) {
  const meta = loadProfileMeta(profileName)
  if (!meta) throw new Error('...')

  // NEW: Validate license before opening
  if (meta.license_id) {
    const lic = activeLicensesCache.get(meta.license_id)
    if (!lic || lic.status !== 'active' || new Date(lic.expires_at) < new Date()) {
      throw new Error('License invalid/expired. Profile unavailable.')
    }
  }

  // ... rest of openWebProfile ...
}
```

**Action**: Add license validation check at profile-open time.

---

### **ISSUE #4: Revoked Partition Cleanup Not Implemented** ⚠️ MEDIUM
**File**: `app/main.v2.js` — No cleanup function

**Problem**:
```
License 1 revoked → Grace period 24h
After 24h, web admin runs cleanup job
But Electron app still has partition: persist:zalomask-web-<lic1_uuid>:*

Partition data remains on disk forever
```

**Action Needed**: 
1. Add cleanup function in Electron:
```javascript
async function cleanupRevokedLicenses() {
  const revoked = activeLicensesCache.values()
    .filter(lic => lic.status === 'revoked' && 
                   new Date(lic.delete_after) < new Date())
  
  for (const lic of revoked) {
    // Delete session partition data
    const partition = `persist:zalomask-web-${lic.license_id}:*`
    // Use Chromium API to clear partition? Or just warn?
  }
}
```

2. Call after sync completes

**Decision Needed**: Is this critical for first release? Or Phase 2 enhancement?

---

### **ISSUE #5: Query Param Length Limit** ⚠️ LOW
**File**: `web/app/api/electron/licenses/route.ts`

**Problem**:
```
GET /api/electron/licenses?key=ZM-ABC123
```
- Most servers limit URL to 2KB
- Key is short, but good practice to avoid

**Solved by**: Option A (POST request) fixes this.

---

## ⚠️ SECONDARY ISSUES (Nice to Have / Phase 2)

### **ISSUE #6: Audit Log Granularity** 
**File**: `web/app/api/electron/licenses/route.ts`

**Current**:
```javascript
await admin.from('audit_log').insert({
  action: 'electron-licenses-fetch',
  detail: { key_last4, license_count, active_count }
})
```

**Could Add**:
- Timestamp of cache
- Quota delta (was X, now Y)
- Sync error details (if failed)

**Priority**: LOW (informational only)

---

### **ISSUE #7: Error Messages Could Be More Specific**
**File**: Both web API + Electron

**Current**:
```
"No active licenses found"
"Sync failed"
```

**Better**:
- "All licenses expired" (actionable: user needs to renew)
- "Network timeout" (actionable: check internet)
- "Invalid key" (actionable: reactivate)

**Priority**: LOW (UX improvement)

---

## ✅ WHAT'S WORKING WELL

1. **Backward Compatibility** ✅
   - Single-key fallback works
   - Old profiles without license_id still load

2. **Offline Mode** ✅
   - Cache fallback prevents app crash
   - User can still create profiles offline

3. **Multi-License Summation** ✅
   - Logic correctly sums active licenses
   - Handles 2, 5, 10+ keys

4. **Heartbeat Integration** ✅
   - Periodic sync catches changes
   - Good for detecting upgrades/expirations

5. **License State Persistence** ✅
   - Single key stored in license-state.json
   - Multiple keys in cache

---

## 📋 ACTION ITEMS FOR CLAUDE

### **MUST DO (Before Production)**:
- [ ] **#1**: Change `/api/electron/licenses` from GET to POST
  - Move `key` from query param to JSON body
  - Update Electron client code
  - Test with cURL

- [ ] **#3**: Add license validation in `openWebProfile()`
  - Check license_id in cache
  - Throw error if status !== 'active' or expired
  - Handle case where cache is empty (offline)

- [ ] **#2**: Add cache TTL + background refresh
  - Define `CACHE_MAX_AGE = 3600000`
  - Check in `getEffectiveProfileQuota()`
  - Trigger background sync if stale

### **SHOULD DO (This Release)**:
- [ ] **#7**: Improve error messages (specific reasons)

### **NICE TO DO (Phase 2)**:
- [ ] **#4**: Cleanup revoked partitions (after grace period)
- [ ] **#6**: Enhance audit logging (quota delta, errors)

---

## 🧪 TEST CHECKLIST (For QA)

### **Functional Tests**:
- [ ] Single key activation → quota=6
- [ ] Upgrade to 2 keys → quota=21
- [ ] License expires → quota updated after heartbeat
- [ ] License revoked → quota updated (excluded)
- [ ] Offline mode → cache used, works

### **Security Tests**:
- [ ] Key NOT in URL logs
- [ ] Key NOT in browser history
- [ ] API returns only user's licenses (not others)

### **Edge Case Tests**:
- [ ] Network down → can still create profiles
- [ ] Cache old > 1 hour → background refresh triggered
- [ ] Profile open with revoked license → error shown
- [ ] Multiple licenses with different expiry dates → correct quota

### **Backward Compatibility**:
- [ ] Old single-key profile loads OK
- [ ] Old profile without license_id works (fallback)

---

## 📊 SUMMARY TABLE

| Issue | Severity | Type | Fix Time | Status |
|-------|----------|------|----------|--------|
| API key in query | HIGH | Security | 30min | ⏳ To Do |
| Cache TTL missing | MEDIUM | Logic | 20min | ⏳ To Do |
| No license check @ open | MEDIUM | Logic | 20min | ⏳ To Do |
| Partition cleanup | MEDIUM | Feature | 30min | 📋 Phase 2 |
| Audit log detail | LOW | Enhancement | 15min | 📋 Phase 2 |
| Error messages | LOW | UX | 20min | ⏳ To Do |

---

## 📝 COMMIT PLAN

After fixes:
```
git commit -m "fix(web+electron): API security + cache TTL + license validation

- Change /api/electron/licenses from GET to POST (key in body)
- Add cache TTL check + background refresh (1h)
- Validate license before opening profile
- Improve error messages
"
```

---

## ✅ READY FOR CLAUDE REVIEW

**Files to Review**:
1. `/web/app/api/electron/licenses/route.ts` — Change GET to POST
2. `/app/main.v2.js` — Add TTL, validation, error handling

**Questions for Claude**:
1. POST vs GET — which better?
2. Cache TTL 1h reasonable, or too long?
3. Should cleanup revoked partitions now or phase 2?
4. Any other edge cases I missed?

---

**Status**: ✅ Logic sound, 3 must-fix issues identified, ready for Claude implementation.
