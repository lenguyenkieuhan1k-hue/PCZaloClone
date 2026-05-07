#!/usr/bin/env powershell

# ZaloMask Production Launch Checklist
# Run this file to see what needs to be done next

Write-Host "`n"
Write-Host "╔════════════════════════════════════════════════════════════════╗"
Write-Host "║                                                                ║"
Write-Host "║       ZaloMask Production Launch - Status & Next Steps        ║"
Write-Host "║                                                                ║"
Write-Host "╚════════════════════════════════════════════════════════════════╝`n"

Write-Host "📊 CURRENT STATUS (2026-05-08)`n"

Write-Host "✅ COMPLETED:"
Write-Host "   • Auto-Update infrastructure hardened (code signing config ready)"
Write-Host "   • NSIS installer customized with branding"
Write-Host "   • GitHub Actions workflow supports code signing"
Write-Host "   • Supabase/Vercel setup guide created (interactive scripts)"
Write-Host "   • Production documentation updated (KE_HOACH.md section 0d)`n"

Write-Host "⏳ IN PROGRESS:"
Write-Host "   • Desktop app: Free tier + license runtime (feature-complete)"
Write-Host "   • Web platform: Landing/pricing/dashboard ready for deploy"
Write-Host "   • Waiting for: User cert purchase + Supabase/Vercel setup`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "🎯 YOUR ACTION ITEMS (IN ORDER)`n"

Write-Host "PRIORITY 1 - Auto-Update Certificate (1-2 days)"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "   📍 Step 1: Purchase EV Code Signing Certificate"
Write-Host "   ├─ Run: powershell .\app\CODE-SIGNING-SETUP.ps1"
Write-Host "   ├─ Will guide through SSL.com purchase"
Write-Host "   ├─ Cost: ~$330/year (USD)"
Write-Host "   └─ Time: 1-2 days for ID verification`n"

Write-Host "   📍 Step 2: Setup GitHub Secrets (after cert arrives)"
Write-Host "   ├─ Encode cert → base64 (script does this)"
Write-Host "   ├─ Add to GitHub repo → Settings → Secrets:"
Write-Host "   │   ├─ SIGNING_CERT_BASE64 = (encoded cert)"
Write-Host "   │   └─ SIGNING_CERT_PASSWORD = (cert password)"
Write-Host "   └─ Time: 5 minutes`n"

Write-Host "   📍 Step 3: Test First Signed Release"
Write-Host "   ├─ Update version in app/package.json: 26.3.1 → 26.3.2"
Write-Host "   ├─ Commit & push tag: git tag v26.3.2 && git push --tags"
Write-Host "   ├─ Wait for CI to build + sign (5-10 min)"
Write-Host "   ├─ Verify no SmartScreen warning on Windows"
Write-Host "   └─ Time: 15 minutes`n"

Write-Host "PRIORITY 2 - Supabase/Vercel Deployment (30-60 minutes)"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "   📍 Step 1: Create Cloud Accounts (if not done)"
Write-Host "   ├─ Supabase: https://supabase.com/dashboard"
Write-Host "   ├─ Vercel: https://vercel.com/dashboard"
Write-Host "   ├─ Domain: Namecheap / Godaddy / PA Vietnam (zalomask.com)"
Write-Host "   └─ Time: 10 minutes`n"

Write-Host "   📍 Step 2: Run Interactive Setup Script"
Write-Host "   ├─ Run: powershell .\SUPABASE-VERCEL-SETUP.ps1"
Write-Host "   ├─ Will guide through:"
Write-Host "   │   ├─ Generate Ed25519 keys (for license signing)"
Write-Host "   │   ├─ Create Supabase project + migrate schema"
Write-Host "   │   ├─ Setup Google OAuth"
Write-Host "   │   ├─ Deploy to Vercel"
Write-Host "   │   └─ Configure custom domain"
Write-Host "   └─ Time: 30-45 minutes`n"

Write-Host "   📍 Step 3: Verify Production APIs"
Write-Host "   ├─ Test landing page: https://zalomask.com/"
Write-Host "   ├─ Test pricing page: https://zalomask.com/pricing"
Write-Host "   ├─ Test dashboard: https://zalomask.com/dashboard"
Write-Host "   └─ Time: 5 minutes`n"

Write-Host "PRIORITY 3 - Full System Testing (1-2 hours)"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "   📍 Test Complete License Flow"
Write-Host "   ├─ Machine A: Create profile + open (verify works)"
Write-Host "   ├─ Web: Claim free tier key (get 1-account key)"
Write-Host "   ├─ Machine A: Activate key in app"
Write-Host "   ├─ App: Verify 1-account quota enforced"
Write-Host "   ├─ Machine A: Open Settings → License → verify status"
Write-Host "   ├─ Machine B (optional): Activate same key"
Write-Host "   │   └─ Machine A should kick after 30s"
Write-Host "   └─ Time: 30 minutes`n"

Write-Host "   📍 Test Web Platform"
Write-Host "   ├─ Login with Google"
Write-Host "   ├─ Claim free tier key"
Write-Host "   ├─ View dashboard"
Write-Host "   ├─ Check license status"
Write-Host "   └─ Time: 10 minutes`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "📚 DOCUMENTATION`n"

Write-Host "Full roadmap: KE_HOACH.md section 0d"
Write-Host "   ├─ Auto-Update details"
Write-Host "   ├─ Supabase/Vercel setup"
Write-Host "   └─ Complete checklist`n"

Write-Host "Setup scripts:"
Write-Host "   ├─ app/CODE-SIGNING-SETUP.ps1"
Write-Host "   └─ SUPABASE-VERCEL-SETUP.ps1`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "🚀 TIMELINE TO PUBLIC LAUNCH`n"

Write-Host "IF YOU START NOW:"
Write-Host "   • Today: Start cert purchase process"
Write-Host "   • Tomorrow (cert arrives): Add GitHub secrets + test CI"
Write-Host "   • Tomorrow afternoon: Setup Supabase/Vercel"
Write-Host "   • Tomorrow evening: Full system test"
Write-Host "   • Next day: Ready for beta testing!`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "❓ COMMON QUESTIONS`n"

Write-Host "Q: Can I test without EV cert?"
Write-Host "A: Yes, CI builds unsigned initially. For real release, need cert.`n"

Write-Host "Q: How much does everything cost?"
Write-Host "A: ~$330/year code cert. Domain ~$10/year. Cloud hosting free tier.`n"

Write-Host "Q: Can I use a different payment processor (not SePay)?"
Write-Host "A: Yes, Vercel supports Paddle, Stripe. Edit web/app/api/sepay-webhook/route.ts`n"

Write-Host "Q: What if cert purchase fails verification?"
Write-Host "A: Contact SSL.com support. Usually 1-2 business day resolution.`n"

Write-Host "Q: Can I deploy web to different domain?"
Write-Host "A: Yes, Vercel supports any domain. Just update DNS.`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "✨ READY? Start here:`n"

Write-Host "   1️⃣  Run auto-update setup:"
Write-Host "       powershell .\app\CODE-SIGNING-SETUP.ps1`n"

Write-Host "   2️⃣  Create cloud accounts (while cert processes):"
Write-Host "       → https://supabase.com"
Write-Host "       → https://vercel.com"
Write-Host "       → Buy domain`n"

Write-Host "   3️⃣  When cert arrives, run Supabase/Vercel setup:"
Write-Host "       powershell .\SUPABASE-VERCEL-SETUP.ps1`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Good luck! 🚀`n"
