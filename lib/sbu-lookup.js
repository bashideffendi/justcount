const { getDb } = require('../db/schema');
const { getSetting } = require('./helpers');

const JENJANG_RANK = { 'Tanpa Sertifikat': 0, 'Pratama': 1, 'Muda': 2, 'Madya': 3, 'Utama': 4 };
const RANK_TO_JENJANG = ['Tanpa Sertifikat', 'Pratama', 'Muda', 'Madya', 'Utama'];

// Pendidikan → equivalent jenjang keahlian (kasar — admin bisa override jenjang_efektif manual)
const PENDIDIKAN_MAP = {
  'SMA/SMK': 'Tanpa Sertifikat',
  'D3/D4': 'Pratama',
  'S1': 'Muda',
  'S2': 'Madya',
  'S3': 'Utama',
};

function jenjangFromPendidikan(p) { return PENDIDIKAN_MAP[p] || null; }

function rankOf(j) { return JENJANG_RANK[j] ?? -1; }

function computeJenjangEfektif(taa) {
  if (!taa) return null;
  if (taa.jenjang_efektif) return taa.jenjang_efektif;
  const fromEdu = jenjangFromPendidikan(taa.pendidikan_jenjang);
  const fromSka = taa.jenjang_ska || taa.jenjang_skk;
  // Kalau gak punya SKA/SKK sama sekali → Tanpa Sertifikat (terlepas pendidikan)
  if (!fromSka) return 'Tanpa Sertifikat';
  if (!fromEdu) return fromSka;
  // min(jenjang_pendidikan, jenjang_SKA)
  const minRank = Math.min(rankOf(fromEdu), rankOf(fromSka));
  return RANK_TO_JENJANG[minRank];
}

/**
 * Cari tarif SBU per bulan berdasar parameter. Sumber dibaca dari pengaturan 'sumber_tarif_aktif'.
 * Strategi pencarian (paling spesifik dulu):
 *   1. exact match jenjang_pendidikan + cocok pengalaman
 *   2. abaikan pengalaman, exact pendidikan
 *   3. abaikan pendidikan, ambil tarif terendah jenjang_keahlian itu
 *   4. fallback: NULL (caller harus handle)
 */
function lookupTarif({ jenjang_keahlian, jenjang_pendidikan = null, pengalaman_tahun = null, tahun, sumber = null }) {
  if (!jenjang_keahlian || !tahun) return null;
  const db = getDb();
  const eff = sumber || getSetting('sumber_tarif_aktif', 'inkindo');

  // 1: spesifik
  if (jenjang_pendidikan) {
    let row = db.prepare(`
      SELECT * FROM master_sbu_personel
      WHERE sumber = ? AND tahun = ? AND jenjang_keahlian = ? AND jenjang_pendidikan = ?
        AND pengalaman_tahun_min <= COALESCE(?, 0)
        AND (pengalaman_tahun_max IS NULL OR pengalaman_tahun_max >= COALESCE(?, pengalaman_tahun_min))
      ORDER BY pengalaman_tahun_min DESC
      LIMIT 1
    `).get(eff, tahun, jenjang_keahlian, jenjang_pendidikan,
           pengalaman_tahun, pengalaman_tahun);
    if (row) return row.tarif_per_bulan;

    // 2: pendidikan exact, abaikan pengalaman
    row = db.prepare(`
      SELECT * FROM master_sbu_personel
      WHERE sumber = ? AND tahun = ? AND jenjang_keahlian = ? AND jenjang_pendidikan = ?
      ORDER BY pengalaman_tahun_min ASC
      LIMIT 1
    `).get(eff, tahun, jenjang_keahlian, jenjang_pendidikan);
    if (row) return row.tarif_per_bulan;
  }

  // 3: abaikan pendidikan, ambil terendah
  const row = db.prepare(`
    SELECT * FROM master_sbu_personel
    WHERE sumber = ? AND tahun = ? AND jenjang_keahlian = ?
    ORDER BY tarif_per_bulan ASC
    LIMIT 1
  `).get(eff, tahun, jenjang_keahlian);
  return row ? row.tarif_per_bulan : null;
}

module.exports = {
  JENJANG_RANK, RANK_TO_JENJANG, PENDIDIKAN_MAP,
  jenjangFromPendidikan, rankOf, computeJenjangEfektif, lookupTarif,
};
