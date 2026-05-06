const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { getDb } = require('../db/schema');
const { ensureAdmin, getActiveSuratTugasId, generateKodeAkses, logAudit } = require('../lib/helpers');
const { parseSp2dRows, groupBySp2d } = require('../lib/excel-parser');
const { recomputeNilaiPaket } = require('../lib/paket-helpers');

const router = express.Router();

const { DATA_DIR } = require('../db/schema');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ts = Date.now();
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${ts}_${safe}`);
    },
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// === Upload SP2D Excel (admin) ===
router.post('/sp2d', ensureAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });

  let workbook;
  try {
    workbook = xlsx.readFile(req.file.path, { cellDates: true });
  } catch (e) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'File tidak bisa dibaca: ' + e.message });
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });
  const { error: parseErr, parsed, errors: parseErrors, detected_map, detected_headers } = parseSp2dRows(rows);
  if (parseErr) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: parseErr, detected_headers, detected_map });
  }

  const db = getDb();
  // Cek surat tugas aktif (wajib untuk upload)
  const stId = getActiveSuratTugasId(req);
  if (!stId) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Pilih Surat Tugas aktif dulu sebelum upload SP2D. (Super admin: pakai workspace switcher di topbar)' });
  }

  const insertOpd = db.prepare('INSERT INTO opd(nama) VALUES (?)');
  const findOpd = db.prepare('SELECT id FROM opd WHERE LOWER(nama) = LOWER(?)');
  const findOpdAudit = db.prepare('SELECT kode_akses FROM opd_audit WHERE opd_id = ? AND surat_tugas_id = ?');
  const insertOpdAudit = db.prepare('INSERT INTO opd_audit(opd_id, surat_tugas_id, kode_akses) VALUES (?, ?, ?)');
  const insertPaket = db.prepare(`
    INSERT INTO paket(
      opd_id, surat_tugas_id, nomor_paket, nama_pekerjaan, tahun_anggaran,
      jenis_konsultansi, bentuk_badan, nama_penyedia
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSp2d = db.prepare(`
    INSERT INTO paket_sp2d(
      paket_id, no_sp2d, tanggal_sp2d, nilai_sp2d, nilai_realisasi,
      jenis_akun, nama_rekening, nama_penerima, keterangan
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const checkSp2d = db.prepare('SELECT id FROM paket_sp2d WHERE no_sp2d = ?');
  const findPaketByNomor = db.prepare('SELECT id FROM paket WHERE opd_id = ? AND nomor_paket = ?');

  const summary = {
    opd_baru: [], paket_baru: 0, sp2d_baru: 0, dilewat: [], error: [...parseErrors],
    skip_non_konstruksi: 0, jenis_breakdown: {},
  };

  // Group by (opd, nomor_paket)
  const groups = groupBySp2d(parsed);

  const tx = db.transaction(() => {
    for (const g of groups) {
      // Skip group kalau jenis_konsultansi = non_konstruksi
      if (g.jenis_konsultansi === 'non_konstruksi') {
        summary.skip_non_konstruksi += g.sp2d.length;
        for (const s of g.sp2d) {
          summary.dilewat.push({ baris: s.baris, no_sp2d: s.no_sp2d, alasan: 'Jasa Konsultansi Non Konstruksi (di luar scope)' });
        }
        continue;
      }

      // Filter SP2D yang sudah ada (duplikat)
      const newSp2d = [];
      for (const s of g.sp2d) {
        if (checkSp2d.get(s.no_sp2d)) {
          summary.dilewat.push({ baris: s.baris, no_sp2d: s.no_sp2d, alasan: 'duplikat no SP2D' });
        } else {
          newSp2d.push(s);
        }
      }
      if (newSp2d.length === 0) continue;

      // Cari/buat OPD entity (shared)
      let opd = findOpd.get(g.nama_opd);
      if (!opd) {
        const result = insertOpd.run(g.nama_opd);
        opd = { id: result.lastInsertRowid };
      }
      // Cari/buat opd_audit (per OPD × surat_tugas)
      let opdAudit = findOpdAudit.get(opd.id, stId);
      if (!opdAudit) {
        const kode = generateKodeAkses();
        insertOpdAudit.run(opd.id, stId, kode);
        opdAudit = { kode_akses: kode };
        summary.opd_baru.push({ id: opd.id, nama: g.nama_opd, kode_akses: kode });
      }

      // Cari paket existing pakai nomor_paket (kalau ada) — biar SP2D dari upload kedua join ke paket yang sama
      let paketId;
      if (g.nomor_paket) {
        const existing = findPaketByNomor.get(opd.id, g.nomor_paket);
        if (existing) paketId = existing.id;
      }
      if (!paketId) {
        const result = insertPaket.run(
          opd.id, stId, g.nomor_paket, g.nama_pekerjaan, g.tahun_anggaran,
          g.jenis_konsultansi, g.bentuk_badan, g.nama_penyedia
        );
        paketId = result.lastInsertRowid;
        summary.paket_baru += 1;
        const jk = g.jenis_konsultansi || 'belum_diset';
        summary.jenis_breakdown[jk] = (summary.jenis_breakdown[jk] || 0) + 1;
      }

      // Insert tiap SP2D
      for (const s of newSp2d) {
        insertSp2d.run(
          paketId, s.no_sp2d, s.tanggal_sp2d, s.nilai_sp2d, s.nilai_realisasi,
          s.jenis_akun, s.nama_rekening, s.nama_penerima, s.keterangan
        );
        summary.sp2d_baru += 1;
      }
      recomputeNilaiPaket(db, paketId);
    }
  });

  try {
    tx();
  } catch (e) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: 'Gagal import: ' + e.message });
  }

  // simpan file SP2D ke folder uploads (sebagai bukti, jangan dihapus)
  logAudit('admin', 'upload_sp2d', null, null, {
    filename: req.file.filename,
    paket_baru: summary.paket_baru,
    opd_baru: summary.opd_baru.length,
  });

  res.json({ ok: true, summary });
});

// === Bukti kehadiran (admin upload, attached ke tenaga_ahli_aktual) ===
router.post('/bukti-kehadiran/:taAktualId', ensureAdmin, upload.array('files', 10), (req, res) => {
  const db = getDb();
  const taAktual = db.prepare('SELECT id FROM tenaga_ahli_aktual WHERE id = ?').get(req.params.taAktualId);
  if (!taAktual) {
    req.files.forEach(f => fs.unlinkSync(f.path));
    return res.status(404).json({ error: 'TA aktual tidak ditemukan' });
  }
  const stmt = db.prepare(`
    INSERT INTO bukti_kehadiran(tenaga_ahli_aktual_id, filename, original_name, mime_type)
    VALUES (?, ?, ?, ?)
  `);
  const inserted = req.files.map(f => {
    const result = stmt.run(req.params.taAktualId, f.filename, f.originalname, f.mimetype);
    return { id: result.lastInsertRowid, filename: f.filename, original_name: f.originalname };
  });
  res.json({ ok: true, files: inserted });
});

// === Bukti non-personel ===
router.post('/bukti-non-personel/:verifikasiId', ensureAdmin, upload.array('files', 10), (req, res) => {
  const db = getDb();
  const verif = db.prepare('SELECT id FROM verifikasi_non_personel WHERE id = ?').get(req.params.verifikasiId);
  if (!verif) {
    req.files.forEach(f => fs.unlinkSync(f.path));
    return res.status(404).json({ error: 'Verifikasi tidak ditemukan' });
  }
  const stmt = db.prepare(`
    INSERT INTO bukti_non_personel(verifikasi_id, filename, original_name)
    VALUES (?, ?, ?)
  `);
  const inserted = req.files.map(f => {
    const result = stmt.run(req.params.verifikasiId, f.filename, f.originalname);
    return { id: result.lastInsertRowid, filename: f.filename };
  });
  res.json({ ok: true, files: inserted });
});

// === Generate dummy data untuk testing ===
router.post('/seed-dummy', ensureAdmin, (req, res) => {
  const seedDummy = require('../db/seed-dummy');
  const result = seedDummy();
  res.json({ ok: true, ...result });
});

module.exports = router;
