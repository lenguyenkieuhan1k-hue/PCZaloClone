# ZaloMask Web (zalomask.com)

Next.js 14 (App Router) + Supabase + SePay + Resend. Đây là backend / landing / dashboard
cho ZaloMask app — cùng repo, deploy độc lập sang Vercel.

## Stack

- **Next.js 14 App Router** + TypeScript + Tailwind
- **Supabase** — Postgres + Auth (Google OAuth) + RLS policies
- **SePay** — gateway QR chuyển khoản (webhook về `/api/sepay-webhook`)
- **Resend** — gửi email license key
- **Ed25519** signed license tokens (node:crypto, không phụ thuộc thư viện ngoài)

## Cấu trúc

```
web/
├── app/
│   ├── layout.tsx              # header/footer chung
│   ├── page.tsx                # landing
│   ├── pricing/page.tsx        # 5 gói + 4 thời hạn
│   ├── checkout/[plan]/        # QR SePay
│   ├── dashboard/              # khách
│   ├── admin/                  # bạn (kiểm soát qua ADMIN_EMAILS env)
│   ├── auth/sign-in            # Google OAuth
│   ├── auth/callback           # Supabase token exchange
│   └── api/
│       ├── activate/           # Electron app gọi để activate key
│       ├── heartbeat/          # 30s/lần để check kicked
│       ├── claim-free/         # cấp key miễn phí 1 tài khoản cho user đã đăng nhập
│       ├── dev/seed-license/   # endpoint seed license test local (dev only)
│       └── sepay-webhook/      # SePay → tạo key + email
├── lib/
│   ├── supabase.ts             # 3 client: browser / server / admin
│   ├── plans.ts                # bảng giá nguồn
│   ├── license-token.ts        # Ed25519 sign/verify
│   └── auth-helpers.ts
└── supabase/migrations/
    └── 0001_init.sql           # schema users / licenses / sessions / payments / audit_log
```

## Setup từ đầu

### 1. Tài khoản

Tạo các account này (chưa có thì dừng, làm xong mới tiếp tục):

- Supabase: https://supabase.com → tạo project mới `zalomask-prod`
- Vercel: https://vercel.com → connect GitHub
- SePay: https://sepay.vn → đăng ký + gắn ngân hàng nhận tiền
- Resend: https://resend.com → tạo API key + verify domain `zalomask.com`
- Google Cloud Console → tạo OAuth client (Web) → callback `https://YOUR-PROJECT.supabase.co/auth/v1/callback`

### 2. Supabase

```bash
# Vào Dashboard → SQL Editor → New query → paste nguyên file:
cat web/supabase/migrations/0001_init.sql
```

Trong **Authentication → Providers**:
- Bật **Google**, dán Client ID + Secret từ Google Cloud
- Site URL: `https://zalomask.com`
- Redirect URLs: thêm `https://zalomask.com/auth/callback` và `http://localhost:3000/auth/callback`

### 3. Ed25519 key cho license token

Chạy local 1 lần để sinh keypair:

```bash
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});console.log('PUBLIC:',publicKey);console.log('PRIVATE:',privateKey)"
```

- Public key → embed vào Electron app sau (Phase 2 của desktop app)
- Private key → nạp vào env `LICENSE_TOKEN_PRIVATE_KEY` của Vercel

### 4. SePay webhook

- Đăng nhập SePay → Cấu hình webhook
- URL: `https://zalomask.com/api/sepay-webhook`
- Header: `Authorization: Apikey <random-secret-bạn-tự-sinh>`
- Lưu secret vào env `SEPAY_WEBHOOK_SECRET` (cả Vercel + local)

### 5. Env

```bash
cp web/.env.example web/.env.local
# Điền các giá trị thực tế (lấy từ Supabase, SePay, Resend, Google).
```

Sao chép toàn bộ env này vào **Vercel → Project Settings → Environment Variables** trước khi deploy.

### 6. Local dev

```bash
cd web
npm install
npm run dev
# http://localhost:3000
```

### 7. Deploy

**Chính (production zalomask.com):** trong Vercel Dashboard connect GitHub repo → **Root Directory = `web/`** → mỗi lần push `main` là build production (domain đã gắn sẵn giữ nguyên).

**CLI (`npx vercel --prod`):**

```bash
cd web
npx vercel link    # chọn đúng Team + Project đã có domain zalomask.com (đừng để CLI tạo project “web” mặc định nhầm)
npx vercel --prod
```

Nếu lần đầu chạy `--prod` **không** link trước, CLI có thể **tạo project Vercel mới** + URL kiểu `*.vercel.app` — code đã deploy nhưng **chưa** thay thế site trên `zalomask.com`. Project mới cần **copy đủ Environment Variables** giống project production (Supabase, license keys, v.v.).

Luồng đồng bộ cloud lớn cần route `upload-init` / `upload-commit` và migration bucket Storage (`supabase/migrations/0006_cloud_storage_bucket.sql` hoặc tương đương).

### 8. DNS

Trỏ `zalomask.com` về Vercel:
- A record `@` → `76.76.21.21`
- CNAME `www` → `cname.vercel-dns.com`

Vercel UI sẽ hiển thị config chính xác sau khi add domain.

## Lưu ý vận hành

- **Free tier mặc định:** user chưa kích hoạt key trả phí vẫn dùng được ở mức 1 tài khoản (gói miễn phí).
- **Claim free key:** user đăng nhập có thể vào `/api/claim-free` để nhận key miễn phí (1 user chỉ nhận 1 key free).
- **Dev smoke test license:** dùng endpoint `/api/dev/seed-license` + script `npm run smoke:license` (cần `DEV_SEED_SECRET`).

- **Gateway VAT (Paddle) cho khách quốc tế:** chưa wire — Phase mở rộng nếu cần
- **Refund:** chưa có endpoint, làm thủ công qua Supabase Dashboard + audit_log
- **`audit_log` không có RLS read** — chỉ truy cập qua admin client (service-role)
- **Email key gửi failed:** webhook vẫn return 200 để SePay không retry; admin gọi RPC resend thủ công
- **Heartbeat:** Electron client poll mỗi 30s. Nếu offline > 30 phút thì client tự khoá (chưa implement phần Electron — Phase tiếp)
- **Match memo SePay:** parser trong `app/api/sepay-webhook/route.ts` linh hoạt với khoảng trắng và dấu gạch ngang nhưng yêu cầu đủ 4 thành phần `ZM <id8> <tier-N> <1m|3m|6m|1y>`
