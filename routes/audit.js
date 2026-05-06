const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { ensureAdmin } = require('../lib/helpers');
const { runPaketAudit, recomputeLintas } = require('../lib/audit-engine');
const { findTumpangTindih, findLumpsumOverlap } = require('../lib/overlap');

router.use(ensureAdmin);

// Lock paket → run all skenario uji untuk paket itu + recompute lintas
// Bisa dipanggil ulang juga di paket terkunci → audit ulang (clear temuan lama, recompute)
router.post('/paket/:id/lock-and-audit', (req, res) => {
  try {
    const result = runPaketAudit(parseInt(req.params.id, 10));
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Buka kunci → balik status ke 'lengkap' biar OPD bisa edit lagi.
// Temuan TIDAK dihapus (data audit tetap, cuma OPD-side jadi editable).
router.post('/paket/:id/unlock', (req, res) => {
  const { getDb } = require('../db/schema');
  const { logAudit } = require('../lib/helpers');
  const db = getDb();
  const r = db.prepare(`UPDATE paket SET status='lengkap', locked_at=NULL WHERE id = ? AND status='terkunci'`).run(req.params.id);
  if (r.changes === 0) return res.status(400).json({ error: 'Paket tidak terkunci atau tidak ditemukan' });
  logAudit('admin', 'unlock_paket', 'paket', req.params.id);
  res.json({ ok: true });
});

// Recompute Uji 1 & 2 lintas paket
router.post('/lintas/recompute', (req, res) => {
  try {
    const r = recomputeLintas();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List temuan lintas (Uji 1 & 2) untuk halaman temuan-lintas
router.get('/lintas', (req, res) => {
  try {
    const tt = findTumpangTindih();
    const ls = findLumpsumOverlap();
    res.json({ tumpang_tindih: tt, lumpsum: ls });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
