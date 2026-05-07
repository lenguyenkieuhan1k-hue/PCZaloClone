import { NextResponse } from 'next/server'

const GITHUB_OWNER = 'lenguyenkieuhan1k-hue'
const GITHUB_REPO = 'PCZaloClone'

export async function GET() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      {
        headers: { 'User-Agent': 'ZaloMask-Web' },
        next: { revalidate: 300 }, // cache 5 phút
      }
    )

    if (!res.ok) {
      return NextResponse.redirect(
        `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        { status: 302 }
      )
    }

    const release = await res.json()
    const asset = release.assets?.find((a: { name: string; browser_download_url: string }) =>
      a.name.endsWith('.exe')
    )

    if (!asset) {
      return NextResponse.redirect(
        `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        { status: 302 }
      )
    }

    return NextResponse.redirect(asset.browser_download_url, { status: 302 })
  } catch {
    return NextResponse.redirect(
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { status: 302 }
    )
  }
}
