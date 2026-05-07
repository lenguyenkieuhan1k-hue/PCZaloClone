#!/usr/bin/env powershell

# ZaloMask Supabase + Vercel Setup Guide
# This script helps you setup production database and web hosting

Write-Host "╔════════════════════════════════════════════════════════╗"
Write-Host "║  ZaloMask Production Setup                            ║"
Write-Host "║  (Supabase Postgres + Vercel Web Host)               ║"
Write-Host "╚════════════════════════════════════════════════════════╝`n"

Write-Host "📋 Prerequisites (prepare before running)`n"
Write-Host "   ✓ GitHub account (for Vercel connect)"
Write-Host "   ✓ Domain name purchased (e.g., zalomask.com)"
Write-Host "   ✓ Payment method (optional, free tier available)"
Write-Host "   ✓ Ed25519 key pair for license signing`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🔵 STEP 1: Generate License Signing Keys`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "License keys will be signed with Ed25519.`n"

Write-Host "Check if openssl is available:"
try {
    $opensslVersion = (openssl version) 2>&1
    Write-Host "✓ OpenSSL found: $opensslVersion" -ForegroundColor Green
} catch {
    Write-Host "❌ OpenSSL not found in PATH" -ForegroundColor Red
    Write-Host "   Please install OpenSSL (included in Git for Windows or standalone)`n"
    exit 1
}

Write-Host "Generating Ed25519 key pair...`n"

# Create keys directory
$keysDir = "$PSScriptRoot\keys"
if (-not (Test-Path $keysDir)) {
    New-Item -ItemType Directory -Path $keysDir -Force | Out-Null
}

$privateKeyPath = "$keysDir\zalomask_ed25519.key"
$publicKeyPath = "$keysDir\zalomask_ed25519.pub"

# Generate private key
openssl genpkey -algorithm Ed25519 -out $privateKeyPath 2>&1 | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Private key generated: $privateKeyPath" -ForegroundColor Green
} else {
    Write-Host "❌ Failed to generate private key" -ForegroundColor Red
    exit 1
}

# Generate public key
openssl pkey -in $privateKeyPath -pubout -out $publicKeyPath 2>&1 | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Public key generated: $publicKeyPath" -ForegroundColor Green
} else {
    Write-Host "❌ Failed to generate public key" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Keys ready!"
Write-Host "   Private: $privateKeyPath (KEEP SECRET ⚠️)"
Write-Host "   Public:  $publicKeyPath (share with web server)`n"

# Display public key for copying
Write-Host "Your public key (for Vercel env var LICENSE_PUBLIC_KEY_PEM):`n"
$publicKeyContent = Get-Content $publicKeyPath
Write-Host $publicKeyContent -ForegroundColor Cyan
Write-Host ""

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🟦 STEP 2: Create Supabase Project`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Go to: https://supabase.com/dashboard/projects`n"
Write-Host "   1. Click 'New Project' or 'Create new project'"
Write-Host "   2. Project name: zalomask-prod"
Write-Host "   3. Database password: (generate strong password)"
Write-Host "   4. Region: Pick closest to your users (Asia → Singapore/Tokyo)"
Write-Host "   5. Pricing: Free tier (scales automatically)"
Write-Host ""
Write-Host "   ⏳ Wait for project to initialize (2-3 minutes)...`n"

$waitResponse = Read-Host "Press Enter when project is ready"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🔑 STEP 3: Setup Supabase Database`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Go to Supabase Dashboard → SQL Editor`n"
Write-Host "   1. Click '+ New Query'"
Write-Host "   2. Copy ALL content from: web/supabase/migrations/0001_init.sql"
Write-Host "   3. Paste into query editor"
Write-Host "   4. Click 'Run' (execute)"
Write-Host ""
Write-Host "✅ Verify tables created: (check left sidebar)"
Write-Host "   ├─ users"
Write-Host "   ├─ licenses"
Write-Host "   ├─ sessions"
Write-Host "   ├─ payments"
Write-Host "   └─ audit_log`n"

$dbReady = Read-Host "Tables created? (y/n)"
if ($dbReady -ne 'y') {
    Write-Host "⚠️  Database not ready. Go back and complete migrations." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🔐 STEP 4: Collect Supabase Connection Strings`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Go to Supabase Dashboard → Settings → Database`n"
Write-Host "Copy these values (save for Vercel later):`n"

Write-Host "1. Connection String (Postgres Driver - URI format)"
Write-Host "   Pattern: postgresql://postgres:PASSWORD@db.supabase.co:5432/postgres"
Write-Host "   ├─ Replace PASSWORD with your database password"
Write-Host "   └─ Save as env var: DATABASE_URL`n"

Write-Host "2. Supabase URL"
Write-Host "   From: Settings → API → Project URL"
Write-Host "   Pattern: https://xxxxx.supabase.co"
Write-Host "   └─ Save as env var: NEXT_PUBLIC_SUPABASE_URL`n"

Write-Host "3. Anon Public Key"
Write-Host "   From: Settings → API → Project API keys → anon"
Write-Host "   └─ Save as env var: NEXT_PUBLIC_SUPABASE_ANON_KEY`n"

$supabaseReady = Read-Host "Saved these values? (y/n)"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🟦 STEP 5: Setup Google OAuth (Supabase Auth)`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Go to Google Cloud Console: https://console.cloud.google.com`n"
Write-Host "   1. Create new project: 'zalomask'"
Write-Host "   2. Enable APIs → OAuth 2.0 Consent Screen"
Write-Host "      ├─ User type: External"
Write-Host "      ├─ App name: ZaloMask"
Write-Host "      ├─ Email: your@email.com"
Write-Host "      └─ Scopes: email, profile"
Write-Host ""
Write-Host "   3. Create OAuth 2.0 Credentials"
Write-Host "      ├─ Type: Web application"
Write-Host "      ├─ Add authorized URI:"
Write-Host "      │   Authorized redirect URIs:"
Write-Host "      │   ├─ http://localhost:3000/auth/callback (dev)"
Write-Host "      │   └─ https://zalomask.com/auth/callback (prod)"
Write-Host "      └─ Copy Client ID + Secret"
Write-Host ""
Write-Host "   4. Go back to Supabase → Authentication → Providers → Google"
Write-Host "      ├─ Paste Client ID"
Write-Host "      ├─ Paste Client Secret"
Write-Host "      └─ Enable provider`n"

Write-Host "Save Client ID for Vercel: NEXT_PUBLIC_GOOGLE_CLIENT_ID`n"

$googleReady = Read-Host "Google OAuth setup? (y/n)"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🟦 STEP 6: Create Vercel Project`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Go to: https://vercel.com/dashboard`n"
Write-Host "   1. Click 'Add New...' → Project"
Write-Host "   2. Import GitHub repo (PCZaloClone)"
Write-Host "   3. Framework: Next.js"
Write-Host "   4. Root directory: web/"
Write-Host "   5. Environment variables:"
Write-Host ""
Write-Host "Configure these (from previous steps):`n"

$envVars = @(
    @{ name = "DATABASE_URL"; value = "postgresql://..."; desc = "Supabase connection string" },
    @{ name = "NEXT_PUBLIC_SUPABASE_URL"; value = "https://xxxxx.supabase.co"; desc = "From Supabase Settings" },
    @{ name = "NEXT_PUBLIC_SUPABASE_ANON_KEY"; value = "eyJ..."; desc = "Public anon key" },
    @{ name = "NEXT_PUBLIC_GOOGLE_CLIENT_ID"; value = "xxx.apps.googleusercontent.com"; desc = "Google OAuth" },
    @{ name = "LICENSE_PRIVATE_KEY"; value = "-----BEGIN PRIVATE KEY-----..."; desc = "Ed25519 private key (from $keysDir)" },
    @{ name = "LICENSE_PUBLIC_KEY_PEM"; value = "-----BEGIN PUBLIC KEY-----..."; desc = "Ed25519 public key" },
    @{ name = "RESEND_API_KEY"; value = "re_xxxxx"; desc = "Email service (optional)" },
    @{ name = "SEPAY_API_KEY"; value = "..."; desc = "Payment gateway" },
    @{ name = "SEPAY_ACCOUNT_NUMBER"; value = "..."; desc = "Bank account for payments" },
    @{ name = "NODE_ENV"; value = "production"; desc = "Environment flag" }
)

foreach ($env in $envVars) {
    Write-Host "   • $($env.name)"
    Write-Host "     └─ $($env.desc)"
}

Write-Host ""
Write-Host "   6. Click 'Deploy'"
Write-Host "   ⏳ Wait for build (5-10 min)...`n"

$vercelReady = Read-Host "Vercel project deployed? (y/n)"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🌐 STEP 7: Setup Custom Domain`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Go to Vercel Project → Settings → Domains`n"
Write-Host "   1. Click 'Add Domain'"
Write-Host "   2. Enter domain (e.g., zalomask.com)"
Write-Host "   3. Choose nameserver method (Vercel will provide)"
Write-Host "   4. Go to domain registrar (Namecheap, Godaddy, etc.)"
Write-Host "   5. Update nameservers to Vercel's nameservers"
Write-Host "   6. Wait DNS propagation (5-30 minutes)"
Write-Host ""
Write-Host "   ✅ Once propagated:"
Write-Host "      ├─ SSL certificate auto-issued (Let's Encrypt)"
Write-Host "      └─ Site live at https://zalomask.com`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "🧪 STEP 8: Test Production APIs`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Test these endpoints (replace zalomask.com):`n"

Write-Host "1. Landing page:"
Write-Host "   curl https://zalomask.com/"
Write-Host ""

Write-Host "2. Pricing page:"
Write-Host "   curl https://zalomask.com/pricing"
Write-Host ""

Write-Host "3. Test API (POST body required, test with curl):"
Write-Host "   curl -X POST https://zalomask.com/api/activate -H 'Content-Type: application/json' -d '{}'`n"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "✅ COMPLETE!`n"
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

Write-Host "Next steps:"
Write-Host "   1. Desktop app ready with auto-update signed installer ✅"
Write-Host "   2. Web platform deployed to production ✅"
Write-Host "   3. Test full flow: app → license activate → web dashboard"
Write-Host "   4. Prepare for beta testing with select users"
Write-Host ""
Write-Host "Documentation: KE_HOACH.md section '0d. Stream 2'`n"
