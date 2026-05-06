const { getDb } = require('../db/schema');

function generateKodeAkses() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclude I, O, 0, 1 (ambigu)
  const db = getDb();
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const exists = db.prepare('SELECT 1 FROM opd WHERE kode_akses = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('Gagal generate kode akses unik');
}

function ensureAdmin(req, res, next) {
  if (req.session && req.session.userId && (req.session.role === 'super_admin' || req.session.role === 'auditor')) return next();
  // Backward compat: kalau ada session.isAdmin lama, accept dulu (trans masa transisi)
  if (req.session && req.session.isAdmin) return next();
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(401).json({ error: 'Login admin diperlukan' });
  }
  return res.redirect('/admin/login');
}

function ensureSuperAdmin(req, res, next) {
  if (req.session && req.session.role === 'super_admin') return next();
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(403).json({ error: 'Hanya Super Admin yang bisa akses fitur ini' });
  }
  return res.redirect('/admin/dashboard');
}

/**
 * Get aktif surat_tugas_id untuk filter query.
 * - Super admin: pakai req.session.activeSuratTugasId (kalau pilih dari switcher), null = lihat semua
 * - Auditor: dari user.surat_tugas_id (locked, tidak bisa pindah)
 * - OPD: dari kode akses login
 * Return: integer id, atau null = super admin lihat semua
 */
function getActiveSuratTugasId(req) {
  if (!req.session) return null;
  // Super admin pakai switcher, atau null = semua
  if (req.session.role === 'super_admin') return req.session.activeSuratTugasId || null;
  // Auditor regular: locked ke surat tugas-nya
  if (req.session.role === 'auditor') return req.session.userSuratTugasId || null;
  // OPD
  if (req.session.opdId) return req.session.activeSuratTugasId || null;
  return null;
}

/**
 * SQL fragment helper: WHERE surat_tugas_id = ?
 * Returns { sql, params } untuk dipakai di query builder.
 * Kalau super admin lihat semua, return empty filter.
 */
function suratTugasFilter(req, table = '') {
  const id = getActiveSuratTugasId(req);
  if (id == null) return { sql: '', params: [] };
  const prefix = table ? `${table}.` : '';
  return { sql: `${prefix}surat_tugas_id = ?`, params: [id] };
}

function ensureOpd(req, res, next) {
  if (req.session && req.session.opdId) {
    req.opdId = req.session.opdId;
    return next();
  }
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(401).json({ error: 'Kode akses OPD tidak valid' });
  }
  return res.redirect('/opd');
}

function ensureOpdOwnsPaket(req, res, next) {
  const db = getDb();
  const paketId = parseInt(req.params.id || req.params.paketId, 10);
  if (!paketId) return res.status(400).json({ error: 'paket_id tidak valid' });
  const paket = db.prepare('SELECT id, opd_id, status FROM paket WHERE id = ?').get(paketId);
  if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });
  if (paket.opd_id !== req.session.opdId) {
    return res.status(403).json({ error: 'Paket bukan milik OPD ini' });
  }
  req.paket = paket;
  next();
}

function preventEditWhenLocked(req, res, next) {
  if (req.paket && req.paket.status === 'terkunci') {
    return res.status(423).json({ error: 'Paket sudah dikunci admin, tidak bisa diedit' });
  }
  next();
}

function getSetting(key, defaultValue = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM pengaturan WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value, description = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pengaturan(key, value, description) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value), description);
}

function logAudit(actor, action, targetType, targetId, detail = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log(actor, action, target_type, target_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor, action, targetType, targetId, detail ? JSON.stringify(detail) : null);
}

function rupiah(n) {
  if (n == null || isNaN(n)) return '-';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

module.exports = {
  generateKodeAkses,
  ensureAdmin,
  ensureSuperAdmin,
  getActiveSuratTugasId,
  suratTugasFilter,
  ensureOpd,
  ensureOpdOwnsPaket,
  preventEditWhenLocked,
  getSetting,
  setSetting,
  logAudit,
  rupiah,
};
