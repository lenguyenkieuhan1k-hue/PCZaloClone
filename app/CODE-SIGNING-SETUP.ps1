#!/usr/bin/env powershell

# ZaloMask Code Signing Setup Guide
# 
# This script helps you:
# 1. Obtain an EV code signing certificate from SSL.com
# 2. Convert it to .pfx format
# 3. Encode it to base64 for GitHub secrets
# 4. Configure GitHub Actions for auto-signing

Write-Host "╔════════════════════════════════════════════════════════╗"
Write-Host "║  ZaloMask Auto-Update Code Signing Setup Guide        ║"
Write-Host "║  (Windows 10/11 SmartScreen trusted installer)        ║"
Write-Host "╚════════════════════════════════════════════════════════╝`n"

Write-Host "📋 Step 1: Purchase EV Code Signing Certificate`n"
Write-Host "Choose ONE of these providers:`n"
Write-Host "   1. SSL.com (recommended - $330/year, 1-2 days)"
Write-Host "      https://www.ssl.com/certificates/code-signing/windows"
Write-Host "      ├─ Brand: SSL.com"
Write-Host "      ├─ Type: EV Windows (Code Signing)"
Write-Host "      ├─ Duration: 1 Year"
Write-Host "      └─ Delivery: Instant (after ID verification)"
Write-Host ""
Write-Host "   2. Sectigo (DigiCert) - $500+/year, 1-2 days"
Write-Host "      https://www.sectigo.com/ssl-certificates-tls/code-signing"
Write-Host ""
Write-Host "   ⚠️  Do NOT choose Standard (non-EV) certificates."
Write-Host "      They won't be trusted by SmartScreen on first install.`n"

Write-Host "📋 Step 2: CSR Generation (Certificate Signing Request)`n"
Write-Host "When purchasing, at CSR step:"
Write-Host "   ├─ Choose: 'I will provide my own CSR'"
Write-Host "   └─ OR let provider generate (simpler if available)`n"

Write-Host "📋 Step 3: Verify and Download Certificate`n"
Write-Host "After ID verification (24-48 hours):"
Write-Host "   ├─ You'll receive email with cert file (.p7b or .pfx)"
Write-Host "   ├─ Download to safe location"
Write-Host "   └─ Test on local machine first`n"

Write-Host "📋 Step 4: Convert Certificate to .PFX (if needed)`n"
Write-Host "If you have .p7b (PKCS#7):"
Write-Host ""
Write-Host "   # Option A: Windows Certificate Manager (easiest)"
Write-Host "   - Double-click the .p7b file"
Write-Host "   - Choose 'Install Certificate' → Local Machine"
Write-Host "   - Follow wizard → Complete"
Write-Host "   - Run: certmgr.msc"
Write-Host "   - Right-click cert → Export as .PFX with private key"
Write-Host ""
Write-Host "   # Option B: OpenSSL (command line)"
Write-Host "   openssl pkcs7 -inform PEM -in cert.p7b -print_certs -out cert.pem"
Write-Host "   openssl pkcs12 -export -in cert.pem -out cert.pfx"
Write-Host ""

Write-Host "📋 Step 5: Encode Certificate for GitHub`n"

# Prompt for certificate path
$certPath = Read-Host "Enter absolute path to .pfx file (e.g., C:\certs\zalomask.pfx)"

if (-not (Test-Path $certPath)) {
    Write-Host "❌ File not found: $certPath" -ForegroundColor Red
    exit 1
}

Write-Host "📍 Reading certificate..." -ForegroundColor Cyan

# Read and encode
$certBytes = [IO.File]::ReadAllBytes($certPath)
$certBase64 = [Convert]::ToBase64String($certBytes)

Write-Host "✅ Certificate encoded successfully!`n"

# Save to file for easy copy-paste
$outputFile = "$PSScriptRoot\cert-github-secret.txt"
$certBase64 | Out-File -FilePath $outputFile -Encoding UTF8

Write-Host "📋 Step 6: Setup GitHub Secrets`n"
Write-Host "Go to GitHub → Your Repo → Settings → Secrets and variables → Actions`n"

Write-Host "Create TWO new secrets:`n"
Write-Host "   Secret 1: SIGNING_CERT_BASE64"
Write-Host "   ├─ Copy entire content from: $outputFile"
Write-Host "   ├─ Size: ~$(([Math]::Round($certBase64.Length / 1024, 2))) KB"
Write-Host "   └─ Paste into GitHub secret value (may wrap - that's OK)`n"

Write-Host "   Secret 2: SIGNING_CERT_PASSWORD"
Write-Host "   ├─ Value: <password you set when exporting .pfx>"
Write-Host "   └─ This is the passphrase that protects the certificate`n"

# Show where the base64 is stored
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "📎 BASE64 CONTENT SAVED:`n"
Write-Host "   File: $outputFile`n"

Write-Host "📋 Step 7: Test on GitHub`n"
Write-Host "Once secrets are set:"
Write-Host "   1. Increment version in app/package.json:"
Write-Host "      \"version\": \"26.3.2\""
Write-Host ""
Write-Host "   2. Commit and push to main:"
Write-Host "      git add ."
Write-Host "      git commit -m 'v26.3.2'"
Write-Host "      git tag v26.3.2"
Write-Host "      git push origin main --tags"
Write-Host ""
Write-Host "   3. Watch GitHub Actions:"
Write-Host "      https://github.com/YOUR_REPO/actions"
Write-Host ""
Write-Host "   4. If successful:"
Write-Host "      └─ Check Releases tab for signed installer"
Write-Host ""
Write-Host "   5. Verify signature on Windows:"
Write-Host "      Right-click .exe → Properties → Digital Signatures"
Write-Host "      Should show 'ZaloMask' as signer, no warnings"
Write-Host ""

Write-Host "🎯 Final Step: Test Auto-Update Locally`n"
Write-Host "After release:"
Write-Host "   1. Download signed installer from GitHub Release"
Write-Host "   2. Install on Windows 10/11 machine"
Write-Host "   3. Should NOT show SmartScreen warning"
Write-Host "   4. App should auto-detect updates when new version released"
Write-Host "   5. User clicks 'Update now' → installer downloads + installs"
Write-Host ""

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Host "✅ Setup complete! Next: Push secrets to GitHub and test tag.`n"

# Cleanup sensitive data after use
Write-Host "⚠️  Security reminder:"
Write-Host "   ├─ Delete .pfx file from local machine after testing"
Write-Host "   ├─ Never commit .pfx or passwords to git"
Write-Host "   ├─ Use GitHub Secrets instead"
Write-Host "   └─ Cert password should only exist in GitHub Secrets`n"

Write-Host "For documentation, see: KE_HOACH.md section '0d. Stream 1: Task 1-3'`n"
