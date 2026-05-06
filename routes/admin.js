const express = require('express');
const { getDb } = require('../db/schema');
const { ensureAdmin, ensureSuperAdmin, getActiveSuratTugasId, generateKodeAkses, logAudit, getSetting, setSetting } = require('../lib/helpers');
const bcrypt = require('bcryptjs');

const router = express.Router();
router.use(ensureAdmin);

// === DASHBOARD ===
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const stId = getActiveSuratTugasId(req);
  // Build SQL fragment: filter by active surat tugas (kalau ada)
  const stFilter = stId ? 'AND p.surat_tugas_id = ?' : '';
  const stParam = stId ? [stId] : [];

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT p.opd_id) FROM paket p WHERE 1=1 ${stFilter}) AS total_opd,
      (SELECT COUNT(*) FROM paket p WHERE 1=1 ${stFilter}) AS total_paket,
      (SELECT COALESCE(SUM(p.nilai_paket),0) FROM paket p WHERE 1=1 ${stFilter}) AS total_nilai,
      (SELECT COUNT(*) FROM paket p WHERE p.status='terkunci' ${stFilter}) AS total_audited,
      (SELECT COALESCE(SUM(t.selisih),0) FROM temuan t JOIN paket p ON p.id = t.paket_id WHERE 1=1 ${stFilter}) AS total_pengembalian
  `).get(...stParam, ...stParam, ...stParam, ...stParam, ...stParam);

  // OPD list (hanya yang ada paket di audit aktif)
  const opdList = db.prepare(`
    SELECT o.id, o.nama,
      (SELECT oa.kode_akses FROM opd_audit oa WHERE oa.opd_id = o.id ${stId ? 'AND oa.surat_tugas_id = ?' : ''} LIMIT 1) AS kode_akses,
      (SELECT COUNT(*) FROM paket p WHERE p.opd_id = o.id ${stFilter}) AS jml_paket,
      (SELECT COUNT(*) FROM paket p WHERE p.opd_id = o.id AND p.status IN ('lengkap','terkunci') ${stFilter}) AS jml_lengkap,
      (SELECT COUNT(*) FROM paket p WHERE p.opd_id = o.id AND p.status = 'terkunci' ${stFilter}) AS jml_terkunci,
      (SELECT COALESCE(SUM(nilai_paket),0) FROM paket p WHERE p.opd_id = o.id ${stFilter}) AS total_nilai_paket,
      (SELECT COALESCE(SUM(t.selisih),0) FROM temuan t JOIN paket p ON p.id = t.paket_id WHERE p.opd_id = o.id ${stFilter}) AS total_temuan
    FROM opd o
    WHERE EXISTS(SELECT 1 FROM paket p WHERE p.opd_id = o.id ${stFilter})
    ORDER BY o.nama
  `).all(...(stId ? [stId] : []), ...stParam, ...stParam, ...stParam, ...stParam, ...stParam, ...stParam);

  // Surat tugas info (kalau ada filter aktif)
  let activeSuratTugas = null;
  if (stId) {
    activeSuratTugas = db.prepare('SELECT id, nomor, tanggal, bpk_perwakilan, nama_pemeriksaan, entitas_diperiksa, status FROM surat_tugas WHERE id = ?').get(stId);
  }

  res.json({ totals, opd: opdList, active_surat_tugas: activeSuratTugas });
});

// Switcher (super admin only)
router.post('/switch-audit', (req, res) => {
  if (req.session.role !== 'super_admin') {
    return res.status(403).json({ error: 'Hanya super admin yang bisa pindah audit' });
  }
  const { surat_tugas_id } = req.body;
  if (surat_tugas_id == null || surat_tugas_id === '') {
    req.session.activeSuratTugasId = null;
  } else {
    const db = getDb();
    const exists = db.prepare('SELECT id FROM surat_tugas WHERE id = ?').get(surat_tugas_id);
    if (!exists) return res.status(404).json({ error: 'Surat tugas tidak ditemukan' });
    req.session.activeSuratTugasId = parseInt(surat_tugas_id, 10);
  }
  res.json({ ok: true, active_surat_tugas_id: req.session.activeSuratTugasId });
});

// Get current active audit info (untuk topbar display)
router.get('/active-audit', (req, res) => {
  const stId = getActiveSuratTugasId(req);
  if (!stId) return res.json({ active: null, role: req.session.role });
  const db = getDb();
  const surat = db.prepare('SELECT id, nomor, tanggal, bpk_perwakilan, nama_pemeriksaan, entitas_diperiksa, status FROM surat_tugas WHERE id = ?').get(stId);
  res.json({ active: surat, role: req.session.role });
});

// === OPD MANAGEMENT ===
router.get('/opd', (req, res) => {
  const db = getDb();
  const list = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM paket p WHERE p.opd_id = o.id) AS jml_paket
    FROM opd o ORDER BY o.nama
  `).all();
  res.json(list);
});

router.get('/opd/:id', (req, res) => {
  const db = getDb();
  const opd = db.prepare('SELECT * FROM opd WHERE id = ?').get(req.params.id);
  if (!opd) return res.status(404).json({ error: 'OPD tidak ditemukan' });
  const stId = getActiveSuratTugasId(req);

  // Kode akses untuk audit aktif
  if (stId) {
    const oa = db.prepare('SELECT kode_akses FROM opd_audit WHERE opd_id = ? AND surat_tugas_id = ?').get(req.params.id, stId);
    opd.kode_akses = oa?.kode_akses || null;
  }

  const stFilter = stId ? 'AND p.surat_tugas_id = ?' : '';
  const stParam = stId ? [stId] : [];

  const pakets = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM tenaga_ahli_kontrak WHERE paket_id = p.id) AS jml_ta,
      (SELECT COUNT(*) FROM paket_sp2d WHERE paket_id = p.id) AS jml_sp2d,
      (SELECT MIN(tanggal_sp2d) FROM paket_sp2d WHERE paket_id = p.id) AS tanggal_sp2d_pertama,
      (SELECT COALESCE(SUM(selisih),0) FROM temuan WHERE paket_id = p.id) AS total_temuan
    FROM paket p
    WHERE p.opd_id = ? ${stFilter}
    ORDER BY (SELECT MIN(tanggal_sp2d) FROM paket_sp2d WHERE paket_id = p.id) DESC, p.nama_pekerjaan
  `).all(req.params.id, ...stParam);

  res.json({ opd, paket: pakets });
});

router.post('/opd', (req, res) => {
  const { nama } = req.body;
  if (!nama) return res.status(400).json({ error: 'Nama OPD wajib' });
  const db = getDb();
  const exists = db.prepare('SELECT id FROM opd WHERE LOWER(nama) = LOWER(?)').get(nama.trim());
  if (exists) return res.status(409).json({ error: 'OPD sudah ada' });
  const kode = generateKodeAkses();
  const result = db.prepare('INSERT INTO opd(nama, kode_akses) VALUES (?, ?)').run(nama.trim(), kode);
  logAudit('admin', 'create_opd', 'opd', result.lastInsertRowid, { nama });
  res.json({ id: result.lastInsertRowid, nama: nama.trim(), kode_akses: kode });
});

router.post('/opd/:id/regenerate-kode', (req, res) => {
  const db = getDb();
  const kode = generateKodeAkses();
  const result = db.prepare('UPDATE opd SET kode_akses = ? WHERE id = ?').run(kode, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'OPD tidak ditemukan' });
  logAudit('admin', 'regenerate_kode_akses', 'opd', req.params.id);
  res.json({ kode_akses: kode });
});

router.delete('/opd/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM opd WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'OPD tidak ditemukan' });
  logAudit('admin', 'delete_opd', 'opd', req.params.id);
  res.json({ ok: true });
});

// === PAKET DETAIL (admin view) ===
router.get('/paket/:id', (req, res) => {
  const db = getDb();
  const paket = db.prepare(`
    SELECT p.*, o.nama AS opd_nama
    FROM paket p
    JOIN opd o ON o.id = p.opd_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

  const sp2d = db.prepare('SELECT * FROM paket_sp2d WHERE paket_id = ? ORDER BY tanggal_sp2d, no_sp2d').all(req.params.id);
  const ta_kontrak = db.prepare('SELECT * FROM tenaga_ahli_kontrak WHERE paket_id = ?').all(req.params.id);
  const biaya_personel = db.prepare('SELECT * FROM biaya_personel WHERE paket_id = ?').all(req.params.id);
  const biaya_non_personel = db.prepare('SELECT * FROM biaya_non_personel WHERE paket_id = ?').all(req.params.id);
  const ta_aktual = db.prepare('SELECT * FROM tenaga_ahli_aktual WHERE paket_id = ?').all(req.params.id);
  const verif_np = db.prepare(`
    SELECT v.* FROM verifikasi_non_personel v
    JOIN biaya_non_personel b ON b.id = v.biaya_non_personel_id
    WHERE b.paket_id = ?
  `).all(req.params.id);
  const temuan = db.prepare('SELECT * FROM temuan WHERE paket_id = ? ORDER BY jenis, skenario').all(req.params.id);

  res.json({ paket, sp2d, ta_kontrak, biaya_personel, biaya_non_personel, ta_aktual, verif_np, temuan });
});

// === SP2D MANAGEMENT (gabung & pisah) ===
const { recomputeNilaiPaket } = require('../lib/paket-helpers');

// Pisah SP2D dari paket → jadi paket baru sendiri
router.post('/sp2d/:sp2dId/split', (req, res) => {
  const db = getDb();
  const sp2d = db.prepare('SELECT s.*, p.opd_id, p.tahun_anggaran, p.jenis_konsultansi, p.nama_pekerjaan AS old_pekerjaan FROM paket_sp2d s JOIN paket p ON p.id = s.paket_id WHERE s.id = ?').get(req.params.sp2dId);
  if (!sp2d) return res.status(404).json({ error: 'SP2D tidak ditemukan' });

  const tx = db.transaction(() => {
    // Buat paket baru
    const r = db.prepare(`
      INSERT INTO paket(opd_id, nama_pekerjaan, tahun_anggaran, jenis_konsultansi)
      VALUES (?, ?, ?, ?)
    `).run(sp2d.opd_id, sp2d.keterangan || sp2d.old_pekerjaan, sp2d.tahun_anggaran, sp2d.jenis_konsultansi);
    const newPaketId = r.lastInsertRowid;
    // Pindahkan SP2D
    db.prepare('UPDATE paket_sp2d SET paket_id = ? WHERE id = ?').run(newPaketId, sp2d.id);
    // Recompute nilai untuk kedua paket
    recomputeNilaiPaket(db, sp2d.paket_id);
    recomputeNilaiPaket(db, newPaketId);
    return newPaketId;
  });
  const newPaketId = tx();
  logAudit('admin', 'split_sp2d', 'paket_sp2d', req.params.sp2dId, { from_paket: sp2d.paket_id, to_paket: newPaketId });
  res.json({ ok: true, new_paket_id: newPaketId });
});

// Gabung paket lain ke paket ini (semua SP2D dari source dipindah ke target, source paket dihapus)
router.post('/paket/:id/merge-from/:sourceId', (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT * FROM paket WHERE id = ?').get(req.params.id);
  const source = db.prepare('SELECT * FROM paket WHERE id = ?').get(req.params.sourceId);
  if (!target || !source) return res.status(404).json({ error: 'Paket tidak ditemukan' });
  if (target.id === source.id) return res.status(400).json({ error: 'Tidak bisa merge dengan diri sendiri' });
  if (target.opd_id !== source.opd_id) return res.status(400).json({ error: 'Paket harus dari OPD yang sama' });
  if (target.status === 'terkunci' || source.status === 'terkunci') return res.status(400).json({ error: 'Tidak bisa merge paket yang sudah terkunci' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE paket_sp2d SET paket_id = ? WHERE paket_id = ?').run(target.id, source.id);
    db.prepare('DELETE FROM paket WHERE id = ?').run(source.id);
    recomputeNilaiPaket(db, target.id);
  });
  tx();
  logAudit('admin', 'merge_paket', 'paket', target.id, { from_paket: source.id });
  res.json({ ok: true });
});

// Bulk merge: gabung multiple paket jadi 1 (target = first paket, sources = rest)
router.post('/paket/bulk-merge', (req, res) => {
  const { target_id, source_ids, nama_pekerjaan } = req.body;
  if (!target_id || !Array.isArray(source_ids) || source_ids.length === 0) {
    return res.status(400).json({ error: 'target_id dan source_ids wajib' });
  }
  const db = getDb();
  const target = db.prepare('SELECT * FROM paket WHERE id = ?').get(target_id);
  if (!target) return res.status(404).json({ error: 'Paket target tidak ditemukan' });
  if (target.status === 'terkunci') return res.status(400).json({ error: 'Paket target sudah terkunci' });

  const sources = db.prepare(`SELECT * FROM paket WHERE id IN (${source_ids.map(() => '?').join(',')})`).all(...source_ids);
  for (const s of sources) {
    if (s.opd_id !== target.opd_id) return res.status(400).json({ error: `Paket ${s.id} beda OPD dengan target` });
    if (s.status === 'terkunci') return res.status(400).json({ error: `Paket ${s.id} sudah terkunci, tidak bisa di-merge` });
    if (s.id === target.id) return res.status(400).json({ error: 'Source tidak boleh sama dengan target' });
  }

  const tx = db.transaction(() => {
    for (const s of sources) {
      db.prepare('UPDATE paket_sp2d SET paket_id = ? WHERE paket_id = ?').run(target.id, s.id);
      db.prepare('DELETE FROM paket WHERE id = ?').run(s.id);
    }
    if (nama_pekerjaan) {
      db.prepare('UPDATE paket SET nama_pekerjaan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(String(nama_pekerjaan).toUpperCase(), target.id);
    }
    recomputeNilaiPaket(db, target.id);
  });
  tx();
  logAudit('admin', 'bulk_merge_paket', 'paket', target.id, { sources: source_ids, count: sources.length });
  res.json({ ok: true, merged_count: sources.length });
});

// List paket lain di OPD yang sama (untuk dropdown merge)
router.get('/paket/:id/mergeable', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT opd_id FROM paket WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const list = db.prepare(`
    SELECT p.id, p.nama_pekerjaan, p.nilai_paket, p.nomor_paket, p.status,
      (SELECT COUNT(*) FROM paket_sp2d WHERE paket_id = p.id) AS jml_sp2d
    FROM paket p
    WHERE p.opd_id = ? AND p.id != ? AND p.status != 'terkunci'
    ORDER BY p.nama_pekerjaan
  `).all(cur.opd_id, req.params.id);
  res.json(list);
});

// Update nama paket (admin override) + nomor_paket
router.put('/paket/:id/info', (req, res) => {
  const db = getDb();
  const { nama_pekerjaan, nomor_paket } = req.body;
  db.prepare(`UPDATE paket SET nama_pekerjaan = COALESCE(?, nama_pekerjaan), nomor_paket = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(nama_pekerjaan ? String(nama_pekerjaan).toUpperCase() : null, nomor_paket || null, req.params.id);
  res.json({ ok: true });
});

// === ADMIN OVERRIDE: Edit data kontrak yang biasanya diisi OPD ===
// Admin bisa benerin kalau OPD salah input
const upr = (s) => s == null || s === '' ? null : String(s).toUpperCase();

router.put('/paket/:id/kontrak', (req, res) => {
  const db = getDb();
  const f = req.body;
  db.prepare(`
    UPDATE paket SET
      no_kontrak = ?, tanggal_kontrak = ?, tanggal_mulai = ?, tanggal_selesai = ?,
      bentuk_badan = ?, nama_penyedia = ?,
      ppk_nama = ?, ppk_nip = ?, pptk_nama = ?, pptk_nip = ?,
      jenis_kontrak = ?, jenis_konsultansi = ?, output_diharapkan = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    upr(f.no_kontrak), f.tanggal_kontrak || null, f.tanggal_mulai || null, f.tanggal_selesai || null,
    f.bentuk_badan || null, upr(f.nama_penyedia),
    upr(f.ppk_nama), f.ppk_nip || null, upr(f.pptk_nama), f.pptk_nip || null,
    f.jenis_kontrak || null, f.jenis_konsultansi || null, upr(f.output_diharapkan),
    req.params.id
  );
  logAudit('admin', 'edit_kontrak_opd', 'paket', req.params.id);
  res.json({ ok: true });
});

// CRUD Tenaga Ahli Kontrak (admin override)
router.post('/paket/:id/tenaga-ahli-kontrak', (req, res) => {
  const db = getDb();
  const { nama, nik, jabatan } = req.body;
  if (!nama || !nik || !jabatan) {
    return res.status(400).json({ error: 'Nama, NIK, dan Jabatan wajib diisi' });
  }
  const result = db.prepare(`
    INSERT INTO tenaga_ahli_kontrak(paket_id, nama, nik, jabatan)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, upr(nama), String(nik).trim(), upr(jabatan));
  logAudit('admin', 'add_ta_kontrak', 'paket', req.params.id);
  res.json({ id: result.lastInsertRowid });
});

router.put('/tenaga-ahli-kontrak/:taId', (req, res) => {
  const db = getDb();
  const { nama, nik, jabatan } = req.body;
  db.prepare(`UPDATE tenaga_ahli_kontrak SET nama=?, nik=?, jabatan=? WHERE id = ?`)
    .run(upr(nama), String(nik || '').trim(), upr(jabatan), req.params.taId);
  res.json({ ok: true });
});

router.delete('/tenaga-ahli-kontrak/:taId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tenaga_ahli_kontrak WHERE id = ?').run(req.params.taId);
  res.json({ ok: true });
});

// === BIAYA PERSONEL (admin input) ===
router.post('/paket/:id/biaya-personel', (req, res) => {
  const db = getDb();
  const { jabatan, jenjang_disyaratkan, bidang, mm, tarif_per_bulan, tenaga_ahli_kontrak_id } = req.body;
  if (!jabatan || mm == null || tarif_per_bulan == null) {
    return res.status(400).json({ error: 'jabatan, mm, tarif_per_bulan wajib' });
  }
  const result = db.prepare(`
    INSERT INTO biaya_personel(paket_id, tenaga_ahli_kontrak_id, jabatan, jenjang_disyaratkan, bidang, mm, tarif_per_bulan)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, tenaga_ahli_kontrak_id || null, jabatan, jenjang_disyaratkan || null, bidang || null, parseFloat(mm), parseFloat(tarif_per_bulan));
  res.json({ id: result.lastInsertRowid });
});

router.put('/biaya-personel/:id', (req, res) => {
  const db = getDb();
  const { jabatan, jenjang_disyaratkan, bidang, mm, tarif_per_bulan, tenaga_ahli_kontrak_id } = req.body;
  db.prepare(`
    UPDATE biaya_personel
    SET jabatan = ?, jenjang_disyaratkan = ?, bidang = ?, mm = ?, tarif_per_bulan = ?, tenaga_ahli_kontrak_id = ?
    WHERE id = ?
  `).run(jabatan, jenjang_disyaratkan || null, bidang || null, parseFloat(mm), parseFloat(tarif_per_bulan), tenaga_ahli_kontrak_id || null, req.params.id);
  res.json({ ok: true });
});

router.delete('/biaya-personel/:id', (req, res) => {
  getDb().prepare('DELETE FROM biaya_personel WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// === BIAYA NON-PERSONEL ===
router.post('/paket/:id/biaya-non-personel', (req, res) => {
  const db = getDb();
  const { kategori, uraian, volume, satuan, harga_satuan } = req.body;
  if (!uraian || volume == null || harga_satuan == null) {
    return res.status(400).json({ error: 'uraian, volume, harga_satuan wajib' });
  }
  const result = db.prepare(`
    INSERT INTO biaya_non_personel(paket_id, kategori, uraian, volume, satuan, harga_satuan)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, kategori || null, uraian, parseFloat(volume), satuan || null, parseFloat(harga_satuan));
  res.json({ id: result.lastInsertRowid });
});

router.put('/biaya-non-personel/:id', (req, res) => {
  const db = getDb();
  const { kategori, uraian, volume, satuan, harga_satuan } = req.body;
  db.prepare(`
    UPDATE biaya_non_personel
    SET kategori = ?, uraian = ?, volume = ?, satuan = ?, harga_satuan = ?
    WHERE id = ?
  `).run(kategori || null, uraian, parseFloat(volume), satuan || null, parseFloat(harga_satuan), req.params.id);
  res.json({ ok: true });
});

router.delete('/biaya-non-personel/:id', (req, res) => {
  getDb().prepare('DELETE FROM biaya_non_personel WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// === TENAGA AHLI AKTUAL (verifikasi lapangan) ===
router.post('/paket/:id/tenaga-ahli-aktual', (req, res) => {
  const db = getDb();
  const f = req.body;
  if (!f.status) return res.status(400).json({ error: 'status wajib' });
  const result = db.prepare(`
    INSERT INTO tenaga_ahli_aktual(
      paket_id, biaya_personel_id, status, nama, nik, jabatan,
      pendidikan_jenjang, pendidikan_jurusan,
      no_ska, jenjang_ska, klasifikasi_ska, masa_berlaku_ska,
      no_skk, jenjang_skk, no_skt,
      hari_kerja_aktual, catatan_wawancara, narasumber, tanggal_wawancara, jenjang_efektif
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id, f.biaya_personel_id || null, f.status, f.nama || null, f.nik || null, f.jabatan || null,
    f.pendidikan_jenjang || null, f.pendidikan_jurusan || null,
    f.no_ska || null, f.jenjang_ska || null, f.klasifikasi_ska || null, f.masa_berlaku_ska || null,
    f.no_skk || null, f.jenjang_skk || null, f.no_skt || null,
    f.hari_kerja_aktual != null ? parseInt(f.hari_kerja_aktual, 10) : null,
    f.catatan_wawancara || null, f.narasumber || null, f.tanggal_wawancara || null, f.jenjang_efektif || null
  );
  res.json({ id: result.lastInsertRowid });
});

router.put('/tenaga-ahli-aktual/:id', (req, res) => {
  const db = getDb();
  const f = req.body;
  db.prepare(`
    UPDATE tenaga_ahli_aktual SET
      biaya_personel_id = ?, status = ?, nama = ?, nik = ?, jabatan = ?,
      pendidikan_jenjang = ?, pendidikan_jurusan = ?,
      no_ska = ?, jenjang_ska = ?, klasifikasi_ska = ?, masa_berlaku_ska = ?,
      no_skk = ?, jenjang_skk = ?, no_skt = ?,
      hari_kerja_aktual = ?, catatan_wawancara = ?, narasumber = ?, tanggal_wawancara = ?, jenjang_efektif = ?
    WHERE id = ?
  `).run(
    f.biaya_personel_id || null, f.status, f.nama || null, f.nik || null, f.jabatan || null,
    f.pendidikan_jenjang || null, f.pendidikan_jurusan || null,
    f.no_ska || null, f.jenjang_ska || null, f.klasifikasi_ska || null, f.masa_berlaku_ska || null,
    f.no_skk || null, f.jenjang_skk || null, f.no_skt || null,
    f.hari_kerja_aktual != null ? parseInt(f.hari_kerja_aktual, 10) : null,
    f.catatan_wawancara || null, f.narasumber || null, f.tanggal_wawancara || null, f.jenjang_efektif || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/tenaga-ahli-aktual/:id', (req, res) => {
  getDb().prepare('DELETE FROM tenaga_ahli_aktual WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// === VERIFIKASI NON-PERSONEL ===
router.post('/biaya-non-personel/:id/verifikasi', (req, res) => {
  const db = getDb();
  const { status_realisasi, volume_aktual, harga_bukti_sah, catatan, catatan_pajak } = req.body;
  if (!status_realisasi) return res.status(400).json({ error: 'status_realisasi wajib' });
  const result = db.prepare(`
    INSERT INTO verifikasi_non_personel(biaya_non_personel_id, status_realisasi, volume_aktual, harga_bukti_sah, catatan, catatan_pajak)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(biaya_non_personel_id) DO UPDATE SET
      status_realisasi = excluded.status_realisasi,
      volume_aktual = excluded.volume_aktual,
      harga_bukti_sah = excluded.harga_bukti_sah,
      catatan = excluded.catatan,
      catatan_pajak = excluded.catatan_pajak
  `).run(
    req.params.id, status_realisasi,
    volume_aktual != null ? parseFloat(volume_aktual) : null,
    harga_bukti_sah != null ? parseFloat(harga_bukti_sah) : null,
    catatan || null, catatan_pajak || null
  );
  res.json({ id: result.lastInsertRowid });
});

// === MASTER SBU (Standar Biaya Umum personel) ===
// Sumber: 'pemda' (admin isi sendiri dari Pergub/Perbup) | 'inkindo' (placeholder, editable)
router.get('/sbu', (req, res) => {
  const db = getDb();
  const sumber = req.query.sumber; // optional filter
  const sql = sumber
    ? 'SELECT * FROM master_sbu_personel WHERE sumber = ? ORDER BY tahun DESC, jenjang_keahlian, pengalaman_tahun_min'
    : 'SELECT * FROM master_sbu_personel ORDER BY sumber, tahun DESC, jenjang_keahlian, pengalaman_tahun_min';
  const list = sumber ? db.prepare(sql).all(sumber) : db.prepare(sql).all();
  res.json(list);
});

router.post('/sbu', (req, res) => {
  const db = getDb();
  const { sumber, tahun, jenjang_keahlian, jenjang_pendidikan, pengalaman_tahun_min, pengalaman_tahun_max, tarif_per_bulan, catatan } = req.body;
  if (!sumber || !tahun || !jenjang_keahlian || tarif_per_bulan == null) {
    return res.status(400).json({ error: 'sumber, tahun, jenjang_keahlian, tarif_per_bulan wajib' });
  }
  if (!['pemda','inkindo'].includes(sumber)) {
    return res.status(400).json({ error: 'sumber harus pemda atau inkindo' });
  }
  try {
    const result = db.prepare(`
      INSERT INTO master_sbu_personel(
        sumber, tahun, jenjang_keahlian, jenjang_pendidikan,
        pengalaman_tahun_min, pengalaman_tahun_max, tarif_per_bulan, catatan
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sumber, parseInt(tahun, 10), jenjang_keahlian, jenjang_pendidikan || null,
      parseInt(pengalaman_tahun_min || 0, 10),
      pengalaman_tahun_max != null && pengalaman_tahun_max !== '' ? parseInt(pengalaman_tahun_max, 10) : null,
      parseFloat(tarif_per_bulan), catatan || null
    );
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Sudah ada SBU untuk kombinasi ini' });
  }
});

router.put('/sbu/:id', (req, res) => {
  const db = getDb();
  const { sumber, tahun, jenjang_keahlian, jenjang_pendidikan, pengalaman_tahun_min, pengalaman_tahun_max, tarif_per_bulan, catatan } = req.body;
  db.prepare(`
    UPDATE master_sbu_personel SET
      sumber = ?, tahun = ?, jenjang_keahlian = ?, jenjang_pendidikan = ?,
      pengalaman_tahun_min = ?, pengalaman_tahun_max = ?, tarif_per_bulan = ?, catatan = ?
    WHERE id = ?
  `).run(
    sumber, parseInt(tahun, 10), jenjang_keahlian, jenjang_pendidikan || null,
    parseInt(pengalaman_tahun_min || 0, 10),
    pengalaman_tahun_max != null && pengalaman_tahun_max !== '' ? parseInt(pengalaman_tahun_max, 10) : null,
    parseFloat(tarif_per_bulan), catatan || null,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/sbu/:id', (req, res) => {
  getDb().prepare('DELETE FROM master_sbu_personel WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Bulk seed INKINDO untuk tahun tertentu (kalau admin mau reset)
router.post('/sbu/seed-inkindo', (req, res) => {
  const { tahun } = req.body;
  if (!tahun) return res.status(400).json({ error: 'tahun wajib' });
  const db = getDb();
  const rows = [
    ['Tanpa Sertifikat', 'SMA/SMK', 0, null, 8_000_000],
    ['Tanpa Sertifikat', 'D3/D4',   0, null, 10_000_000],
    ['Tanpa Sertifikat', 'S1',      0, null, 12_000_000],
    ['Pratama', 'S1', 0, 4, 16_000_000],
    ['Muda',    'S1', 5, 9, 24_000_000],
    ['Muda',    'S2', 0, 4, 26_000_000],
    ['Madya',   'S1', 10, 14, 36_000_000],
    ['Madya',   'S2', 5, 9, 38_000_000],
    ['Madya',   'S3', 0, 4, 40_000_000],
    ['Utama',   'S1', 15, null, 55_000_000],
    ['Utama',   'S2', 10, null, 58_000_000],
    ['Utama',   'S3', 5, null, 62_000_000],
  ];
  const stmt = db.prepare(`
    INSERT INTO master_sbu_personel(sumber, tahun, jenjang_keahlian, jenjang_pendidikan, pengalaman_tahun_min, pengalaman_tahun_max, tarif_per_bulan, catatan)
    VALUES ('inkindo', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sumber, tahun, jenjang_keahlian, jenjang_pendidikan, pengalaman_tahun_min) DO UPDATE SET tarif_per_bulan = excluded.tarif_per_bulan
  `);
  for (const [jk, jp, eMin, eMax, tarif] of rows) {
    stmt.run(parseInt(tahun, 10), jk, jp, eMin, eMax, tarif, `Placeholder INKINDO ${tahun}`);
  }
  res.json({ ok: true, seeded: rows.length });
});

// === PENGATURAN ===
router.get('/pengaturan', (req, res) => {
  const db = getDb();
  const list = db.prepare('SELECT * FROM pengaturan ORDER BY key').all();
  res.json(list);
});

router.put('/pengaturan/:key', (req, res) => {
  const { value } = req.body;
  setSetting(req.params.key, value);
  res.json({ ok: true });
});

// === AUDIT CHECKLIST (3 area: perencanaan/pelaksanaan/pelaporan) ===
// Master items
router.get('/checklist/items', (req, res) => {
  const db = getDb();
  const area = req.query.area;
  const sql = area
    ? 'SELECT * FROM audit_checklist_item WHERE area = ? AND aktif = 1 ORDER BY urutan, kode'
    : 'SELECT * FROM audit_checklist_item WHERE aktif = 1 ORDER BY area, urutan, kode';
  res.json(area ? db.prepare(sql).all(area) : db.prepare(sql).all());
});

// Hasil checklist per paket (joined dengan master)
router.get('/paket/:id/checklist', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.area, i.kode, i.judul, i.fokus_uji, i.bukti_minimum,
           i.indikator_patuh, i.red_flag, i.dasar_hukum, i.urutan,
           h.id AS hasil_id, h.status, h.catatan, h.lokasi_bukti, h.dampak_pengembalian, h.dijalankan_at
    FROM audit_checklist_item i
    LEFT JOIN audit_checklist_hasil h ON h.checklist_item_id = i.id AND h.paket_id = ?
    WHERE i.aktif = 1
    ORDER BY i.area, i.urutan
  `).all(req.params.id);
  res.json(rows);
});

// Upsert hasil checklist
router.post('/paket/:id/checklist/:itemId', (req, res) => {
  const db = getDb();
  const { status, catatan, lokasi_bukti, dampak_pengembalian } = req.body;
  if (!['patuh','lemah','tidak_patuh','na'].includes(status)) {
    return res.status(400).json({ error: 'Status harus: patuh, lemah, tidak_patuh, atau na' });
  }
  const result = db.prepare(`
    INSERT INTO audit_checklist_hasil(paket_id, checklist_item_id, status, catatan, lokasi_bukti, dampak_pengembalian, dijalankan_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(paket_id, checklist_item_id) DO UPDATE SET
      status = excluded.status,
      catatan = excluded.catatan,
      lokasi_bukti = excluded.lokasi_bukti,
      dampak_pengembalian = excluded.dampak_pengembalian,
      dijalankan_at = CURRENT_TIMESTAMP
  `).run(
    req.params.id, req.params.itemId, status,
    catatan || null, lokasi_bukti || null,
    dampak_pengembalian != null ? parseFloat(dampak_pengembalian) : 0
  );
  res.json({ ok: true, id: result.lastInsertRowid });
});

// Hapus hasil (revert ke "belum dinilai")
router.delete('/paket/:id/checklist/:itemId', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM audit_checklist_hasil WHERE paket_id = ? AND checklist_item_id = ?')
    .run(req.params.id, req.params.itemId);
  res.json({ ok: true });
});

// Summary checklist per paket per area
router.get('/paket/:id/checklist/summary', (req, res) => {
  const db = getDb();
  const summary = db.prepare(`
    SELECT i.area,
      COUNT(i.id) AS total_items,
      SUM(CASE WHEN h.status = 'patuh' THEN 1 ELSE 0 END) AS patuh,
      SUM(CASE WHEN h.status = 'lemah' THEN 1 ELSE 0 END) AS lemah,
      SUM(CASE WHEN h.status = 'tidak_patuh' THEN 1 ELSE 0 END) AS tidak_patuh,
      SUM(CASE WHEN h.status = 'na' THEN 1 ELSE 0 END) AS na,
      SUM(CASE WHEN h.status IS NULL THEN 1 ELSE 0 END) AS belum_dinilai,
      COALESCE(SUM(h.dampak_pengembalian), 0) AS total_dampak
    FROM audit_checklist_item i
    LEFT JOIN audit_checklist_hasil h ON h.checklist_item_id = i.id AND h.paket_id = ?
    WHERE i.aktif = 1
    GROUP BY i.area
  `).all(req.params.id);
  res.json(summary);
});

// === SURAT TUGAS & PEMERIKSA ===
router.get('/surat-tugas', (req, res) => {
  const db = getDb();
  const list = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM pemeriksa WHERE surat_tugas_id = s.id) AS jml_pemeriksa
    FROM surat_tugas s ORDER BY s.tanggal DESC, s.id DESC
  `).all();
  const aktifId = parseInt(getSetting('surat_tugas_aktif', '0'), 10) || null;
  res.json({ list, aktif_id: aktifId });
});

router.get('/surat-tugas/:id', (req, res) => {
  const db = getDb();
  const surat = db.prepare('SELECT * FROM surat_tugas WHERE id = ?').get(req.params.id);
  if (!surat) return res.status(404).json({ error: 'Surat tugas tidak ditemukan' });
  const pemeriksa = db.prepare('SELECT * FROM pemeriksa WHERE surat_tugas_id = ? ORDER BY urutan, id').all(req.params.id);
  res.json({ surat, pemeriksa });
});

const uprSt = (s) => s == null || s === '' ? null : String(s).toUpperCase();

router.post('/surat-tugas', (req, res) => {
  const db = getDb();
  const f = req.body;
  if (!f.nomor || !f.tanggal || !f.bpk_perwakilan || !f.nama_pemeriksaan) {
    return res.status(400).json({ error: 'Nomor, tanggal, BPK Perwakilan, dan Nama Pemeriksaan wajib diisi' });
  }
  try {
    const r = db.prepare(`
      INSERT INTO surat_tugas(nomor, tanggal, bpk_perwakilan, alamat_perwakilan, telepon, fax, email, website,
        nama_pemeriksaan, entitas_diperiksa, tahun_anggaran_target, periode_audit_mulai, periode_audit_selesai, status, keterangan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uprSt(f.nomor), f.tanggal, uprSt(f.bpk_perwakilan),
      f.alamat_perwakilan || null, f.telepon || null, f.fax || null, f.email || null, f.website || null,
      uprSt(f.nama_pemeriksaan), uprSt(f.entitas_diperiksa), f.tahun_anggaran_target || null,
      f.periode_audit_mulai || null, f.periode_audit_selesai || null,
      f.status || 'aktif', uprSt(f.keterangan)
    );
    logAudit('admin', 'create_surat_tugas', 'surat_tugas', r.lastInsertRowid);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Nomor surat tugas duplikat: ' + e.message });
  }
});

router.put('/surat-tugas/:id', (req, res) => {
  const db = getDb();
  const f = req.body;
  db.prepare(`
    UPDATE surat_tugas SET
      nomor = ?, tanggal = ?, bpk_perwakilan = ?, alamat_perwakilan = ?, telepon = ?, fax = ?, email = ?, website = ?,
      nama_pemeriksaan = ?, entitas_diperiksa = ?, tahun_anggaran_target = ?,
      periode_audit_mulai = ?, periode_audit_selesai = ?,
      status = ?, keterangan = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    uprSt(f.nomor), f.tanggal, uprSt(f.bpk_perwakilan),
    f.alamat_perwakilan || null, f.telepon || null, f.fax || null, f.email || null, f.website || null,
    uprSt(f.nama_pemeriksaan), uprSt(f.entitas_diperiksa), f.tahun_anggaran_target || null,
    f.periode_audit_mulai || null, f.periode_audit_selesai || null,
    f.status || 'aktif', uprSt(f.keterangan),
    req.params.id
  );
  res.json({ ok: true });
});

// Master daftar BPK Perwakilan (untuk dropdown auto-fill di form Surat Tugas)
router.get('/bpk-perwakilan/master', (req, res) => {
  res.json(require('../lib/bpk-perwakilan'));
});

router.delete('/surat-tugas/:id', (req, res) => {
  getDb().prepare('DELETE FROM surat_tugas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/surat-tugas/:id/aktifkan', (req, res) => {
  setSetting('surat_tugas_aktif', String(req.params.id));
  logAudit('admin', 'set_surat_tugas_aktif', 'surat_tugas', req.params.id);
  res.json({ ok: true });
});

// Pemeriksa CRUD
router.post('/surat-tugas/:id/pemeriksa', (req, res) => {
  const db = getDb();
  const { nama, nip, jabatan, peran, urutan } = req.body;
  if (!nama) return res.status(400).json({ error: 'Nama pemeriksa wajib' });
  const r = db.prepare(`
    INSERT INTO pemeriksa(surat_tugas_id, nama, nip, jabatan, peran, urutan)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, uprSt(nama), nip || null, uprSt(jabatan), uprSt(peran), urutan || 0);
  res.json({ id: r.lastInsertRowid });
});

router.put('/pemeriksa/:id', (req, res) => {
  const db = getDb();
  const { nama, nip, jabatan, peran, urutan } = req.body;
  db.prepare(`UPDATE pemeriksa SET nama=?, nip=?, jabatan=?, peran=?, urutan=? WHERE id=?`)
    .run(uprSt(nama), nip || null, uprSt(jabatan), uprSt(peran), urutan || 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/pemeriksa/:id', (req, res) => {
  getDb().prepare('DELETE FROM pemeriksa WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// === BERITA ACARA PERMINTAAN KETERANGAN (BAPK) ===
router.get('/berita-acara', (req, res) => {
  const db = getDb();
  const list = db.prepare(`
    SELECT b.*, s.nomor AS st_nomor, p.nama_pekerjaan AS paket_nama
    FROM berita_acara b
    JOIN surat_tugas s ON s.id = b.surat_tugas_id
    LEFT JOIN paket p ON p.id = b.paket_id
    ORDER BY b.tanggal DESC, b.id DESC
  `).all();
  res.json(list);
});

router.get('/berita-acara/:id', (req, res) => {
  const db = getDb();
  const ba = db.prepare('SELECT * FROM berita_acara WHERE id = ?').get(req.params.id);
  if (!ba) return res.status(404).json({ error: 'BA tidak ditemukan' });
  res.json(ba);
});

router.post('/berita-acara', (req, res) => {
  const db = getDb();
  const f = req.body;
  if (!f.surat_tugas_id || !f.pemberi_nama) {
    return res.status(400).json({ error: 'Surat Tugas dan Nama Pemberi Keterangan wajib diisi' });
  }
  const r = db.prepare(`
    INSERT INTO berita_acara(
      surat_tugas_id, paket_id, nomor, hari, tanggal,
      pemberi_nama, pemberi_jabatan, pemberi_skpd, pemberi_nomor_kontak, pemberi_nip, nama_penyedia,
      hasil_keterangan,
      pemeriksa_1_id, pemeriksa_2_id, ppk_nama, ppk_nip, pptk_nama, pptk_nip, penyedia_rep_nama, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    f.surat_tugas_id, f.paket_id || null, uprSt(f.nomor), uprSt(f.hari), f.tanggal || null,
    uprSt(f.pemberi_nama), uprSt(f.pemberi_jabatan), uprSt(f.pemberi_skpd),
    f.pemberi_nomor_kontak || null, f.pemberi_nip || null, uprSt(f.nama_penyedia),
    f.hasil_keterangan || null,
    f.pemeriksa_1_id || null, f.pemeriksa_2_id || null,
    uprSt(f.ppk_nama), f.ppk_nip || null, uprSt(f.pptk_nama), f.pptk_nip || null,
    uprSt(f.penyedia_rep_nama), f.status || 'draft'
  );
  logAudit('admin', 'create_ba', 'berita_acara', r.lastInsertRowid);
  res.json({ id: r.lastInsertRowid });
});

router.put('/berita-acara/:id', (req, res) => {
  const db = getDb();
  const f = req.body;
  db.prepare(`
    UPDATE berita_acara SET
      surat_tugas_id = ?, paket_id = ?, nomor = ?, hari = ?, tanggal = ?,
      pemberi_nama = ?, pemberi_jabatan = ?, pemberi_skpd = ?, pemberi_nomor_kontak = ?, pemberi_nip = ?, nama_penyedia = ?,
      hasil_keterangan = ?,
      pemeriksa_1_id = ?, pemeriksa_2_id = ?, ppk_nama = ?, ppk_nip = ?, pptk_nama = ?, pptk_nip = ?, penyedia_rep_nama = ?,
      status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    f.surat_tugas_id, f.paket_id || null, uprSt(f.nomor), uprSt(f.hari), f.tanggal || null,
    uprSt(f.pemberi_nama), uprSt(f.pemberi_jabatan), uprSt(f.pemberi_skpd),
    f.pemberi_nomor_kontak || null, f.pemberi_nip || null, uprSt(f.nama_penyedia),
    f.hasil_keterangan || null,
    f.pemeriksa_1_id || null, f.pemeriksa_2_id || null,
    uprSt(f.ppk_nama), f.ppk_nip || null, uprSt(f.pptk_nama), f.pptk_nip || null,
    uprSt(f.penyedia_rep_nama), f.status || 'draft',
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/berita-acara/:id', (req, res) => {
  getDb().prepare('DELETE FROM berita_acara WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Auto-generate hasil keterangan dari hasil audit paket
router.post('/berita-acara/auto-generate', (req, res) => {
  const { buildHasilKeteranganFromAudit } = require('../lib/bapk-builder');
  try {
    const { paket_id } = req.body;
    if (!paket_id) return res.status(400).json({ error: 'paket_id wajib' });
    const hasil = buildHasilKeteranganFromAudit(paket_id);
    res.json({ ok: true, hasil_keterangan: hasil });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick-create BAPK dari paket: auto-isi semua field dari paket + audit + surat tugas aktif
router.post('/paket/:id/generate-bapk', (req, res) => {
  const db = getDb();
  const { buildHasilKeteranganFromAudit } = require('../lib/bapk-builder');
  try {
    const paketId = parseInt(req.params.id, 10);
    const paket = db.prepare(`
      SELECT p.*, o.nama AS opd_nama FROM paket p JOIN opd o ON o.id = p.opd_id WHERE p.id = ?
    `).get(paketId);
    if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

    const stId = parseInt(getSetting('surat_tugas_aktif', '0'), 10);
    if (!stId) return res.status(400).json({ error: 'Belum ada Surat Tugas Aktif. Set di menu Surat Tugas dulu.' });
    const surat = db.prepare('SELECT * FROM surat_tugas WHERE id = ?').get(stId);
    if (!surat) return res.status(400).json({ error: 'Surat tugas aktif tidak valid. Pilih ulang di menu Surat Tugas.' });

    // Auto-pilih 2 pemeriksa pertama
    const pem = db.prepare('SELECT * FROM pemeriksa WHERE surat_tugas_id = ? ORDER BY urutan, id LIMIT 2').all(stId);

    // Generate hasil keterangan otomatis
    const hasilKet = buildHasilKeteranganFromAudit(paketId);

    // Pemberi keterangan default: PPK paket (kalau diisi). Kalau gak ada → kosong, user isi nanti
    const { jenis_pemberi = 'ppk' } = req.body;
    let pemberiNama = '';
    let pemberiJabatan = '';
    if (jenis_pemberi === 'ppk') {
      pemberiJabatan = 'Pejabat Pembuat Komitmen (PPK)';
    } else if (jenis_pemberi === 'pptk') {
      pemberiJabatan = 'Pejabat Pelaksana Teknis Kegiatan (PPTK)';
    } else if (jenis_pemberi === 'penyedia') {
      pemberiNama = paket.nama_penyedia || '';
      pemberiJabatan = `Direktur ${paket.bentuk_badan || ''} ${paket.nama_penyedia || ''}`.trim();
    }

    const today = new Date().toISOString().slice(0, 10);
    const HARI_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    const hari = HARI_ID[new Date(today + 'T00:00:00').getDay()];

    // Auto-fill PPK/PPTK dari paket (yang sudah diisi OPD)
    // Dan kalau jenis_pemberi=ppk/pptk, isi pemberi_nama langsung dari paket
    let pemberiNip = '';
    if (jenis_pemberi === 'ppk' && paket.ppk_nama) {
      pemberiNama = paket.ppk_nama;
      pemberiNip = paket.ppk_nip || '';
    } else if (jenis_pemberi === 'pptk' && paket.pptk_nama) {
      pemberiNama = paket.pptk_nama;
      pemberiNip = paket.pptk_nip || '';
    }

    const r = db.prepare(`
      INSERT INTO berita_acara(
        surat_tugas_id, paket_id, nomor, hari, tanggal,
        pemberi_nama, pemberi_jabatan, pemberi_skpd, pemberi_nip, nama_penyedia,
        hasil_keterangan,
        pemeriksa_1_id, pemeriksa_2_id,
        ppk_nama, ppk_nip, pptk_nama, pptk_nip, penyedia_rep_nama,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stId, paketId, '', hari.toUpperCase(), today,
      pemberiNama.toUpperCase(), pemberiJabatan.toUpperCase(),
      paket.opd_nama, pemberiNip, paket.nama_penyedia || null,
      hasilKet,
      pem[0]?.id || null, pem[1]?.id || null,
      paket.ppk_nama || null, paket.ppk_nip || null,
      paket.pptk_nama || null, paket.pptk_nip || null,
      paket.nama_penyedia || null,
      'draft'
    );
    logAudit('admin', 'auto_generate_bapk', 'berita_acara', r.lastInsertRowid, { paket_id: paketId, jenis_pemberi });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Regenerate hasil keterangan untuk BAPK existing
router.post('/berita-acara/:id/regenerate-hasil', (req, res) => {
  const db = getDb();
  const { buildHasilKeteranganFromAudit } = require('../lib/bapk-builder');
  try {
    const ba = db.prepare('SELECT * FROM berita_acara WHERE id = ?').get(req.params.id);
    if (!ba) return res.status(404).json({ error: 'BAPK tidak ditemukan' });
    if (!ba.paket_id) return res.status(400).json({ error: 'BAPK ini tidak terhubung ke paket — auto-generate butuh paket' });
    const hasil = buildHasilKeteranganFromAudit(ba.paket_id);
    db.prepare('UPDATE berita_acara SET hasil_keterangan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hasil, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate Word DOCX
router.get('/berita-acara/:id/download', async (req, res) => {
  try {
    const { generateBA } = require('../lib/ba-generator');
    const buf = await generateBA(parseInt(req.params.id, 10));
    const ba = getDb().prepare('SELECT nomor, pemberi_nama FROM berita_acara WHERE id = ?').get(req.params.id);
    const safeName = `BAPK_${(ba?.nomor || ba?.pemberi_nama || req.params.id).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60)}`;
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get surat tugas aktif lengkap (untuk dipakai di BA generator nanti)
router.get('/surat-tugas-aktif/lengkap', (req, res) => {
  const db = getDb();
  const id = parseInt(getSetting('surat_tugas_aktif', '0'), 10);
  if (!id) return res.json({ surat: null, pemeriksa: [] });
  const surat = db.prepare('SELECT * FROM surat_tugas WHERE id = ?').get(id);
  const pemeriksa = surat ? db.prepare('SELECT * FROM pemeriksa WHERE surat_tugas_id = ? ORDER BY urutan, id').all(id) : [];
  res.json({ surat, pemeriksa });
});

// === USER MANAGEMENT (Super Admin only) ===
router.get('/users', ensureSuperAdmin, (req, res) => {
  const db = getDb();
  const list = db.prepare(`
    SELECT u.id, u.email, u.nama, u.nip, u.jabatan, u.role, u.aktif, u.surat_tugas_id, u.last_login_at, u.created_at,
           s.nomor AS st_nomor, s.nama_pemeriksaan AS st_nama
    FROM user_admin u LEFT JOIN surat_tugas s ON s.id = u.surat_tugas_id
    ORDER BY u.created_at DESC
  `).all();
  res.json(list);
});

router.post('/users', ensureSuperAdmin, (req, res) => {
  const { email, password, nama, nip, jabatan, role, surat_tugas_id } = req.body;
  if (!email || !password || !nama) return res.status(400).json({ error: 'Email, password, nama wajib diisi' });
  if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (!['super_admin','auditor'].includes(role || 'auditor')) return res.status(400).json({ error: 'Role harus super_admin atau auditor' });
  // Auditor wajib di-assign ke surat tugas; super_admin boleh null
  if (role === 'auditor' && !surat_tugas_id) {
    return res.status(400).json({ error: 'Auditor wajib di-assign ke salah satu Surat Tugas' });
  }
  const db = getDb();
  try {
    const hash = bcrypt.hashSync(password, 10);
    const stIdToSet = role === 'super_admin' ? null : surat_tugas_id;
    const r = db.prepare(`
      INSERT INTO user_admin(email, password_hash, nama, nip, jabatan, role, surat_tugas_id, aktif)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(email.trim().toLowerCase(), hash, nama.toUpperCase(), nip || null, jabatan ? jabatan.toUpperCase() : null, role || 'auditor', stIdToSet);
    logAudit(`user:${req.session.email}`, 'create_user', 'user_admin', r.lastInsertRowid, { email, surat_tugas_id: stIdToSet });
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Email sudah dipakai: ' + e.message });
  }
});

router.put('/users/:id', ensureSuperAdmin, (req, res) => {
  const { email, nama, nip, jabatan, role, surat_tugas_id, aktif } = req.body;
  if (role === 'auditor' && !surat_tugas_id) {
    return res.status(400).json({ error: 'Auditor wajib di-assign ke salah satu Surat Tugas' });
  }
  const db = getDb();
  const stIdToSet = role === 'super_admin' ? null : surat_tugas_id;
  db.prepare(`
    UPDATE user_admin SET email = ?, nama = ?, nip = ?, jabatan = ?, role = ?, surat_tugas_id = ?, aktif = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(email.trim().toLowerCase(), nama.toUpperCase(), nip || null, jabatan ? jabatan.toUpperCase() : null, role || 'auditor', stIdToSet, aktif ? 1 : 0, req.params.id);
  logAudit(`user:${req.session.email}`, 'update_user', 'user_admin', req.params.id);
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', ensureSuperAdmin, (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  const db = getDb();
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE user_admin SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.params.id);
  logAudit(`user:${req.session.email}`, 'reset_user_password', 'user_admin', req.params.id);
  res.json({ ok: true });
});

// === SIGNUP INVITES (Super Admin only) ===
function generateInviteToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

router.get('/invites', ensureSuperAdmin, (req, res) => {
  const db = getDb();
  const list = db.prepare(`
    SELECT i.id, i.token, i.surat_tugas_id, i.email_hint, i.catatan, i.max_uses, i.used_count,
           i.expires_at, i.revoked, i.created_at,
           s.nomor AS st_nomor, s.nama_pemeriksaan AS st_nama,
           u.nama AS creator_nama
    FROM signup_invite i
    LEFT JOIN surat_tugas s ON s.id = i.surat_tugas_id
    LEFT JOIN user_admin u ON u.id = i.created_by
    ORDER BY i.created_at DESC
  `).all();
  res.json(list);
});

router.post('/invites', ensureSuperAdmin, (req, res) => {
  const { surat_tugas_id, email_hint, catatan, max_uses, expires_in_days } = req.body;
  if (!surat_tugas_id) return res.status(400).json({ error: 'Surat Tugas wajib dipilih' });
  const db = getDb();
  const exists = db.prepare('SELECT id FROM surat_tugas WHERE id = ?').get(surat_tugas_id);
  if (!exists) return res.status(404).json({ error: 'Surat Tugas tidak ditemukan' });
  const token = generateInviteToken();
  const expiresAt = expires_in_days ? new Date(Date.now() + parseInt(expires_in_days, 10) * 86400000).toISOString() : null;
  const r = db.prepare(`
    INSERT INTO signup_invite(token, surat_tugas_id, email_hint, catatan, max_uses, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(token, surat_tugas_id, email_hint || null, catatan || null, parseInt(max_uses, 10) || 1, expiresAt, req.session.userId);
  logAudit(`user:${req.session.email}`, 'create_invite', 'signup_invite', r.lastInsertRowid, { surat_tugas_id });
  res.json({ id: r.lastInsertRowid, token });
});

router.post('/invites/:id/revoke', ensureSuperAdmin, (req, res) => {
  getDb().prepare('UPDATE signup_invite SET revoked = 1 WHERE id = ?').run(req.params.id);
  logAudit(`user:${req.session.email}`, 'revoke_invite', 'signup_invite', req.params.id);
  res.json({ ok: true });
});

router.delete('/invites/:id', ensureSuperAdmin, (req, res) => {
  getDb().prepare('DELETE FROM signup_invite WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.delete('/users/:id', ensureSuperAdmin, (req, res) => {
  if (parseInt(req.params.id, 10) === req.session.userId) {
    return res.status(400).json({ error: 'Tidak bisa hapus akun sendiri' });
  }
  getDb().prepare('DELETE FROM user_admin WHERE id = ?').run(req.params.id);
  logAudit(`user:${req.session.email}`, 'delete_user', 'user_admin', req.params.id);
  res.json({ ok: true });
});

// === BACKUP DB ===
router.get('/backup', (req, res) => {
  const { DB_PATH } = require('../db/schema');
  res.download(DB_PATH, `audit_backup_${new Date().toISOString().slice(0,10)}.db`);
});

module.exports = router;
