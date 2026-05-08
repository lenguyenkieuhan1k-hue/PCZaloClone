import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase'
import { resolveCloudAuth } from '@/lib/cloud-sync-auth'

const BUCKET = 'cloud-backups'

// GET /api/cloud-sync/download?sessionId=<sid>
// Inline profiles JSON | desktop-package (base64 legacy) | desktop-package-storage (signed URL nhỏ).
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') || ''
  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const auth = await resolveCloudAuth(req, sessionId)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const admin = adminClient()

  const { data: backup, error } = await admin
    .from('cloud_backups')
    .select('profiles_json, profile_count, uploaded_at')
    .eq('user_id', auth.userId)
    .maybeSingle()

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!backup) return NextResponse.json({ ok: true, profiles: [], uploadedAt: null })

  const stored = backup.profiles_json as any

  const desktopStorage =
    stored && typeof stored === 'object' && !Array.isArray(stored) && stored.kind === 'desktop-package-storage'
      ? stored
      : null

  const desktopPackage =
    stored && typeof stored === 'object' && !Array.isArray(stored) && stored.kind === 'desktop-package'
      ? {
          format: stored.format,
          version: stored.version,
          fileName: stored.fileName,
          checksumSha256: stored.checksumSha256,
          profileCount: Number(stored.profileCount || backup.profile_count || 0),
          dataBase64: stored.dataBase64,
        }
      : null

  const downloadMode = desktopStorage
    ? 'desktop-package-storage'
    : desktopPackage
      ? 'desktop-package'
      : 'legacy-profiles-json'

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    license_id: auth.licenseId,
    action: 'cloud-download',
    detail: { profileCount: backup.profile_count, sessionId, mode: downloadMode },
  })

  if (desktopStorage) {
    const objectPath = String(desktopStorage.objectPath || '').trim()
    if (!objectPath.startsWith(`${auth.userId}/`) || objectPath.includes('..')) {
      return NextResponse.json({ ok: false, message: 'Backup storage không hợp lệ' }, { status: 500 })
    }

    const bucketId = String(desktopStorage.bucket || BUCKET)
    const { data: signed, error: signErr } = await admin.storage.from(bucketId).createSignedUrl(objectPath, 7200)
    if (signErr || !signed?.signedUrl) {
      return NextResponse.json(
        { ok: false, message: signErr?.message || 'Không tạo link tải backup' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      ok: true,
      desktopPackageStorage: {
        signedDownloadUrl: signed.signedUrl,
        checksumSha256: String(desktopStorage.checksumSha256 || '').toLowerCase(),
        profileCount: Number(desktopStorage.profileCount || backup.profile_count || 0),
        fileName: String(desktopStorage.fileName || 'cloud-backup.zmb'),
        format: desktopStorage.format,
        version: desktopStorage.version,
      },
      profileCount: Number(desktopStorage.profileCount || backup.profile_count || 0),
      uploadedAt: backup.uploaded_at,
    })
  }

  if (desktopPackage) {
    return NextResponse.json({
      ok: true,
      desktopPackage,
      profileCount: Number(desktopPackage.profileCount || 0),
      uploadedAt: backup.uploaded_at,
    })
  }

  return NextResponse.json({
    ok: true,
    profiles: backup.profiles_json,
    profileCount: backup.profile_count,
    uploadedAt: backup.uploaded_at,
  })
}
