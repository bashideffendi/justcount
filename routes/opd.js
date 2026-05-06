const express = require('express');
const { getDb } = require('../db/schema');
const { ensureOpd, ensureOpdOwnsPaket, preventEditWhenLocked, logAudit } = require('../lib/helpers');
const { recomputeNilaiPaket } = require('../lib/paket-helpers');

const router = express.Router();
router.use(ensureOpd);

// Status yang OPD masih boleh gabung/pisah
const EDITABLE_STATUS = new Set(['belum_diisi', 'draft']);

// Daftar paket milik OPD-nya (DI surat tugas yang dia login)
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const stId = req.session.activeSuratTugasId;
  const opd = db.prepare('SELECT id, nama FROM opd WHERE id = ?').get(req.opdId);
  // Info audit yang lagi dia kerjain
  const audit = stId ? db.prepare('SELECT id, nomor, tanggal, bpk_perwakilan, nama_pemeriksaan, entitas_diperiksa FROM surat_tugas WHERE id = ?').get(stId) : null;
  const pakets = db.prepare(`
    SELECT id, nomor_paket, nama_pekerjaan, nilai_paket, nilai_realisasi, tahun_anggaran, status,
           jenis_kontrak, jenis_konsultansi, no_kontrak,
           (SELECT COUNT(*) FROM tenaga_ahli_kontrak WHERE paket_id = paket.id) AS jml_ta,
           (SELECT COUNT(*) FROM paket_sp2d WHERE paket_id = paket.id) AS jml_sp2d,
           (SELECT MIN(tanggal_sp2d) FROM paket_sp2d WHERE paket_id = paket.id) AS tanggal_sp2d_pertama
    FROM paket
    WHERE opd_id = ? AND surat_tugas_id = ?
    ORDER BY (SELECT MIN(tanggal_sp2d) FROM paket_sp2d WHERE paket_id = paket.id) DESC, nama_pekerjaan
  `).all(req.opdId, stId);
  res.json({ opd, audit, paket: pakets });
});

// Detail paket (untuk form input)
router.get('/paket/:id', ensureOpdOwnsPaket, (req, res) => {
  const db = getDb();
  // PENTING: tidak return temuan, biaya_personel, biaya_non_personel, tenaga_ahli_aktual
  // OPD tidak boleh lihat hasil audit / data verifikasi admin.
  const paket = db.prepare(`
    SELECT id, opd_id, nomor_paket, nama_pekerjaan, nilai_paket, nilai_realisasi, tahun_anggaran,
           no_kontrak, tanggal_kontrak, tanggal_mulai, tanggal_selesai,
           bentuk_badan, nama_penyedia, ppk_nama, ppk_nip, pptk_nama, pptk_nip,
           jenis_kontrak, jenis_konsultansi, output_diharapkan, status, locked_at
    FROM paket WHERE id = ?
  `).get(req.params.id);
  const sp2d = db.prepare(`
    SELECT id, no_sp2d, tanggal_sp2d, nilai_sp2d, nilai_realisasi,
           jenis_akun, nama_rekening, nama_penerima, keterangan
    FROM paket_sp2d WHERE paket_id = ? ORDER BY tanggal_sp2d, no_sp2d
  `).all(req.params.id);
  const ta_kontrak = db.prepare(`
    SELECT id, nama, nik, jabatan FROM tenaga_ahli_kontrak WHERE paket_id = ?
  `).all(req.params.id);
  res.json({ paket, sp2d, ta_kontrak });
});

// Update data kontrak paket (auto-save draft) — termasuk bentuk_badan, nama_penyedia, tanggal_kontrak, jenis_konsultansi
router.put('/paket/:id', ensureOpdOwnsPaket, preventEditWhenLocked, (req, res) => {
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
  recomputeStatus(db, req.params.id);
  res.json({ ok: true });
});

// Submit final (mark lengkap)
router.post('/paket/:id/submit', ensureOpdOwnsPaket, preventEditWhenLocked, (req, res) => {
  const db = getDb();
  const paket = db.prepare('SELECT * FROM paket WHERE id = ?').get(req.params.id);
  const ta_count = db.prepare('SELECT COUNT(*) AS c FROM tenaga_ahli_kontrak WHERE paket_id = ?').get(req.params.id).c;
  const wajib = ['no_kontrak', 'tanggal_kontrak', 'tanggal_mulai', 'tanggal_selesai',
                 'jenis_kontrak', 'jenis_konsultansi', 'bentuk_badan', 'nama_penyedia'];
  const labelMap = {
    no_kontrak: 'Nomor Kontrak', tanggal_kontrak: 'Tanggal Kontrak',
    tanggal_mulai: 'Tanggal Mulai Pelaksanaan', tanggal_selesai: 'Tanggal Selesai Pelaksanaan',
    jenis_kontrak: 'Jenis Kontrak', jenis_konsultansi: 'Jenis Konsultansi',
    bentuk_badan: 'Bentuk Penyedia', nama_penyedia: 'Nama Penyedia',
  };
  const kosong = wajib.filter(k => !paket[k]);
  if (kosong.length > 0) {
    return res.status(400).json({ error: `Belum lengkap: ${kosong.map(k => labelMap[k]).join(', ')}` });
  }
  if (ta_count === 0) {
    return res.status(400).json({ error: 'Minimal 1 tenaga ahli wajib diisi' });
  }
  db.prepare(`UPDATE paket SET status = 'lengkap', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Helper: convert string ke UPPER, kecuali null/empty
const upr = (s) => s == null || s === '' ? s : String(s).toUpperCase();

// === BULK MERGE (OPD) ===
// OPD bisa gabungkan paket sendiri yang masih belum_diisi/draft.
router.post('/paket/bulk-merge', (req, res) => {
  const { target_id, source_ids, nama_pekerjaan } = req.body;
  if (!target_id || !Array.isArray(source_ids) || source_ids.length === 0) {
    return res.status(400).json({ error: 'target_id dan source_ids wajib' });
  }
  const db = getDb();
  const target = db.prepare('SELECT * FROM paket WHERE id = ?').get(target_id);
  if (!target) return res.status(404).json({ error: 'Paket target tidak ditemukan' });
  if (target.opd_id !== req.session.opdId) return res.status(403).json({ error: 'Paket bukan milik OPD ini' });
  if (!EDITABLE_STATUS.has(target.status)) {
    return res.status(400).json({ error: `Paket target berstatus ${target.status} — OPD hanya bisa gabung paket yang masih Belum Diisi atau Draft. Minta auditor untuk unlock dulu kalau perlu.` });
  }

  const sources = db.prepare(`SELECT * FROM paket WHERE id IN (${source_ids.map(() => '?').join(',')})`).all(...source_ids);
  for (const s of sources) {
    if (s.opd_id !== req.session.opdId) return res.status(403).json({ error: `Paket ${s.id} bukan milik OPD ini` });
    if (s.id === target.id) return res.status(400).json({ error: 'Source tidak boleh sama dengan target' });
    if (!EDITABLE_STATUS.has(s.status)) {
      return res.status(400).json({ error: `Paket "${s.nama_pekerjaan.slice(0, 50)}..." berstatus ${s.status} — tidak bisa di-merge.` });
    }
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
  logAudit(`opd:${req.session.opdNama}`, 'bulk_merge_paket', 'paket', target.id, { sources: source_ids, count: sources.length });
  res.json({ ok: true, merged_count: sources.length });
});

// Pisah SP2D (OPD)
router.post('/sp2d/:sp2dId/split', (req, res) => {
  const db = getDb();
  const sp2d = db.prepare('SELECT s.*, p.opd_id, p.tahun_anggaran, p.jenis_konsultansi, p.status, p.nama_pekerjaan AS old_pekerjaan FROM paket_sp2d s JOIN paket p ON p.id = s.paket_id WHERE s.id = ?').get(req.params.sp2dId);
  if (!sp2d) return res.status(404).json({ error: 'SP2D tidak ditemukan' });
  if (sp2d.opd_id !== req.session.opdId) return res.status(403).json({ error: 'SP2D bukan milik OPD ini' });
  if (!EDITABLE_STATUS.has(sp2d.status)) {
    return res.status(400).json({ error: `Paket berstatus ${sp2d.status} — tidak bisa pisah SP2D. Minta auditor unlock dulu.` });
  }
  // Cek paket sumber harus punya >1 SP2D (kalau cuma 1, gak masuk akal di-split)
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM paket_sp2d WHERE paket_id = ?').get(sp2d.paket_id).c;
  if (cnt <= 1) return res.status(400).json({ error: 'Paket hanya punya 1 SP2D, tidak bisa di-split' });

  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO paket(opd_id, nama_pekerjaan, tahun_anggaran, jenis_konsultansi)
      VALUES (?, ?, ?, ?)
    `).run(sp2d.opd_id, sp2d.keterangan || sp2d.old_pekerjaan, sp2d.tahun_anggaran, sp2d.jenis_konsultansi);
    const newPaketId = r.lastInsertRowid;
    db.prepare('UPDATE paket_sp2d SET paket_id = ? WHERE id = ?').run(newPaketId, sp2d.id);
    recomputeNilaiPaket(db, sp2d.paket_id);
    recomputeNilaiPaket(db, newPaketId);
    return newPaketId;
  });
  const newPaketId = tx();
  logAudit(`opd:${req.session.opdNama}`, 'split_sp2d', 'paket_sp2d', req.params.sp2dId, { from_paket: sp2d.paket_id, to_paket: newPaketId });
  res.json({ ok: true, new_paket_id: newPaketId });
});

// Tenaga ahli kontrak (CRUD oleh OPD) — periode mengikuti rincian biaya personel/paket, tidak diisi terpisah
router.post('/paket/:id/tenaga-ahli', ensureOpdOwnsPaket, preventEditWhenLocked, (req, res) => {
  const db = getDb();
  const { nama, nik, jabatan } = req.body;
  if (!nama || !nik || !jabatan) {
    return res.status(400).json({ error: 'Nama, NIK, dan Jabatan wajib diisi' });
  }
  const result = db.prepare(`
    INSERT INTO tenaga_ahli_kontrak(paket_id, nama, nik, jabatan)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, upr(nama), String(nik).trim(), upr(jabatan));
  recomputeStatus(db, req.params.id);
  res.json({ id: result.lastInsertRowid });
});

router.put('/tenaga-ahli/:taId', (req, res) => {
  const db = getDb();
  const ta = db.prepare(`
    SELECT t.*, p.opd_id, p.status AS paket_status
    FROM tenaga_ahli_kontrak t JOIN paket p ON p.id = t.paket_id
    WHERE t.id = ?
  `).get(req.params.taId);
  if (!ta) return res.status(404).json({ error: 'TA tidak ditemukan' });
  if (ta.opd_id !== req.session.opdId) return res.status(403).json({ error: 'Forbidden' });
  if (ta.paket_status === 'terkunci') return res.status(423).json({ error: 'Paket sudah dikunci' });

  const { nama, nik, jabatan } = req.body;
  db.prepare(`
    UPDATE tenaga_ahli_kontrak SET nama=?, nik=?, jabatan=?
    WHERE id = ?
  `).run(upr(nama), String(nik || '').trim(), upr(jabatan), req.params.taId);
  res.json({ ok: true });
});

router.delete('/tenaga-ahli/:taId', (req, res) => {
  const db = getDb();
  const ta = db.prepare(`
    SELECT t.id, t.paket_id, p.opd_id, p.status AS paket_status
    FROM tenaga_ahli_kontrak t JOIN paket p ON p.id = t.paket_id
    WHERE t.id = ?
  `).get(req.params.taId);
  if (!ta) return res.status(404).json({ error: 'TA tidak ditemukan' });
  if (ta.opd_id !== req.session.opdId) return res.status(403).json({ error: 'Forbidden' });
  if (ta.paket_status === 'terkunci') return res.status(423).json({ error: 'Paket sudah dikunci' });

  db.prepare('DELETE FROM tenaga_ahli_kontrak WHERE id = ?').run(req.params.taId);
  recomputeStatus(db, ta.paket_id);
  res.json({ ok: true });
});

// Helper: recompute status berdasar field-isi
function recomputeStatus(db, paketId) {
  const paket = db.prepare('SELECT * FROM paket WHERE id = ?').get(paketId);
  if (!paket || paket.status === 'terkunci') return;
  const ta = db.prepare('SELECT COUNT(*) AS c FROM tenaga_ahli_kontrak WHERE paket_id = ?').get(paketId).c;
  const wajib = ['no_kontrak', 'tanggal_kontrak', 'tanggal_mulai', 'tanggal_selesai',
                 'jenis_kontrak', 'jenis_konsultansi', 'bentuk_badan', 'nama_penyedia'];
  const terisi = wajib.filter(k => paket[k]).length;

  let status;
  if (terisi === 0 && ta === 0) status = 'belum_diisi';
  else if (terisi === wajib.length && ta > 0) status = 'lengkap';
  else status = 'draft';

  if (status !== paket.status) {
    db.prepare('UPDATE paket SET status = ? WHERE id = ?').run(status, paketId);
  }
}

module.exports = router;
