// Helpers untuk maintain konsistensi antara `paket` dan `paket_sp2d`
const { getDb } = require('../db/schema');

/**
 * Recompute total nilai_paket dan nilai_realisasi di tabel paket
 * berdasar SUM dari paket_sp2d.
 */
function recomputeNilaiPaket(db, paketId) {
  if (!db) db = getDb();
  const sums = db.prepare(`
    SELECT
      COALESCE(SUM(nilai_sp2d), 0) AS total_nilai,
      COALESCE(SUM(nilai_realisasi), 0) AS total_realisasi
    FROM paket_sp2d WHERE paket_id = ?
  `).get(paketId);
  db.prepare(`
    UPDATE paket SET
      nilai_paket = ?,
      nilai_realisasi = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sums.total_nilai, sums.total_realisasi, paketId);
  return sums;
}

module.exports = { recomputeNilaiPaket };
