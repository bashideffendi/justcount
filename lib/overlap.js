const { getDb } = require('../db/schema');
const { getSetting } = require('./helpers');

function dateOnly(s) { return s.slice(0, 10); }
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayDiff(a, b) {
  // inclusive day count from a to b (a <= b)
  return Math.floor((new Date(b) - new Date(a)) / 86400000) + 1;
}
function daysToMM(days) {
  const hpb = parseFloat(getSetting('hari_kerja_per_bulan', '22'));
  return days / hpb;
}

/**
 * Uji 1: Tumpang tindih waktu penugasan (strict, lintas paket).
 * Output: untuk tiap pasang (paket_a, paket_b) yang share NIK + overlap.
 * Ambil HANYA paket waktu_penugasan yang TERKUNCI.
 */
function findTumpangTindih(db = getDb()) {
  // Periode TA fallback ke periode pelaksanaan paket kalau gak diisi
  const rows = db.prepare(`
    SELECT t.id, t.nik, t.nama, t.paket_id,
           COALESCE(t.periode_mulai, p.tanggal_mulai) AS periode_mulai,
           COALESCE(t.periode_selesai, p.tanggal_selesai) AS periode_selesai,
           p.nama_pekerjaan AS paket_nama, o.nama AS opd_nama, p.opd_id,
           bp.tarif_per_bulan AS tarif
    FROM tenaga_ahli_kontrak t
    JOIN paket p ON p.id = t.paket_id
    JOIN opd o ON o.id = p.opd_id
    LEFT JOIN biaya_personel bp ON bp.paket_id = t.paket_id AND LOWER(bp.jabatan) = LOWER(t.jabatan)
    WHERE p.jenis_kontrak = 'waktu_penugasan' AND p.status = 'terkunci'
      AND COALESCE(t.periode_mulai, p.tanggal_mulai) IS NOT NULL
      AND COALESCE(t.periode_selesai, p.tanggal_selesai) IS NOT NULL
  `).all();

  const byNik = {};
  for (const r of rows) {
    if (!byNik[r.nik]) byNik[r.nik] = [];
    byNik[r.nik].push(r);
  }

  const findings = [];
  for (const [nik, periods] of Object.entries(byNik)) {
    if (periods.length < 2) continue;
    for (let i = 0; i < periods.length; i++) {
      for (let j = i + 1; j < periods.length; j++) {
        const a = periods[i], b = periods[j];
        if (a.paket_id === b.paket_id) continue;
        const sa = dateOnly(a.periode_mulai), ea = dateOnly(a.periode_selesai);
        const sb = dateOnly(b.periode_mulai), eb = dateOnly(b.periode_selesai);
        if (sa <= eb && ea >= sb) {
          const ovStart = sa > sb ? sa : sb;
          const ovEnd = ea < eb ? ea : eb;
          const hari = dayDiff(ovStart, ovEnd);
          findings.push({
            nik, nama: a.nama,
            paket_a_id: a.paket_id, paket_a_nama: a.paket_nama, opd_a: a.opd_nama, tarif_a: a.tarif || 0,
            paket_b_id: b.paket_id, paket_b_nama: b.paket_nama, opd_b: b.opd_nama, tarif_b: b.tarif || 0,
            overlap_start: ovStart, overlap_end: ovEnd, hari_overlap: hari,
            mm_overlap: daysToMM(hari),
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Uji 2: Lumpsum > batas paket bersamaan (sweep line).
 */
function findLumpsumOverlap(db = getDb()) {
  const batas = parseInt(getSetting('batas_lumpsum_bersamaan', '3'), 10);
  const rows = db.prepare(`
    SELECT t.nik, t.nama, t.paket_id,
           COALESCE(t.periode_mulai, p.tanggal_mulai) AS periode_mulai,
           COALESCE(t.periode_selesai, p.tanggal_selesai) AS periode_selesai,
           p.nama_pekerjaan AS paket_nama, o.nama AS opd_nama,
           bp.tarif_per_bulan AS tarif
    FROM tenaga_ahli_kontrak t
    JOIN paket p ON p.id = t.paket_id
    JOIN opd o ON o.id = p.opd_id
    LEFT JOIN biaya_personel bp ON bp.paket_id = t.paket_id AND LOWER(bp.jabatan) = LOWER(t.jabatan)
    WHERE p.jenis_kontrak = 'lumpsum' AND p.status = 'terkunci'
      AND COALESCE(t.periode_mulai, p.tanggal_mulai) IS NOT NULL
      AND COALESCE(t.periode_selesai, p.tanggal_selesai) IS NOT NULL
  `).all();

  const byNik = {};
  for (const r of rows) {
    if (!byNik[r.nik]) byNik[r.nik] = [];
    byNik[r.nik].push(r);
  }

  const findings = [];
  for (const [nik, periods] of Object.entries(byNik)) {
    if (periods.length <= batas) continue;

    const events = [];
    for (const p of periods) {
      events.push({ date: dateOnly(p.periode_mulai), delta: +1, paket: p });
      events.push({ date: addDays(dateOnly(p.periode_selesai), 1), delta: -1, paket: p });
    }
    events.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return b.delta - a.delta; // +1 dulu sebelum -1 di tanggal yang sama
    });

    const active = new Set();
    let inViol = false;
    let violStart = null;
    let violSnapshot = [];

    for (const ev of events) {
      if (ev.delta > 0) active.add(ev.paket.paket_id);
      else active.delete(ev.paket.paket_id);
      const isViol = active.size > batas;

      if (isViol && !inViol) {
        inViol = true;
        violStart = ev.date;
        violSnapshot = Array.from(active);
      } else if (!isViol && inViol) {
        inViol = false;
        const violEnd = addDays(ev.date, -1);
        const hari = dayDiff(violStart, violEnd);
        findings.push({
          nik, nama: periods[0].nama,
          mulai_pelanggaran: violStart,
          selesai_pelanggaran: violEnd,
          hari_pelanggaran: hari,
          mm_pelanggaran: daysToMM(hari),
          jumlah_paket_overlap: violSnapshot.length,
          daftar_paket: violSnapshot.map(id => {
            const p = periods.find(x => x.paket_id === id);
            return { id, nama: p?.paket_nama, opd: p?.opd_nama, tarif: p?.tarif || 0 };
          }).sort((a, b) => a.tarif - b.tarif), // urut dari termurah
        });
      }
    }
    // Edge: violation extending to end of timeline (shouldn't happen with -1 events)
  }
  return findings;
}

/**
 * Untuk paket tertentu, hitung berapa MM dari setiap NIK yang harus dipotong
 * karena tumpang tindih (Uji 1) atau lumpsum overlap (Uji 2).
 *
 * Aturan attribution:
 *  - Uji 1 (tumpang tindih 2 paket): potong di paket dengan TARIF LEBIH RENDAH (per spec).
 *    Kalau tarif sama, paket dengan ID lebih besar yang dipotong (deterministic).
 *  - Uji 2 (lumpsum > batas): potong di paket dengan TARIF TERENDAH yang melewati batas.
 *
 * @returns { [nik]: { uji1Mm, uji2Mm, uji1Detail, uji2Detail } }
 */
function computeOverlapForPaket(db, paketId) {
  const result = {};

  const tt = findTumpangTindih(db);
  for (const f of tt) {
    let chargedPaketId;
    if (f.tarif_a < f.tarif_b) chargedPaketId = f.paket_a_id;
    else if (f.tarif_b < f.tarif_a) chargedPaketId = f.paket_b_id;
    else chargedPaketId = Math.max(f.paket_a_id, f.paket_b_id);

    if (chargedPaketId !== paketId) continue;
    if (!result[f.nik]) result[f.nik] = { uji1Mm: 0, uji2Mm: 0, uji1Detail: [], uji2Detail: [] };
    result[f.nik].uji1Mm += f.mm_overlap;
    result[f.nik].uji1Detail.push({
      lawan: f.paket_a_id === paketId ? f.paket_b_nama : f.paket_a_nama,
      lawan_opd: f.paket_a_id === paketId ? f.opd_b : f.opd_a,
      hari: f.hari_overlap, mm: f.mm_overlap,
      periode: `${f.overlap_start} – ${f.overlap_end}`,
    });
  }

  const ls = findLumpsumOverlap(db);
  for (const f of ls) {
    // paket termurah yang IKUT dalam violation = dipotong
    if (f.daftar_paket.length === 0) continue;
    const cheapest = f.daftar_paket[0];
    if (cheapest.id !== paketId) continue;
    if (!result[f.nik]) result[f.nik] = { uji1Mm: 0, uji2Mm: 0, uji1Detail: [], uji2Detail: [] };
    result[f.nik].uji2Mm += f.mm_pelanggaran;
    result[f.nik].uji2Detail.push({
      periode: `${f.mulai_pelanggaran} – ${f.selesai_pelanggaran}`,
      hari: f.hari_pelanggaran, mm: f.mm_pelanggaran,
      jml_paket: f.jumlah_paket_overlap,
    });
  }
  return result;
}

module.exports = {
  findTumpangTindih,
  findLumpsumOverlap,
  computeOverlapForPaket,
  daysToMM, dayDiff, addDays,
};
