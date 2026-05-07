# Option A Implementation: Multi-Key License Sync for Electron

**Commit**: `6fd9e46`  
**Date**: 2026-05-07  
**Status**: ✅ Complete, waiting for Claude review

---

## 📋 Summary

Implemented Electron app to fetch and sync multiple active licenses from web API. Each profile is now tied to a license_id with data isolation per key.

---

## 🎯 Architecture & Logic

### **Web API Endpoint** (`/api/electron/licenses`)

**Request**: 
```
GET /api/electron/licenses?key=ZM-ABC123
```

**Response**:
```json
{
  "ok": true,
  "user": { "id", "email", "display_name" },
  "licenses": [
    {
      "id", "license_id", "key",
      "tier_id", "account_quota", "duration",
      "expires_at", "status", "active_session_id",
      "revoked_at", "delete_after"
    }
  ],
  "totalQuota": 21,
  "effectiveQuota": 21
}
```

**Logic**:
1. Find license by key
2. Get user info
3. Fetch ALL licenses for user (multi-key scenario)
4. Filter active licenses (status='active' AND not expired)
5. Calculate quotas
6. Log audit for tracking

---

### **Electron App Changes**

#### 1. **License Cache** (in-memory)
```javascript
const activeLicensesCache = new Map()  // license_id → { key, tier_id, account_quota, expires_at, status, ... }
let licensesCachedAt = 0                // timestamp of last sync
```

**Purpose**: Store multiple active licenses for quick quota calculations without API calls.

---

#### 2. **Multi-Key Quota Calculation** (Updated `getEffectiveProfileQuota()`)

**Old Logic**:
- Single license from `license-state.json`
- Quota = accountQuota or 1 (free)

**New Logic**:
```
IF cache has licenses:
  FOR each license IN cache:
    IF status='active' AND not expired:
      totalQuota += account_quota
  RETURN totalQuota
ELSE:
  Fallback to license-state.json (backward compatible)
```

**Benefits**:
- ✅ Supports multiple keys per user
- ✅ Automatic quota summation
- ✅ Backward compatible (fallback to single-key)

---

#### 3. **License Sync Function** (New `syncLicensesFromWeb()`)

**Triggers**:
1. On app startup (after license activated)
2. On heartbeat (every 30s)
3. On demand via IPC `sync-licenses`

**Flow**:
1. Read license key from `license-state.json`
2. Call web API `/api/electron/licenses?key=...`
3. If success: update cache with all licenses
4. Log audit: sync timestamp + license count + effective quota
5. If fail: keep existing cache (offline fallback)

**Error Handling**:
- Network error → logged but continues (offline mode)
- Invalid key → returns error (user needs to reactivate)
- All licenses expired → error with list

---

#### 4. **IPC Handlers**

**New**: `sync-licenses` (on-demand)
```javascript
ipcMain.handle('sync-licenses', async () => {
  const rs = await syncLicensesFromWeb()
  broadcastLicenseStatus()
  return rs
})
```

**Updated**: `activate-license`
- Clear old cache before new activation
- Sync licenses immediately after activation
- Broadcast updated status

**Updated**: `get-license-status`
- Include `activeLicenses` array in response
- Include `licensesCachedAt` timestamp

---

## 🔍 Edge Cases & Logic Checks

### ✅ **Scenario 1: User has 2 active licenses**
```
License 1: tier-6 (6 profiles), expires: tomorrow
License 2: tier-15 (15 profiles), expires: next month

Cache: { lic1_uuid: {...}, lic2_uuid: {...} }
Effective Quota: 6 + 15 = 21 ✓
Profile Add: allowed if < 21
```

### ✅ **Scenario 2: One license expires, one active**
```
License 1: tier-6, EXPIRED
License 2: tier-15, ACTIVE

syncLicensesFromWeb() called
Cache updated: only License 2
Effective Quota: 15 ✓
```

### ✅ **Scenario 3: Network offline, licenses cached**
```
App starts → syncLicensesFromWeb() fails (no internet)
But cache still has licenses from last sync
getEffectiveProfileQuota() uses cache ✓
User can still add profiles (offline mode)
```

### ✅ **Scenario 4: License revoked (status='revoked')**
```
Web API returns license with status='revoked'
Cache includes it (for reference)
But getEffectiveProfileQuota() filters: if status='active' ✓
Effective Quota excludes revoked key
```

### ⚠️ **Scenario 5: Cache stale > 1 hour?**
```
Current: No explicit cache TTL
Mitigation: 
  - Heartbeat syncs every 30s
  - On-demand sync via IPC
  - Plus sync on activate
Recommendation: Add 1h TTL + force refresh?
```

---

## 🚨 Potential Issues & Improvements

### **1. Cache TTL / Staleness**
**Issue**: If app runs 30+ days without internet, cache very stale.
**Current**: No explicit TTL, relies on heartbeat.
**Suggested Fix**:
```javascript
const CACHE_MAX_AGE = 3600000 // 1 hour
if (Date.now() - licensesCachedAt > CACHE_MAX_AGE) {
  await syncLicensesFromWeb() // force refresh
}
```

**Decision Needed**: Should we enforce TTL, or trust periodic heartbeat?

---

### **2. License Key in Partition Name**
**Current**: Partition = `persist:zalomask-web-${licenseId}:${profileName}`
**Issue**: If user revokes key, profile data still in partition. Need cleanup logic.
**Suggested**: After grace period, delete partition directory for revoked keys.

---

### **3. Single-Session Per License**
**Current**: `active_session_id` checked on heartbeat (only logs kicked event).
**Missing**: Partition-level enforcement (Desktop app doesn't reject profile open if license kicked).
**Suggested Enhancement**:
```javascript
// Before openWebProfile():
const lic = activeLicensesCache.get(meta.license_id)
if (lic?.status !== 'active' || new Date(lic.expires_at) < now) {
  throw new Error('License invalid or expired')
}
```

---

### **4. API Security**
**Current**: Endpoint uses query param `key=...`
**Risk**: Key logged in URL history, logs, etc.
**Better**: POST request with key in body? Or use session token?
**Note**: User already activated key, so sensitive info OK?

---

### **5. Audit Log Granularity**
**Current**: Logs sync success/fail with summary.
**Suggested**: Also log:
- Each license status change detected
- Quota delta (was 6, now 21)
- Cache hit/miss ratio (for perf monitoring)

---

## 📊 Test Scenarios (For Claude/QA)

1. **Happy Path**: User activates key → sync succeeds → see 6 profiles quota ✓
2. **Multi-Key**: User upgrades → 2 keys → total 21 quota ✓
3. **Offline**: App starts, network down → cache used ✓
4. **Key Revoked**: License revoked on server → user app auto-removes from quota ✓
5. **Partition Isolation**: Profile in lic1 can't access lic2 data ✓

---

## 📝 Files Modified

| File | Changes |
|------|---------|
| `/web/app/api/electron/licenses/route.ts` | New: fetch active licenses for Electron |
| `/app/main.v2.js` | New: syncLicensesFromWeb(), updated getEffectiveProfileQuota(), updated bootLicenseRuntime() |

---

## 🔗 Related Code

- **Profile Metadata**: `meta.license_id` added (partition key)
- **Partition Naming**: `partitionFor()` updated to include license_id
- **Heartbeat**: Now also calls `syncLicensesFromWeb()` on each ping

---

## ✅ Claude Review Checklist

- [ ] Logic is sound for multi-license scenario?
- [ ] Edge cases handled (offline, expired, revoked)?
- [ ] API security acceptable?
- [ ] Cache TTL strategy makes sense?
- [ ] Single-session check adequate?
- [ ] Audit logging sufficient?
- [ ] Backward compatibility preserved (single-key fallback)?
- [ ] Suggest improvements/refactoring?
- [ ] Ready for testing?

---

**Status**: Waiting for Claude review before testing on staging.
