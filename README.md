# 🎯 Just Count

> Just count. Audit kepatuhan jasa konsultansi konstruksi untuk auditor BPK & APIP.

[![Status](https://img.shields.io/badge/status-active-success)]()
[![Live](https://img.shields.io/badge/live-justcount.masbash.id-blue)]()

**Status:** 🆕 Active
**Live:** https://justcount.masbash.id _(soon — deploy via Railway)_
**Repo:** https://github.com/bashideffendi/justcount _(akan dibuat)_
**Stack:** Node.js + Express + SQLite + Alpine.js + Tailwind

---

## ✨ What

**Just Count** adalah platform audit kepatuhan untuk pengadaan **Jasa Konsultansi Konstruksi** yang dibiayai APBD. Dipakai oleh auditor BPK / APIP untuk memeriksa 3 area:

1. **Perencanaan** — KAK, HPS, RAB, jenis kontrak, remunerasi (8 checklist)
2. **Pelaksanaan** — Mobilisasi, substitusi TA, pembayaran, adendum (8 checklist + engine numerik)
3. **Pelaporan** — BAST, rekonsiliasi, penilaian kinerja, arsip (8 checklist)

OPD pengelola paket diajak isi data lewat akun terbatas (kode akses). Auditor lakukan verifikasi & pengujian. Sistem auto-generate kertas kerja Excel + Berita Acara Permintaan Keterangan (BAPK) Word.

## 🎁 Features

### Multi-tenant
- ✅ Per **Surat Tugas** = 1 audit context (workspace isolation)
- ✅ Multi-account auditor dengan role super_admin / auditor
- ✅ Sign-up via invite link dari super admin
- ✅ OPD login dengan kode akses unik per (OPD × Audit)

### Audit Engine
- ✅ **3 area checklist** dengan dasar hukum lengkap (Perpres 46/2025, Perlem LKPP 11/2021, 12/2021, UU 2/2017, dll) — ~24 item
- ✅ **Engine numerik** — 7 skenario personel (fiktif, pengganti, SKA expired, kehadiran, tumpang tindih, lumpsum > batas) + 4 non-personel
- ✅ **Lintas paket** — Sweep line algorithm untuk deteksi tumpang tindih waktu penugasan & lumpsum > batas

### Multi SP2D per Paket
- ✅ Excel parser auto-detect kolom "Nomor Paket" untuk grouping
- ✅ UI bulk merge / split SP2D antar paket (admin & OPD)

### SKA Checker
- ✅ Integrasi API cekskk.com (via [cek-sertifikat-keahlian.up.railway.app](https://cek-sertifikat-keahlian.up.railway.app))
- ✅ Cache 30 hari per pemberi keterangan

### BAPK Auto-Generator
- ✅ Generate Word DOCX dari hasil audit (kop BPK Perwakilan + logo)
- ✅ Format sesuai template BPK Perwakilan
- ✅ Master 35 BPK Perwakilan dengan alamat preset (auto-fill)

### Production-ready
- ✅ Helmet (security headers), gzip compression, rate limiting
- ✅ Persistent file-based session (tahan restart)
- ✅ Auto-backup harian SQLite (rolling 30 hari)
- ✅ Health check `/healthz` untuk uptime monitoring

## 🛠️ Local Development

**Prerequisites:**
- Node.js >= 20
- npm >= 10

**Setup:**
```bash
git clone https://github.com/bashideffendi/justcount.git
cd justcount
npm install
cp .env.example .env  # edit secret-secret kalau perlu
npm start
```

Buka http://localhost:3000

**Default super admin** (auto-seeded saat DB kosong):
- Email: `admin@justcount.id`
- Password: `admin123`

## 🔐 Environment Variables

Lihat `.env.example` untuk daftar lengkap.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Production | `development` | `production` di Railway |
| `PORT` | No | `3000` | Auto-set di Railway |
| `SESSION_SECRET` | **Yes (prod)** | - | Random 32+ char |
| `ADMIN_EMAIL` | No | `admin@justcount.id` | Bootstrap super admin |
| `ADMIN_PASSWORD` | No | `admin123` | Bootstrap password |
| `DATA_DIR` | No | project root | Production: `/data` (Railway volume) |
| `SKA_API_URL` | No | cek-sertifikat-keahlian.up.railway.app | API SKA Checker |

## 🚀 Deploy

**Platform**: Railway

**Files:**
- `railway.json` — build & deploy config
- `Procfile` — start command (backup)

**Steps:**
1. Push to GitHub → connect repo di Railway
2. Add env vars (lihat tabel di atas)
3. Add persistent volume mount `/data` (size 1 GB)
4. Deploy → dapat URL `xxx.up.railway.app`
5. Custom domain: `justcount.masbash.id` (CNAME ke Railway URL)

## 📦 Tech Stack

- **Backend**: Node.js 20+, Express 4
- **Database**: SQLite via `better-sqlite3` (WAL mode, single-file)
- **Frontend**: HTML + Alpine.js 3 + Tailwind CSS (CDN)
- **Auth**: bcryptjs + express-session (file store)
- **Security**: helmet, express-rate-limit, compression
- **Document gen**: `docx` (BAPK Word), `xlsx` (kertas kerja Excel)
- **External API**: cekskk.com via cek-sertifikat-keahlian.up.railway.app

## 📝 License

Personal project. © Bashid Effendi 2026.

---

Dibuat untuk membantu kerja audit BPK supaya lebih efisien. *Just count.*
