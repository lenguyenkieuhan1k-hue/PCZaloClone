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

---

## 🚨 Potential Issues & Improvements (historical)

### **1. Cache TTL / Staleness**
Suggested Fix:
```javascript
const CACHE_MAX_AGE = 3600000 // 1 hour
if (Date.now() - licensesCachedAt > CACHE_MAX_AGE) {
  await syncLicensesFromWeb()
}
```

### **2. API Security**
Endpoint uses query param `key=...` → better as POST body.

