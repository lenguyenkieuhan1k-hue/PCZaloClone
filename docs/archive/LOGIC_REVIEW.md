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

- API security (GET → POST)
- Cache TTL
- License validation at profile open

