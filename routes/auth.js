const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const { logAudit } = require('../lib/helpers');

const router = express.Router();

router.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM user_admin WHERE LOWER(email) = LOWER(?) AND aktif = 1').get(email.trim());
  if (!user) return res.status(401).json({ error: 'Email atau password salah' });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Email atau password salah' });
  }
  // Set session
  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.nama = user.nama;
  req.session.role = user.role;
  req.session.userSuratTugasId = user.surat_tugas_id; // null untuk super admin
  req.session.activeSuratTugasId = user.surat_tugas_id; // default ke audit assigned (super admin: null = semua)
  req.session.isAdmin = true; // backward compat
  req.session.opdId = null;
  req.session.opdNama = null;
  // Update last login
  db.prepare('UPDATE user_admin SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  logAudit(`user:${user.email}`, 'login', 'user_admin', user.id);
  res.json({ ok: true, user: { id: user.id, email: user.email, nama: user.nama, role: user.role } });
});

// Get current user profile
router.get('/admin/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const db = getDb();
  const user = db.prepare('SELECT id, email, nama, nip, jabatan, role, last_login_at FROM user_admin WHERE id = ?').get(req.session.userId);
  res.json(user);
});

// Change own password
router.post('/admin/change-password', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Password lama & baru wajib diisi' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM user_admin WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Password lama salah' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE user_admin SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, user.id);
  logAudit(`user:${user.email}`, 'change_password', 'user_admin', user.id);
  res.json({ ok: true });
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// === SIGN UP via INVITE (public — no auth required) ===
// Step 1: validate invite token + return audit info untuk preview
router.get('/sign-up/preview', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token wajib' });
  const db = getDb();
  const invite = db.prepare(`
    SELECT i.*, s.nomor AS st_nomor, s.nama_pemeriksaan, s.bpk_perwakilan, s.entitas_diperiksa,
           u.nama AS creator_nama
    FROM signup_invite i
    LEFT JOIN surat_tugas s ON s.id = i.surat_tugas_id
    LEFT JOIN user_admin u ON u.id = i.created_by
    WHERE i.token = ?
  `).get(token);
  if (!invite) return res.status(404).json({ error: 'Token undangan tidak valid' });
  if (invite.revoked) return res.status(403).json({ error: 'Undangan sudah dicabut' });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return res.status(403).json({ error: 'Undangan sudah expired' });
  if (invite.used_count >= invite.max_uses) return res.status(403).json({ error: 'Undangan sudah dipakai sampai batas maksimal' });
  res.json({
    surat_tugas: {
      id: invite.surat_tugas_id, nomor: invite.st_nomor,
      nama_pemeriksaan: invite.nama_pemeriksaan,
      bpk_perwakilan: invite.bpk_perwakilan,
      entitas_diperiksa: invite.entitas_diperiksa,
    },
    email_hint: invite.email_hint,
    catatan: invite.catatan,
    creator: invite.creator_nama,
    remaining_uses: invite.max_uses - invite.used_count,
  });
});

// Step 2: actual sign up — create user dengan role 'auditor' + surat_tugas_id dari invite
router.post('/sign-up', (req, res) => {
  const { token, email, password, nama, nip, jabatan } = req.body;
  if (!token || !email || !password || !nama) {
    return res.status(400).json({ error: 'Token, email, password, nama wajib diisi' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  const db = getDb();
  const invite = db.prepare('SELECT * FROM signup_invite WHERE token = ?').get(token);
  if (!invite) return res.status(404).json({ error: 'Token undangan tidak valid' });
  if (invite.revoked) return res.status(403).json({ error: 'Undangan sudah dicabut' });
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) return res.status(403).json({ error: 'Undangan sudah expired' });
  if (invite.used_count >= invite.max_uses) return res.status(403).json({ error: 'Undangan sudah dipakai sampai batas maksimal' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare(`
      INSERT INTO user_admin(email, password_hash, nama, nip, jabatan, role, surat_tugas_id, aktif)
      VALUES (?, ?, ?, ?, ?, 'auditor', ?, 1)
    `).run(email.trim().toLowerCase(), hash, nama.toUpperCase(), nip || null, jabatan ? jabatan.toUpperCase() : null, invite.surat_tugas_id);
    db.prepare('UPDATE signup_invite SET used_count = used_count + 1 WHERE id = ?').run(invite.id);
    logAudit(`signup:${email}`, 'sign_up_via_invite', 'user_admin', r.lastInsertRowid, { invite_id: invite.id });
    res.json({ ok: true, message: 'Akun berhasil dibuat. Silakan login.' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email sudah terdaftar' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/opd/login', (req, res) => {
  const { kode_akses } = req.body;
  if (!kode_akses) {
    return res.status(400).json({ error: 'Kode akses wajib diisi' });
  }
  const db = getDb();
  // Cari kode_akses di opd_audit (per OPD × surat_tugas)
  const row = db.prepare(`
    SELECT oa.id AS opd_audit_id, oa.opd_id, oa.surat_tugas_id, oa.aktif,
           o.nama AS opd_nama,
           s.nama_pemeriksaan, s.nomor AS st_nomor, s.bpk_perwakilan, s.entitas_diperiksa
    FROM opd_audit oa
    JOIN opd o ON o.id = oa.opd_id
    JOIN surat_tugas s ON s.id = oa.surat_tugas_id
    WHERE UPPER(oa.kode_akses) = UPPER(?)
  `).get(String(kode_akses).trim());
  if (!row) return res.status(401).json({ error: 'Kode akses salah atau tidak terdaftar' });
  if (!row.aktif) return res.status(403).json({ error: 'Kode akses sudah dinonaktifkan' });

  req.session.opdId = row.opd_id;
  req.session.opdNama = row.opd_nama;
  req.session.activeSuratTugasId = row.surat_tugas_id; // OPD locked ke audit ini
  req.session.suratTugasNama = row.nama_pemeriksaan;
  req.session.isAdmin = false;
  logAudit(`opd:${row.opd_nama}`, 'login', 'opd', row.opd_id, { surat_tugas_id: row.surat_tugas_id });
  res.json({
    ok: true,
    opd: { id: row.opd_id, nama: row.opd_nama },
    audit: { id: row.surat_tugas_id, nama: row.nama_pemeriksaan, nomor: row.st_nomor, perwakilan: row.bpk_perwakilan, entitas: row.entitas_diperiksa },
  });
});

router.post('/opd/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (req.session.isAdmin) {
    return res.json({ role: 'admin' });
  }
  if (req.session.opdId) {
    return res.json({ role: 'opd', opd_id: req.session.opdId, opd_nama: req.session.opdNama });
  }
  res.json({ role: 'guest' });
});

router.get('/opd/list-public', (req, res) => {
  // Tidak dipakai lagi sejak login pakai kode akses langsung (tanpa pilih OPD)
  // Kept for backward compat; return empty
  res.json([]);
});

module.exports = router;
