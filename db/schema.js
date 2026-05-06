const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR: lokasi semua file persistent (DB, uploads, backups, sessions).
// Production (Railway): /data (mount volume). Dev: project root.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}
const DB_PATH = path.join(DATA_DIR, 'audit.db');

function initDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS opd (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nama TEXT NOT NULL UNIQUE,
      kode_akses TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS paket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opd_id INTEGER NOT NULL REFERENCES opd(id) ON DELETE CASCADE,
      nomor_paket TEXT,
      nama_pekerjaan TEXT NOT NULL,
      nilai_paket REAL NOT NULL DEFAULT 0,
      nilai_realisasi REAL DEFAULT 0,
      tahun_anggaran INTEGER,
      no_kontrak TEXT,
      tanggal_kontrak DATE,
      tanggal_mulai DATE,
      tanggal_selesai DATE,
      bentuk_badan TEXT CHECK(bentuk_badan IN ('PT','CV','Perorangan') OR bentuk_badan IS NULL),
      nama_penyedia TEXT,
      ppk_nama TEXT,
      ppk_nip TEXT,
      pptk_nama TEXT,
      pptk_nip TEXT,
      jenis_kontrak TEXT CHECK(jenis_kontrak IN ('lumpsum','waktu_penugasan')),
      jenis_konsultansi TEXT CHECK(jenis_konsultansi IN ('pengawasan','perencanaan','gabungan','non_konstruksi')),
      output_diharapkan TEXT,
      status TEXT NOT NULL DEFAULT 'belum_diisi'
        CHECK(status IN ('belum_diisi','draft','lengkap','terkunci')),
      locked_at DATETIME,
      audited_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_paket_opd ON paket(opd_id);
    CREATE INDEX IF NOT EXISTS idx_paket_status ON paket(status);
    CREATE INDEX IF NOT EXISTS idx_paket_jenis ON paket(jenis_kontrak);

    CREATE TABLE IF NOT EXISTS paket_sp2d (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      no_sp2d TEXT NOT NULL UNIQUE,
      tanggal_sp2d DATE,
      nilai_sp2d REAL NOT NULL DEFAULT 0,
      nilai_realisasi REAL,
      jenis_akun TEXT,
      nama_rekening TEXT,
      nama_penerima TEXT,
      keterangan TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_psp2d_paket ON paket_sp2d(paket_id);

    CREATE TABLE IF NOT EXISTS tenaga_ahli_kontrak (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      nama TEXT NOT NULL,
      nik TEXT NOT NULL,
      jabatan TEXT NOT NULL,
      periode_mulai DATE,
      periode_selesai DATE
    );
    CREATE INDEX IF NOT EXISTS idx_tak_paket ON tenaga_ahli_kontrak(paket_id);
    CREATE INDEX IF NOT EXISTS idx_tak_nik ON tenaga_ahli_kontrak(nik);

    CREATE TABLE IF NOT EXISTS biaya_personel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      tenaga_ahli_kontrak_id INTEGER REFERENCES tenaga_ahli_kontrak(id) ON DELETE SET NULL,
      jabatan TEXT NOT NULL,
      jenjang_disyaratkan TEXT,
      bidang TEXT,
      mm REAL NOT NULL,
      tarif_per_bulan REAL NOT NULL,
      total REAL GENERATED ALWAYS AS (mm * tarif_per_bulan) VIRTUAL
    );
    CREATE INDEX IF NOT EXISTS idx_bp_paket ON biaya_personel(paket_id);

    CREATE TABLE IF NOT EXISTS biaya_non_personel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      kategori TEXT,
      uraian TEXT NOT NULL,
      volume REAL NOT NULL,
      satuan TEXT,
      harga_satuan REAL NOT NULL,
      total REAL GENERATED ALWAYS AS (volume * harga_satuan) VIRTUAL
    );
    CREATE INDEX IF NOT EXISTS idx_bnp_paket ON biaya_non_personel(paket_id);

    CREATE TABLE IF NOT EXISTS tenaga_ahli_aktual (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      biaya_personel_id INTEGER REFERENCES biaya_personel(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('sesuai','pengganti','fiktif')),
      nama TEXT,
      nik TEXT,
      jabatan TEXT,
      pendidikan_jenjang TEXT,
      pendidikan_jurusan TEXT,
      no_ska TEXT,
      jenjang_ska TEXT,
      klasifikasi_ska TEXT,
      masa_berlaku_ska DATE,
      no_skk TEXT,
      jenjang_skk TEXT,
      no_skt TEXT,
      hari_kerja_aktual INTEGER,
      catatan_wawancara TEXT,
      narasumber TEXT,
      tanggal_wawancara DATE,
      jenjang_efektif TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_taa_paket ON tenaga_ahli_aktual(paket_id);
    CREATE INDEX IF NOT EXISTS idx_taa_nik ON tenaga_ahli_aktual(nik);
    CREATE INDEX IF NOT EXISTS idx_taa_bp ON tenaga_ahli_aktual(biaya_personel_id);

    CREATE TABLE IF NOT EXISTS bukti_kehadiran (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenaga_ahli_aktual_id INTEGER NOT NULL REFERENCES tenaga_ahli_aktual(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS verifikasi_non_personel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      biaya_non_personel_id INTEGER NOT NULL REFERENCES biaya_non_personel(id) ON DELETE CASCADE,
      status_realisasi TEXT NOT NULL
        CHECK(status_realisasi IN ('sesuai','kurang','tidak_ada','mark_up','fiktif')),
      volume_aktual REAL,
      harga_bukti_sah REAL,
      catatan TEXT,
      catatan_pajak TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(biaya_non_personel_id)
    );

    CREATE TABLE IF NOT EXISTS bukti_non_personel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      verifikasi_id INTEGER NOT NULL REFERENCES verifikasi_non_personel(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS master_sbu_personel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sumber TEXT NOT NULL CHECK(sumber IN ('pemda','inkindo')),
      tahun INTEGER NOT NULL,
      jenjang_keahlian TEXT NOT NULL,
      jenjang_pendidikan TEXT,
      pengalaman_tahun_min INTEGER NOT NULL DEFAULT 0,
      pengalaman_tahun_max INTEGER,
      tarif_per_bulan REAL NOT NULL,
      catatan TEXT,
      UNIQUE(sumber, tahun, jenjang_keahlian, jenjang_pendidikan, pengalaman_tahun_min)
    );
    CREATE INDEX IF NOT EXISTS idx_sbu_lookup ON master_sbu_personel(sumber, tahun, jenjang_keahlian);

    CREATE TABLE IF NOT EXISTS temuan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      jenis TEXT NOT NULL,
      skenario TEXT,
      ref_id INTEGER,
      nama_subjek TEXT,
      nik_subjek TEXT,
      nilai_kontrak REAL,
      nilai_berhak REAL,
      selisih REAL NOT NULL,
      uraian TEXT,
      dasar TEXT,
      payload_json TEXT,
      dijalankan_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_temuan_paket ON temuan(paket_id);
    CREATE INDEX IF NOT EXISTS idx_temuan_jenis ON temuan(jenis);

    CREATE TABLE IF NOT EXISTS ska_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nik TEXT,
      nama TEXT,
      ditemukan INTEGER NOT NULL DEFAULT 0,
      hasil_json TEXT,
      status_scrape TEXT,
      error_msg TEXT,
      dicek_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(nik, nama)
    );
    CREATE INDEX IF NOT EXISTS idx_ska_nik ON ska_cache(nik);

    CREATE TABLE IF NOT EXISTS pengaturan (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT
    );

    -- Auditor / Admin user (multi-account, multi-tenant: tied to 1 surat tugas)
    -- Super admin: surat_tugas_id NULL = lihat semua audit
    -- Auditor: wajib assigned ke 1 surat_tugas_id
    CREATE TABLE IF NOT EXISTS user_admin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nama TEXT NOT NULL,
      nip TEXT,
      jabatan TEXT,
      role TEXT NOT NULL DEFAULT 'auditor' CHECK(role IN ('super_admin','auditor')),
      surat_tugas_id INTEGER REFERENCES surat_tugas(id) ON DELETE SET NULL,
      aktif INTEGER NOT NULL DEFAULT 1,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Invite sign-up (Super Admin generate, temen pakai link buat daftar)
    CREATE TABLE IF NOT EXISTS signup_invite (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      surat_tugas_id INTEGER REFERENCES surat_tugas(id) ON DELETE CASCADE,
      email_hint TEXT,
      catatan TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at DATETIME,
      created_by INTEGER REFERENCES user_admin(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_invite_token ON signup_invite(token);

    -- OPD x Surat Tugas (M2M dengan kode akses unik per pair)
    -- 1 OPD entity bisa diaudit di banyak surat tugas, masing-masing kode beda
    CREATE TABLE IF NOT EXISTS opd_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opd_id INTEGER NOT NULL REFERENCES opd(id) ON DELETE CASCADE,
      surat_tugas_id INTEGER NOT NULL REFERENCES surat_tugas(id) ON DELETE CASCADE,
      kode_akses TEXT NOT NULL UNIQUE,
      aktif INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(opd_id, surat_tugas_id)
    );
    CREATE INDEX IF NOT EXISTS idx_opd_audit_opd ON opd_audit(opd_id);
    CREATE INDEX IF NOT EXISTS idx_opd_audit_surat ON opd_audit(surat_tugas_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Surat Tugas Pemeriksaan (untuk Berita Acara)
    CREATE TABLE IF NOT EXISTS surat_tugas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nomor TEXT NOT NULL UNIQUE,
      tanggal DATE NOT NULL,
      bpk_perwakilan TEXT NOT NULL,
      alamat_perwakilan TEXT,
      telepon TEXT,
      fax TEXT,
      email TEXT,
      website TEXT,
      nama_pemeriksaan TEXT NOT NULL,
      entitas_diperiksa TEXT,
      tahun_anggaran_target INTEGER,
      periode_audit_mulai DATE,
      periode_audit_selesai DATE,
      status TEXT NOT NULL DEFAULT 'aktif' CHECK(status IN ('draft','aktif','selesai')),
      keterangan TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pemeriksa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surat_tugas_id INTEGER NOT NULL REFERENCES surat_tugas(id) ON DELETE CASCADE,
      nama TEXT NOT NULL,
      nip TEXT,
      jabatan TEXT,
      peran TEXT,
      urutan INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pemeriksa_surat ON pemeriksa(surat_tugas_id);

    -- Berita Acara Permintaan Keterangan (BAPK) — sesuai format BPK Perwakilan
    CREATE TABLE IF NOT EXISTS berita_acara (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surat_tugas_id INTEGER NOT NULL REFERENCES surat_tugas(id) ON DELETE CASCADE,
      paket_id INTEGER REFERENCES paket(id) ON DELETE SET NULL,
      nomor TEXT,
      hari TEXT,
      tanggal DATE,
      -- Pemberi keterangan
      pemberi_nama TEXT NOT NULL,
      pemberi_jabatan TEXT,
      pemberi_skpd TEXT,
      pemberi_nomor_kontak TEXT,
      pemberi_nip TEXT,
      nama_penyedia TEXT,
      -- Hasil
      hasil_keterangan TEXT,
      -- Tanda tangan
      pemeriksa_1_id INTEGER REFERENCES pemeriksa(id) ON DELETE SET NULL,
      pemeriksa_2_id INTEGER REFERENCES pemeriksa(id) ON DELETE SET NULL,
      ppk_nama TEXT,
      ppk_nip TEXT,
      pptk_nama TEXT,
      pptk_nip TEXT,
      penyedia_rep_nama TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','final')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ba_surat ON berita_acara(surat_tugas_id);
    CREATE INDEX IF NOT EXISTS idx_ba_paket ON berita_acara(paket_id);

    -- Master checklist item per area audit (perencanaan/pelaksanaan/pelaporan)
    CREATE TABLE IF NOT EXISTS audit_checklist_item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      area TEXT NOT NULL CHECK(area IN ('perencanaan','pelaksanaan','pelaporan')),
      kode TEXT NOT NULL UNIQUE,
      judul TEXT NOT NULL,
      fokus_uji TEXT NOT NULL,
      bukti_minimum TEXT,
      indikator_patuh TEXT,
      red_flag TEXT,
      dasar_hukum TEXT,
      urutan INTEGER DEFAULT 0,
      aktif INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_checklist_area ON audit_checklist_item(area, urutan);

    -- Hasil checklist per paket per item
    CREATE TABLE IF NOT EXISTS audit_checklist_hasil (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paket_id INTEGER NOT NULL REFERENCES paket(id) ON DELETE CASCADE,
      checklist_item_id INTEGER NOT NULL REFERENCES audit_checklist_item(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('patuh','lemah','tidak_patuh','na')),
      catatan TEXT,
      lokasi_bukti TEXT,
      dampak_pengembalian REAL DEFAULT 0,
      dijalankan_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(paket_id, checklist_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_checklist_hasil_paket ON audit_checklist_hasil(paket_id);

    -- File bukti upload (optional)
    CREATE TABLE IF NOT EXISTS audit_checklist_bukti (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hasil_id INTEGER NOT NULL REFERENCES audit_checklist_hasil(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed master checklist items (idempotent via UNIQUE on kode)
  seedChecklistItems(db);

  // Bootstrap super admin pertama kalau tabel user_admin kosong
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM user_admin').get().c;
  if (userCount === 0) {
    const bcrypt = require('bcryptjs');
    const defaultEmail = process.env.ADMIN_EMAIL || 'admin@justcount.id';
    const defaultPass = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(defaultPass, 10);
    db.prepare(`
      INSERT INTO user_admin(email, password_hash, nama, role, aktif)
      VALUES (?, ?, ?, 'super_admin', 1)
    `).run(defaultEmail, hash, 'Super Admin');
    console.log(`[bootstrap] Super admin seeded: ${defaultEmail} / ${defaultPass}`);
  }

  // Seed pengaturan
  const upsertSetting = db.prepare(`
    INSERT INTO pengaturan(key, value, description)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  upsertSetting.run('hari_kerja_per_bulan', '22', 'Hari kerja standar per bulan untuk konversi MM');
  upsertSetting.run('batas_lumpsum_bersamaan', '3', 'Batas paket lumpsum bersamaan per Perlem LKPP');
  upsertSetting.run('tahun_anggaran_aktif', '2025', 'Tahun anggaran yang sedang diaudit');
  upsertSetting.run('ska_cache_ttl_hari', '30', 'TTL cache hasil scrape SKA dalam hari');
  upsertSetting.run('sumber_tarif_aktif', 'inkindo', 'Sumber tarif personel untuk uji: pemda atau inkindo');
  upsertSetting.run('surat_tugas_aktif', '', 'ID Surat Tugas yang aktif (dipakai default di Berita Acara)');

  // Seed Master SBU — Sumber INKINDO (placeholder realistic, admin bisa edit)
  // Tarif INKINDO Pedoman Standar Minimum ~Rp/bulan (range realistic 2024-2026)
  // User isi sendiri kalau pakai sumber 'pemda'
  const upsertSbu = db.prepare(`
    INSERT INTO master_sbu_personel(
      sumber, tahun, jenjang_keahlian, jenjang_pendidikan,
      pengalaman_tahun_min, pengalaman_tahun_max, tarif_per_bulan, catatan
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sumber, tahun, jenjang_keahlian, jenjang_pendidikan, pengalaman_tahun_min) DO NOTHING
  `);
  const tahunSbu = [2024, 2025, 2026];
  // (jenjang_keahlian, jenjang_pendidikan, exp_min, exp_max, tarif_2025)
  const sbuRows = [
    ['Tanpa Sertifikat', 'SMA/SMK',  0, null,   8_000_000],
    ['Tanpa Sertifikat', 'D3/D4',    0, null,  10_000_000],
    ['Tanpa Sertifikat', 'S1',       0, null,  12_000_000],
    ['Pratama',          'S1',       0,    4,  16_000_000],
    ['Muda',             'S1',       5,    9,  24_000_000],
    ['Muda',             'S2',       0,    4,  26_000_000],
    ['Madya',            'S1',      10,   14,  36_000_000],
    ['Madya',            'S2',       5,    9,  38_000_000],
    ['Madya',            'S3',       0,    4,  40_000_000],
    ['Utama',            'S1',      15, null,  55_000_000],
    ['Utama',            'S2',      10, null,  58_000_000],
    ['Utama',            'S3',       5, null,  62_000_000],
  ];
  for (const tahun of tahunSbu) {
    // Skala kasar inflasi: 2024 = -5%, 2025 = base, 2026 = +5%
    const factor = tahun === 2024 ? 0.95 : tahun === 2026 ? 1.05 : 1.0;
    for (const [jk, jp, expMin, expMax, tarif] of sbuRows) {
      upsertSbu.run('inkindo', tahun, jk, jp, expMin, expMax, Math.round(tarif * factor), `Placeholder INKINDO ${tahun} — admin edit sesuai tarif resmi`);
    }
  }

  return db;
}

// === Master checklist seed dari PDF "Audit Kepatuhan Pengadaan Jasa Konsultansi Konstruksi" ===
function seedChecklistItems(db) {
  const items = [
    // ===== AREA 1: PERENCANAAN KONTRAK =====
    {
      area: 'perencanaan', kode: 'P01', urutan: 10,
      judul: 'Identifikasi Kebutuhan dan Anggaran',
      fokus_uji: 'Apakah kebutuhan paket jelas, ada basis di RKA/DPA, dan RUP diumumkan tepat waktu (paling lambat 31 Maret)',
      bukti_minimum: 'RKA/DPA, nota identifikasi kebutuhan, bukti RUP/SIRUP',
      indikator_patuh: 'Paket muncul di RUP, deskripsi paket konsisten dengan anggaran, RUP diumumkan ≤ 31 Maret',
      red_flag: 'Paket tidak muncul di RUP, RUP terlambat, tujuan paket tidak jelas',
      dasar_hukum: 'Perpres 46/2025 Ps. 18; Perlem LKPP 11/2021 Ps. 4-8',
    },
    {
      area: 'perencanaan', kode: 'P02', urutan: 20,
      judul: 'Kerangka Acuan Kerja (KAK)',
      fokus_uji: 'Apakah ruang lingkup, keluaran terukur, jadwal, metode, lokasi, pengawasan, dan kebutuhan tenaga ahli terdefinisi jelas',
      bukti_minimum: 'KAK final yang ditetapkan PPK, lampiran jadwal, matriks keluaran, rencana kebutuhan personel',
      indikator_patuh: 'Ada acceptance criteria untuk tiap keluaran; jumlah personel logis; sinkron dengan jadwal paket konstruksi yang diawasi',
      red_flag: 'KAK generik / copy-paste; keluaran tidak terukur (frasa umum "menyusun laporan"); jadwal tidak sinkron',
      dasar_hukum: 'Perpres 46/2025 Ps. 25; Perlem LKPP 11/2021 (KAK harus sesuai kebutuhan)',
    },
    {
      area: 'perencanaan', kode: 'P03', urutan: 30,
      judul: 'Harga Perkiraan Sendiri (HPS)',
      fokus_uji: 'Apakah HPS berbasis data yang dapat dipertanggungjawabkan, sinkron dengan KAK, ada rantai sumber data',
      bukti_minimum: 'HPS, rincian HPS, working paper, survei pasar, referensi harga, tanggal pengambilan data',
      indikator_patuh: 'Ada jejak sumber data dan tanggal data; matching antara komponen biaya HPS dan kebutuhan personel KAK; berbasis harga pasar setempat / e-katalog',
      red_flag: 'HPS angka jadi tanpa working paper; sumber tidak dapat diverifikasi; rincian HPS bocor ke peserta',
      dasar_hukum: 'Perpres 46/2025 Ps. 26; Permen PUPR 8/2023; SE Menteri PUPR 21/2023',
    },
    {
      area: 'perencanaan', kode: 'P04', urutan: 40,
      judul: 'Remunerasi Tenaga Ahli',
      fokus_uji: 'Apakah tarif tenaga ahli mematuhi standar remunerasi minimal yang berlaku (Permen PUPR 19/2017 + update Kepmen PU 33/2025)',
      bukti_minimum: 'Working paper HPS, referensi Permen PUPR 19/2017 / Kepmen PU 33/KPTS/M/2025, mapping jabatan ahli',
      indikator_patuh: 'Tarif tidak di bawah standar minimal; klasifikasi ahli tepat sesuai jenjang',
      red_flag: 'Tarif terlalu rendah; jabatan ahli "diturunkan" agar HPS muat anggaran',
      dasar_hukum: 'UU 2/2017 Jasa Konstruksi; Permen PUPR 19/PRT/M/2017; Kepmen PU 33/KPTS/M/2025',
    },
    {
      area: 'perencanaan', kode: 'P05', urutan: 50,
      judul: 'Pemaketan dan Kualifikasi Usaha',
      fokus_uji: 'Apakah pagu paket selaras dengan batas kualifikasi usaha kecil/menengah/besar',
      bukti_minimum: 'Dokumen pemaketan, RUP, perhitungan pagu',
      indikator_patuh: 'Paket tidak memotong/memperbesar secara tidak wajar untuk menghindari klasifikasi tertentu',
      red_flag: 'Paket salah klasifikasi; indikasi pengondisian peserta',
      dasar_hukum: 'Perlem LKPP 11/2021 (pemaketan jasa konsultansi konstruksi)',
    },
    {
      area: 'perencanaan', kode: 'P06', urutan: 60,
      judul: 'Jenis dan Bentuk Kontrak',
      fokus_uji: 'Apakah jenis kontrak (lumsum/waktu penugasan/payung/berbasis kinerja) sesuai karakter pekerjaan, dan bentuk kontrak (SPK ≤ Rp100jt / surat perjanjian) sesuai nilai paket',
      bukti_minimum: 'Rancangan kontrak, memo penetapan jenis kontrak, draft SPK/surat perjanjian',
      indikator_patuh: 'Lumsum untuk output pasti; waktu penugasan untuk scope/durasi belum pasti; bentuk sesuai pagu',
      red_flag: 'Jenis kontrak tidak cocok dengan cara pembayarannya (mis: lumsum dipilih untuk pekerjaan yang durasinya belum pasti)',
      dasar_hukum: 'Perpres 46/2025 Ps. 27, 27A, 28',
    },
    {
      area: 'perencanaan', kode: 'P07', urutan: 70,
      judul: 'Uang Muka dan Penyesuaian Harga (Rencana)',
      fokus_uji: 'Apakah rancangan uang muka, jaminan uang muka, dan klausul penyesuaian harga dirancang dengan benar di kontrak',
      bukti_minimum: 'Draft kontrak, klausul pembayaran, rencana cash flow',
      indikator_patuh: 'Ada klausul jelas jika memang digunakan; penyesuaian harga hanya untuk kontrak tahun jamak > 18 bulan',
      red_flag: 'Ada uang muka tanpa rencana jaminan; kontrak multiyear > 18 bulan tanpa klausul penyesuaian harga',
      dasar_hukum: 'Perpres 46/2025 Ps. 29-37',
    },
    {
      area: 'perencanaan', kode: 'P08', urutan: 80,
      judul: 'Konsistensi Dokumen Transisi Perpres 46/2025',
      fokus_uji: 'Apakah ada konsistensi antara SPSE, dokumen pemilihan, dan naskah kontrak pada masa transisi',
      bukti_minimum: 'Screenshot SPSE, memo transisi, dokumen pemilihan, kontrak final',
      indikator_patuh: 'Bila ada mismatch aplikasi, ada penjelasan tertulis (memo transisi) yang memadai',
      red_flag: 'Tipe kontrak/metode di aplikasi berbeda dengan naskah kontrak tanpa dasar tertulis',
      dasar_hukum: 'SE Kepala LKPP No. 1 Tahun 2025',
    },

    // ===== AREA 2: PELAKSANAAN KONTRAK =====
    {
      area: 'pelaksanaan', kode: 'L01', urutan: 10,
      judul: 'Mulai Kerja dan Mobilisasi Personel',
      fokus_uji: 'Apakah pekerjaan mulai berdasarkan dokumen yang sah (SPK/SPMK) dan personel termobilisasi sesuai rencana',
      bukti_minimum: 'Kontrak final, SPK/SPMK, daftar mobilisasi personel, bukti kehadiran awal',
      indikator_patuh: 'Tanggal mulai kerja dan kehadiran personel konsisten dengan kontrak',
      red_flag: 'Personel kunci belum hadir saat kontrak jalan; "kontrak jalan hanya di atas kertas"',
      dasar_hukum: 'Perpres 46/2025 (rancangan kontrak); Perlem LKPP 12/2021',
    },
    {
      area: 'pelaksanaan', kode: 'L02', urutan: 20,
      judul: 'Personel dan Substitusi',
      fokus_uji: 'Apakah tenaga ahli yang bekerja sesuai nama, kualifikasi, dan durasi; apakah substitusi disetujui PPK secara tertulis',
      bukti_minimum: 'CV personel kontrak, log penugasan, surat persetujuan substitusi PPK',
      indikator_patuh: 'Tidak ada gap personel tanpa justifikasi; substitusi formal dengan kualifikasi setara/lebih tinggi',
      red_flag: 'Substitusi informal; kualitas personel turun tanpa persetujuan',
      dasar_hukum: 'Perlem LKPP 12/2021; UU 2/2017 (sertifikat tenaga ahli)',
    },
    {
      area: 'pelaksanaan', kode: 'L03', urutan: 30,
      judul: 'Laporan Kemajuan dan Pengawasan',
      fokus_uji: 'Apakah ada laporan pendahuluan/antara/kemajuan, catatan lapangan, dan bukti review PPK/tim teknis',
      bukti_minimum: 'Laporan bulanan/interim, buku harian, notulen rapat, korespondensi PPK',
      indikator_patuh: 'Laporan terkait langsung dengan output dan masalah lapangan; ada bukti tindak lanjut PPK',
      red_flag: 'Laporan copy-paste; tidak ada review PPK; tidak ada bukti tindak lanjut',
      dasar_hukum: 'Perlem LKPP 12/2021 (pengawasan & pelaporan kontrak)',
    },
    {
      area: 'pelaksanaan', kode: 'L04', urutan: 40,
      judul: 'Pembayaran (Sesuai Jenis Kontrak)',
      fokus_uji: 'Apakah termin dibayar sesuai klausul kontrak dan bukti realisasi: lumsum berbasis output; waktu penugasan berbasis person-month + BLNP yang dibuktikan',
      bukti_minimum: 'Invoice, BA verifikasi, bukti output (lumsum) atau timesheet + bukti BLNP (waktu penugasan), bukti pajak',
      indikator_patuh: 'Bukti pembayaran berbeda menurut jenis kontrak; lumsum tidak menerima invoice tanpa output',
      red_flag: 'Pembayaran berbasis kalender bukan berbasis keluaran/realisasi; person-month tanpa timesheet',
      dasar_hukum: 'Perpres 46/2025 Ps. 25 (pembayaran berbasis bukti); Perlem LKPP 12/2021',
    },
    {
      area: 'pelaksanaan', kode: 'L05', urutan: 50,
      judul: 'Uang Muka dan Jaminan',
      fokus_uji: 'Apakah advance, jaminan uang muka, dan penerbit jaminan sesuai ketentuan (penerbit terdaftar di OJK)',
      bukti_minimum: 'Bukti pencairan uang muka, naskah jaminan, data izin penerbit di OJK',
      indikator_patuh: 'Ada jaminan uang muka senilai uang muka; penerbit memenuhi syarat',
      red_flag: 'Ada advance tanpa jaminan; penerbit jaminan tidak memenuhi syarat OJK',
      dasar_hukum: 'Perpres 46/2025 Ps. 29-30; OJK (suretyship)',
    },
    {
      area: 'pelaksanaan', kode: 'L06', urutan: 60,
      judul: 'Penyesuaian Harga (Eskalasi)',
      fokus_uji: 'Apakah eskalasi hanya diterapkan bila kontrak tahun jamak > 18 bulan dan sudah diatur sejak awal kontrak',
      bukti_minimum: 'Klausul kontrak penyesuaian harga, perhitungan indeks, adendum',
      indikator_patuh: 'Rumus dan periode penerapan jelas; sesuai mekanisme yang diatur kontrak',
      red_flag: 'Penyesuaian harga muncul tanpa klausul awal di kontrak',
      dasar_hukum: 'Perpres 46/2025 Ps. 37 (penyesuaian harga tahun jamak > 18 bulan)',
    },
    {
      area: 'pelaksanaan', kode: 'L07', urutan: 70,
      judul: 'Adendum / Perubahan Kontrak',
      fokus_uji: 'Apakah perubahan output/waktu/biaya sah, terdokumentasi, dan tidak dipakai menutupi salah perencanaan',
      bukti_minimum: 'Adendum, memo kebutuhan perubahan, BA negosiasi, dasar perubahan',
      indikator_patuh: 'Sebab perubahan dapat ditelusuri (perubahan ruang lingkup, peristiwa kompensasi, kahar)',
      red_flag: 'Adendum dibuat terlambat (setelah masa kontrak berakhir) atau tanpa dasar faktual',
      dasar_hukum: 'Perpres 46/2025; Perlem LKPP 12/2021 (perubahan kontrak)',
    },
    {
      area: 'pelaksanaan', kode: 'L08', urutan: 80,
      judul: 'Sinkronisasi dengan Paket Konstruksi (untuk Pengawasan/MK)',
      fokus_uji: 'Untuk paket pengawasan/manajemen konstruksi, apakah jadwal dan personel konsultansi sinkron dengan paket fisik yang diawasi',
      bukti_minimum: 'Jadwal paket konstruksi, laporan lapangan, korespondensi koordinasi',
      indikator_patuh: 'Ada korelasi nyata antara obyek pengawasan dan penugasan konsultan',
      red_flag: 'Konsultan dibayar penuh ketika objek yang diawasi belum berjalan / mundur',
      dasar_hukum: 'Perlem LKPP 12/2021 (pengawasan kontrak); UU 2/2017 (jasa konstruksi)',
    },

    // ===== AREA 3: PELAPORAN DAN PENYELESAIAN =====
    {
      area: 'pelaporan', kode: 'R01', urutan: 10,
      judul: 'Permintaan Serah Terima dari Penyedia',
      fokus_uji: 'Apakah penyedia mengajukan serah terima secara tertulis setelah menyatakan pekerjaan 100%',
      bukti_minimum: 'Surat permintaan serah terima (tertulis dari penyedia)',
      indikator_patuh: 'Ada urutan dokumen yang benar: surat penyedia → pemeriksaan PPK → BAST',
      red_flag: 'BAST muncul tanpa surat permintaan serah terima',
      dasar_hukum: 'Perpres 46/2025 Ps. 57 (mekanisme serah terima)',
    },
    {
      area: 'pelaporan', kode: 'R02', urutan: 20,
      judul: 'Pemeriksaan Hasil oleh PPK',
      fokus_uji: 'Apakah PPK/tim teknis memeriksa kesesuaian keluaran dengan kontrak dan KAK secara substantif (bukan sekadar formal)',
      bukti_minimum: 'Lembar pemeriksaan, catatan review, paraf tim teknis, dokumentasi pemeriksaan',
      indikator_patuh: 'Ada bukti pemeriksaan substantif terhadap keluaran',
      red_flag: 'Pemeriksaan hanya berupa tanda tangan formal tanpa cek substansi',
      dasar_hukum: 'Perpres 46/2025 Ps. 57; Perlem LKPP 12/2021',
    },
    {
      area: 'pelaporan', kode: 'R03', urutan: 30,
      judul: 'Laporan Akhir dan Deliverables',
      fokus_uji: 'Apakah semua keluaran final sesuai KAK/kontrak dan dapat dimanfaatkan; benang merah laporan pendahuluan-antara-akhir',
      bukti_minimum: 'Laporan akhir, lampiran teknis, source file, daftar dokumen final',
      indikator_patuh: 'Semua output contractual tercatat dan diserahkan; konsistensi antar bagian laporan',
      red_flag: 'Laporan akhir ada tetapi deliverables teknis tidak lengkap; source file tidak diserahkan',
      dasar_hukum: 'Perpres 46/2025 Ps. 57; KAK & kontrak',
    },
    {
      area: 'pelaporan', kode: 'R04', urutan: 40,
      judul: 'Berita Acara Serah Terima (BAST)',
      fokus_uji: 'Apakah BAST ditandatangani setelah pemeriksaan selesai dan mencerminkan output yang benar-benar diterima',
      bukti_minimum: 'BAST, daftar barang/jasa/dokumen yang diserahterimakan',
      indikator_patuh: 'Tanggal dan isi BAST konsisten dengan hasil pemeriksaan substantif',
      red_flag: 'BAST ditandatangani terlalu dini (sebelum revisi final selesai)',
      dasar_hukum: 'Perpres 46/2025 Ps. 57',
    },
    {
      area: 'pelaporan', kode: 'R05', urutan: 50,
      judul: 'Penyerahan ke PA/KPA',
      fokus_uji: 'Apakah hasil pekerjaan diserahkan dari PPK ke PA/KPA bila relevan, lengkap dengan berita acara internal',
      bukti_minimum: 'Berita acara penyerahan internal (PPK → PA/KPA)',
      indikator_patuh: 'Ada alur penyerahan internal yang lengkap',
      red_flag: 'Hasil kontrak berhenti di PPK tanpa disposisi lebih lanjut',
      dasar_hukum: 'Perpres 46/2025 Ps. 58',
    },
    {
      area: 'pelaporan', kode: 'R06', urutan: 60,
      judul: 'Rekonsiliasi Keuangan',
      fokus_uji: 'Apakah pembayaran akhir, uang muka, pajak, dan biaya non-personel telah direkonsiliasi sebelum penutupan kontrak',
      bukti_minimum: 'Rekap pembayaran, bukti potong/pajak, rekonsiliasi advance, pelepasan jaminan',
      indikator_patuh: 'Tidak ada saldo tergantung atau pembayaran tanpa dasar',
      red_flag: 'Overpayment tersisa; advance tidak dilunasi; jaminan tidak dilepas',
      dasar_hukum: 'Perpres 46/2025; PMK terkait pembayaran',
    },
    {
      area: 'pelaporan', kode: 'R07', urutan: 70,
      judul: 'Penilaian Kinerja Penyedia',
      fokus_uji: 'Apakah kinerja penyedia dinilai dan diarsipkan (via SIKaP atau manual pada masa transisi)',
      bukti_minimum: 'Form/rekam penilaian kinerja, bukti input sistem atau form manual',
      indikator_patuh: 'Penilaian dilakukan tepat setelah penutupan dan masuk basis data',
      red_flag: 'Tidak ada evaluasi kinerja; data kinerja hilang dari basis pengadaan berikutnya',
      dasar_hukum: 'Perlem LKPP 12/2021 (penilaian kinerja); SE LKPP 1/2025 (transisi)',
    },
    {
      area: 'pelaporan', kode: 'R08', urutan: 80,
      judul: 'Arsip Akhir Kontrak',
      fokus_uji: 'Apakah file kontrak lengkap untuk audit trail (fisik dan digital, indeks jelas)',
      bukti_minimum: 'Daftar arsip fisik/digital, indeks file, struktur folder',
      indikator_patuh: 'Semua dokumen kunci terlacak cepat; versi final jelas',
      red_flag: 'File tercecer; versi final tidak jelas; dokumen kunci hilang',
      dasar_hukum: 'Perlem LKPP 12/2021; UU Kearsipan 43/2009',
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO audit_checklist_item(area, kode, judul, fokus_uji, bukti_minimum, indikator_patuh, red_flag, dasar_hukum, urutan, aktif)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(kode) DO UPDATE SET
      judul = excluded.judul, fokus_uji = excluded.fokus_uji, bukti_minimum = excluded.bukti_minimum,
      indikator_patuh = excluded.indikator_patuh, red_flag = excluded.red_flag,
      dasar_hukum = excluded.dasar_hukum, urutan = excluded.urutan
  `);
  for (const it of items) {
    stmt.run(it.area, it.kode, it.judul, it.fokus_uji, it.bukti_minimum, it.indikator_patuh, it.red_flag, it.dasar_hukum, it.urutan);
  }
}

let _db = null;
function getDb() {
  if (!_db) _db = initDb();
  return _db;
}

module.exports = { initDb, getDb, DB_PATH, DATA_DIR };
