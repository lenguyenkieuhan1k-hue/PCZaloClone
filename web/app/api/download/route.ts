import { NextResponse } from 'next/server'

const GITHUB_OWNER = 'lenguyenkieuhan1k-hue'
const GITHUB_REPO = 'PCZaloClone'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      {
        headers: { 'User-Agent': 'ZaloMask-Web' },
        cache: 'no-store', // không cache
      }
    )

    if (!res.ok) {
      console.error(`[/api/download] GitHub API error: ${res.status}`)
      return NextResponse.redirect(
        `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        { status: 302 }
      )
    }

    const release = await res.json()
    console.log(`[/api/download] Release tag: ${release.tag_name}, assets: ${release.assets?.length || 0}`)
    
    const asset = release.assets?.find((a: { name: string; browser_download_url: string }) =>
      a.name.endsWith('.exe')
    )

    if (!asset) {
      console.error(`[/api/download] No .exe asset found in release ${release.tag_name}`)
      return NextResponse.redirect(
        `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        { status: 302 }
      )
    }

    console.log(`[/api/download] Found asset: ${asset.name}, redirecting to: ${asset.browser_download_url}`)
    return NextResponse.redirect(asset.browser_download_url, { status: 302 })
  } catch (err) {
    console.error(`[/api/download] Error:`, err)
    return NextResponse.redirect(
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { status: 302 }
    )
  }
}
