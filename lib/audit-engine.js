const { getDb } = require('../db/schema');
const { getSetting, logAudit } = require('./helpers');
const { lookupTarif, computeJenjangEfektif, rankOf } = require('./sbu-lookup');
const { computeOverlapForPaket } = require('./overlap');

/**
 * Audit satu posisi personel (1 baris biaya_personel + verifikasi tenaga_ahli_aktual).
 *
 * Skenario per spec:
 *  1. Fiktif → 100% pengembalian
 *  2. Pengganti jenjang lebih rendah → (tarifKontrak - tarifSBU_jenjangPengganti) × MM
 *  3. Pengganti tidak punya SKA sesuai → (tarifKontrak - tarifSBU_jenjangEfektif) × MM
 *  4. Tumpang tindih waktu penugasan (cross-paket) → MM_overlap × tarif_paket_lower
 *  5. SKA expired selama kontrak → (tarifKontrak - tarifSBU_TanpaSKA) × MM_periode_expired
 *  6. Hari kerja aktual < kontrak → tarif × (mmKontrak - mmAktual)
 *  7. Lumpsum > batas paket → MM_overlap × tarif_paket_lower
 *
 * Stacking (Cara A — berurutan):
 *  - tarifBerhak = min(tarifKontrak, tarifSBU(jenjang_efektif))
 *  - jika SKA expired & periode signifikan → tarifBerhak diturunkan ke tarif "Tanpa Sertifikat"
 *    (untuk MVP: kalau SKA expired sebelum/sebagian besar periode, full ke Tanpa Sertifikat)
 *  - mmBerhak = min(mmKontrak, mmAktual_kehadiran)
 *  - mmBerhak -= mm_overlap_uji1 (jika paket ini yg dipotong)
 *  - mmBerhak -= mm_overlap_uji2 (jika paket ini yg dipotong)
 *  - nilaiBerhak = max(0, tarifBerhak × mmBerhak)
 *  - pengembalian = nilaiKontrak - nilaiBerhak
 *
 * Decomposition pengembalian ke skenario:
 *  - "tarif drop" portion = (tarifK - tarifB) × mmK
 *  - "mm drop" portion = tarifK × (mmK - mmB)
 *  - Sum kedua porsi (notional) > pengembalian (overcounts the joint area).
 *  - Skala porsi agar sum tepat sama dengan pengembalian aktual.
 *  - Bagi tiap porsi proporsional ke skenario penyebab di kategori itu.
 */
function auditPersonelOrang({ bp, taa, sbuTarif, hariKerjaPerBulan, ovUji1, ovUji2, ovUji1Detail, ovUji2Detail, paket }) {
  const tarifKontrak = parseFloat(bp.tarif_per_bulan);
  const mmKontrak = parseFloat(bp.mm);
  const nilaiKontrak = tarifKontrak * mmKontrak;

  // Skenario 1 — fiktif (tidak ada TA aktual sama sekali, atau status='fiktif')
  if (!taa || taa.status === 'fiktif') {
    return {
      tarifBerhak: 0, mmBerhak: 0, nilaiBerhak: 0, pengembalian: nilaiKontrak,
      temuan: [{
        skenario: '1',
        uraian: !taa
          ? `Tidak ada hasil verifikasi untuk posisi "${bp.jabatan}" → diasumsikan fiktif`
          : `Tenaga ahli fiktif / tidak ditemukan saat verifikasi lapangan`,
        nilai_kontrak: nilaiKontrak, nilai_berhak: 0, selisih: nilaiKontrak,
        dasar: 'Skenario 1 (fiktif)',
      }],
    };
  }

  // Hitung jenjang efektif aktual
  const jenjangEfektif = taa.jenjang_efektif || computeJenjangEfektif(taa) || 'Tanpa Sertifikat';
  const reqRank = rankOf(bp.jenjang_disyaratkan);
  const effRank = rankOf(jenjangEfektif);

  let tarifBerhak = tarifKontrak;
  let mmBerhak = mmKontrak;
  const breakdown = []; // {skenario, kategori: 'tarif'|'mm', drop, uraian}

  // Skenario 2 / 3 / 5 — tarif diturunkan
  // Kalau jenjang efektif < jenjang disyaratkan, tarifBerhak = tarif SBU jenjang efektif
  if (bp.jenjang_disyaratkan && reqRank > effRank && sbuTarif != null && sbuTarif < tarifBerhak) {
    const drop = tarifBerhak - sbuTarif;
    tarifBerhak = sbuTarif;
    const isPengganti = taa.status === 'pengganti';
    const skenario = isPengganti ? '2' : (taa.no_ska ? '3' : '5');
    let uraian;
    if (isPengganti && jenjangEfektif !== 'Tanpa Sertifikat') {
      uraian = `Pengganti dengan jenjang ${jenjangEfektif} (kontrak syarat ${bp.jenjang_disyaratkan}). Tarif disesuaikan ke SBU.`;
    } else if (!taa.no_ska && !taa.no_skk) {
      uraian = `Tidak punya SKA/SKK (jenjang efektif ${jenjangEfektif}). Tarif disesuaikan ke SBU jenjang ${jenjangEfektif}.`;
    } else {
      uraian = `Sertifikasi tidak sesuai jenjang disyaratkan (efektif ${jenjangEfektif} vs syarat ${bp.jenjang_disyaratkan}). Tarif disesuaikan ke SBU.`;
    }
    breakdown.push({ skenario, kategori: 'tarif', drop, uraian, dasar: `Skenario ${skenario}` });
  }

  // Skenario 5 — SKA expired (kalau ada masa berlaku & habis sebelum/selama kontrak)
  if (taa.masa_berlaku_ska && paket?.tanggal_selesai) {
    const masaSka = new Date(taa.masa_berlaku_ska);
    const tglSelesai = new Date(paket.tanggal_selesai);
    const tglMulai = paket.tanggal_mulai ? new Date(paket.tanggal_mulai) : null;
    if (masaSka < tglSelesai) {
      // SKA expired sebelum/selama kontrak — kasus sederhana: kalau expired SEBELUM mulai, treat as no SKA full
      // kalau expired DI TENGAH, hitung porsi periode expired (disederhanakan: pakai porsi MM proporsional)
      let porsiExpired;
      if (tglMulai && masaSka < tglMulai) {
        porsiExpired = 1.0; // expired sebelum mulai
      } else if (tglMulai) {
        const totalDays = (tglSelesai - tglMulai) / 86400000 + 1;
        const expiredDays = (tglSelesai - masaSka) / 86400000;
        porsiExpired = Math.max(0, Math.min(1, expiredDays / totalDays));
      } else {
        porsiExpired = 0.5; // default kalau gak ada tgl mulai
      }
      // Tarif "Tanpa Sertifikat" untuk porsi expired
      // Untuk MVP: kalau SBU < tarifBerhak sekarang, drop tambahan
      // Skip kalau sudah ditangani skenario 3 di atas (no_ska kosong)
      if (taa.no_ska && porsiExpired > 0.05) {
        // Hitung tarif Tanpa Sertifikat
        const tarifTanpa = lookupTarif({
          jenjang_keahlian: 'Tanpa Sertifikat',
          jenjang_pendidikan: taa.pendidikan_jenjang,
          tahun: paket.tahun_anggaran,
        }) || 0;
        // Effective tarif drop dari tarifBerhak ke "tanpa SKA selama porsi expired"
        const blendedTarif = tarifBerhak * (1 - porsiExpired) + tarifTanpa * porsiExpired;
        if (blendedTarif < tarifBerhak) {
          const drop = tarifBerhak - blendedTarif;
          tarifBerhak = blendedTarif;
          breakdown.push({
            skenario: '5', kategori: 'tarif', drop,
            uraian: `SKA expired ${taa.masa_berlaku_ska} (${(porsiExpired*100).toFixed(0)}% periode kontrak). Tarif diblend dengan Tanpa Sertifikat.`,
            dasar: 'Skenario 5 (SKA expired)',
          });
        }
      }
    }
  }

  // Skenario 6 — kehadiran aktual
  if (taa.hari_kerja_aktual != null && taa.hari_kerja_aktual >= 0) {
    const mmAktual = parseFloat(taa.hari_kerja_aktual) / hariKerjaPerBulan;
    if (mmAktual < mmBerhak) {
      const drop = mmBerhak - mmAktual;
      mmBerhak = mmAktual;
      breakdown.push({
        skenario: '6', kategori: 'mm', drop,
        uraian: `Kehadiran aktual ${taa.hari_kerja_aktual} hari (${mmAktual.toFixed(2)} MM) < kontrak ${mmKontrak} MM. Selisih ${drop.toFixed(2)} MM.`,
        dasar: 'Skenario 6 (kehadiran)',
      });
    }
  }

  // Skenario 4 — tumpang tindih waktu penugasan (lintas paket)
  if (ovUji1 > 0) {
    const drop = Math.min(mmBerhak, ovUji1);
    mmBerhak -= drop;
    const detailStr = (ovUji1Detail || []).map(d => `${d.lawan} (${d.opd}, ${d.periode}, ${d.mm.toFixed(2)} MM)`).join('; ');
    breakdown.push({
      skenario: '4', kategori: 'mm', drop,
      uraian: `Tumpang tindih waktu penugasan ${ovUji1.toFixed(2)} MM dengan paket lain: ${detailStr}`,
      dasar: 'Skenario 4 (tumpang tindih)',
    });
  }

  // Skenario 7 — lumpsum > batas
  if (ovUji2 > 0) {
    const drop = Math.min(mmBerhak, ovUji2);
    mmBerhak -= drop;
    const detailStr = (ovUji2Detail || []).map(d => `${d.periode} (${d.jml_paket} paket overlap, ${d.mm.toFixed(2)} MM)`).join('; ');
    breakdown.push({
      skenario: '7', kategori: 'mm', drop,
      uraian: `Lumpsum melewati batas paket bersamaan, paket termurah dipotong ${ovUji2.toFixed(2)} MM: ${detailStr}`,
      dasar: 'Skenario 7 (lumpsum > batas)',
    });
  }

  if (mmBerhak < 0) mmBerhak = 0;
  const nilaiBerhak = tarifBerhak * mmBerhak;
  const pengembalian = nilaiKontrak - nilaiBerhak;

  if (pengembalian <= 0.5 || breakdown.length === 0) {
    return { tarifBerhak, mmBerhak, nilaiBerhak, pengembalian: 0, temuan: [] };
  }

  // Decompose ke temuan
  const tarifDrop = tarifKontrak - tarifBerhak;
  const mmDrop = mmKontrak - mmBerhak;
  // Notional contributions:
  const notionalTarif = tarifDrop * mmKontrak;
  const notionalMm = tarifKontrak * mmDrop;
  const notionalSum = notionalTarif + notionalMm;

  let actualTarifPortion = notionalSum > 0 ? pengembalian * (notionalTarif / notionalSum) : 0;
  let actualMmPortion = notionalSum > 0 ? pengembalian * (notionalMm / notionalSum) : 0;

  const tarifItems = breakdown.filter(b => b.kategori === 'tarif');
  const mmItems = breakdown.filter(b => b.kategori === 'mm');

  const tarifDropSum = tarifItems.reduce((s, b) => s + b.drop, 0);
  const mmDropSum = mmItems.reduce((s, b) => s + b.drop, 0);

  const temuan = [];
  for (const it of tarifItems) {
    const share = tarifDropSum > 0 ? actualTarifPortion * (it.drop / tarifDropSum) : 0;
    temuan.push({
      skenario: it.skenario, uraian: it.uraian, dasar: it.dasar,
      nilai_kontrak: nilaiKontrak, nilai_berhak: nilaiBerhak,
      selisih: Math.round(share),
    });
  }
  for (const it of mmItems) {
    const share = mmDropSum > 0 ? actualMmPortion * (it.drop / mmDropSum) : 0;
    temuan.push({
      skenario: it.skenario, uraian: it.uraian, dasar: it.dasar,
      nilai_kontrak: nilaiKontrak, nilai_berhak: nilaiBerhak,
      selisih: Math.round(share),
    });
  }

  // Adjust last item to absorb rounding so sum tepat = pengembalian
  const sumSelisih = temuan.reduce((s, t) => s + t.selisih, 0);
  const pengR = Math.round(pengembalian);
  if (temuan.length > 0 && sumSelisih !== pengR) {
    temuan[temuan.length - 1].selisih += (pengR - sumSelisih);
  }

  return { tarifBerhak, mmBerhak, nilaiBerhak, pengembalian, temuan };
}

/**
 * Audit satu item non-personel.
 *  N1 — tidak_ada → 100% pengembalian
 *  N2 — kurang   → (vol - vol_aktual) × harga
 *  N4 — mark_up  → (harga - harga_bukti) × vol
 *  N5 — fiktif   → 100% pengembalian
 */
function auditNonPersonel({ bnp, verif }) {
  const nilaiKontrak = parseFloat(bnp.volume) * parseFloat(bnp.harga_satuan);
  if (!verif) return null; // belum diverifikasi → skip
  if (verif.status_realisasi === 'sesuai') return null;

  if (verif.status_realisasi === 'tidak_ada') {
    return {
      skenario: 'N1', nilai_kontrak: nilaiKontrak, nilai_berhak: 0, selisih: nilaiKontrak,
      uraian: `Realisasi tidak ada untuk item "${bnp.uraian}".`,
      dasar: 'Skenario N1 (tidak ada realisasi)',
    };
  }
  if (verif.status_realisasi === 'fiktif') {
    return {
      skenario: 'N5', nilai_kontrak: nilaiKontrak, nilai_berhak: 0, selisih: nilaiKontrak,
      uraian: `Item "${bnp.uraian}" fiktif (bukti tidak sah).`,
      dasar: 'Skenario N5 (fiktif)',
    };
  }
  if (verif.status_realisasi === 'kurang') {
    const volA = parseFloat(verif.volume_aktual || 0);
    const nilaiBerhak = volA * parseFloat(bnp.harga_satuan);
    return {
      skenario: 'N2', nilai_kontrak: nilaiKontrak, nilai_berhak: nilaiBerhak, selisih: nilaiKontrak - nilaiBerhak,
      uraian: `Volume aktual ${volA} ${bnp.satuan || ''} (kontrak ${bnp.volume}). Selisih ${(bnp.volume - volA).toFixed(2)}.`,
      dasar: 'Skenario N2 (kurang volume)',
    };
  }
  if (verif.status_realisasi === 'mark_up') {
    const hargaA = parseFloat(verif.harga_bukti_sah || 0);
    const nilaiBerhak = parseFloat(bnp.volume) * hargaA;
    return {
      skenario: 'N4', nilai_kontrak: nilaiKontrak, nilai_berhak: nilaiBerhak, selisih: nilaiKontrak - nilaiBerhak,
      uraian: `Harga bukti sah Rp ${hargaA.toLocaleString('id-ID')}, kontrak Rp ${parseFloat(bnp.harga_satuan).toLocaleString('id-ID')} (markup).`,
      dasar: 'Skenario N4 (mark-up)',
    };
  }
  return null;
}

/**
 * Run audit untuk satu paket. Lock paket → hitung temuan personel & non-personel → simpan.
 * Cross-paket (Uji 1 & 2) di-recompute juga.
 */
function runPaketAudit(paketId) {
  const db = getDb();
  const paket = db.prepare('SELECT * FROM paket WHERE id = ?').get(paketId);
  if (!paket) throw new Error('Paket tidak ditemukan');
  if (paket.status !== 'lengkap' && paket.status !== 'terkunci') {
    throw new Error('Paket harus berstatus "lengkap" sebelum dikunci & diaudit');
  }

  const tahun = paket.tahun_anggaran || parseInt(getSetting('tahun_anggaran_aktif', '2025'), 10);
  const hpb = parseFloat(getSetting('hari_kerja_per_bulan', '22'));

  const tx = db.transaction(() => {
    // Lock paket dulu (biar masuk ke filter cross-paket)
    if (paket.status !== 'terkunci') {
      db.prepare(`UPDATE paket SET status = 'terkunci', locked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(paketId);
    }

    // Clear temuan paket ini (semua jenis kecuali lintas yang akan dihitung ulang global)
    db.prepare(`DELETE FROM temuan WHERE paket_id = ?`).run(paketId);

    // Re-compute lintas dulu — biar paket yang baru dikunci ikut
    recomputeLintas(db);

    // Hitung overlap untuk paket ini (read dari hasil lintas)
    const overlapByNik = computeOverlapForPaket(db, paketId);

    // Audit personel
    const biayaPersonel = db.prepare('SELECT * FROM biaya_personel WHERE paket_id = ?').all(paketId);
    const taAktualByBp = {};
    const taAktualNoLink = [];
    for (const t of db.prepare('SELECT * FROM tenaga_ahli_aktual WHERE paket_id = ?').all(paketId)) {
      if (t.biaya_personel_id) taAktualByBp[t.biaya_personel_id] = t;
      else taAktualNoLink.push(t);
    }

    const insertTemuan = db.prepare(`
      INSERT INTO temuan(paket_id, jenis, skenario, ref_id, nama_subjek, nik_subjek,
        nilai_kontrak, nilai_berhak, selisih, uraian, dasar, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalPersonel = 0, totalNonPersonel = 0;

    for (const bp of biayaPersonel) {
      const taa = taAktualByBp[bp.id];
      const jenjangEfektif = taa ? (taa.jenjang_efektif || computeJenjangEfektif(taa) || 'Tanpa Sertifikat') : 'Tanpa Sertifikat';
      const sbuTarif = lookupTarif({
        jenjang_keahlian: jenjangEfektif,
        jenjang_pendidikan: taa?.pendidikan_jenjang,
        tahun,
      });

      const ovInfo = taa?.nik ? overlapByNik[taa.nik] : null;
      const result = auditPersonelOrang({
        bp, taa, sbuTarif: sbuTarif != null ? sbuTarif : bp.tarif_per_bulan,
        hariKerjaPerBulan: hpb,
        ovUji1: ovInfo?.uji1Mm || 0,
        ovUji2: ovInfo?.uji2Mm || 0,
        ovUji1Detail: ovInfo?.uji1Detail || [],
        ovUji2Detail: ovInfo?.uji2Detail || [],
        paket,
      });

      for (const t of result.temuan) {
        insertTemuan.run(
          paketId, 'personel', t.skenario, bp.id,
          taa?.nama || `Posisi: ${bp.jabatan}`, taa?.nik || null,
          t.nilai_kontrak, t.nilai_berhak, t.selisih, t.uraian, t.dasar,
          JSON.stringify({
            biaya_personel_id: bp.id, taa_id: taa?.id || null,
            jenjang_efektif: jenjangEfektif,
            tarif_kontrak: bp.tarif_per_bulan, tarif_berhak: result.tarifBerhak,
            mm_kontrak: bp.mm, mm_berhak: result.mmBerhak,
          })
        );
        totalPersonel += t.selisih;
      }
    }

    // Audit non-personel
    const npRows = db.prepare(`
      SELECT b.*, v.status_realisasi, v.volume_aktual, v.harga_bukti_sah, v.catatan, v.catatan_pajak
      FROM biaya_non_personel b
      LEFT JOIN verifikasi_non_personel v ON v.biaya_non_personel_id = b.id
      WHERE b.paket_id = ?
    `).all(paketId);
    for (const row of npRows) {
      const verif = row.status_realisasi ? row : null;
      const t = auditNonPersonel({ bnp: row, verif });
      if (t) {
        insertTemuan.run(
          paketId, 'non_personel', t.skenario, row.id,
          row.uraian, null,
          t.nilai_kontrak, t.nilai_berhak, t.selisih, t.uraian, t.dasar,
          JSON.stringify({ biaya_non_personel_id: row.id, status: row.status_realisasi })
        );
        totalNonPersonel += t.selisih;
      }
    }

    db.prepare(`UPDATE paket SET audited_at = CURRENT_TIMESTAMP WHERE id = ?`).run(paketId);

    return { totalPersonel, totalNonPersonel, totalPengembalian: totalPersonel + totalNonPersonel };
  });

  const r = tx();
  logAudit('admin', 'lock_and_audit', 'paket', paketId, r);
  return r;
}

/**
 * Recompute lintas temuan (global, untuk semua paket terkunci).
 * Tabel temuan jenis = 'lintas_tumpang_tindih' atau 'lintas_lumpsum' di-clear, lalu re-insert.
 * Catatan: temuan lintas tidak include selisih nilai (selisih = 0), karena impact-nya sudah dihitung
 * via Skenario 4 & 7 di paket-level. Lintas temuan di sini hanya catatan / kertas kerja.
 */
function recomputeLintas(db = getDb()) {
  const { findTumpangTindih, findLumpsumOverlap } = require('./overlap');
  db.prepare(`DELETE FROM temuan WHERE jenis IN ('lintas_tumpang_tindih', 'lintas_lumpsum')`).run();
  const insertT = db.prepare(`
    INSERT INTO temuan(paket_id, jenis, skenario, ref_id, nama_subjek, nik_subjek,
      nilai_kontrak, nilai_berhak, selisih, uraian, dasar, payload_json)
    VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, 0, ?, ?, ?)
  `);
  const tt = findTumpangTindih(db);
  for (const f of tt) {
    insertT.run(
      f.paket_a_id, 'lintas_tumpang_tindih', '4',
      f.nama, f.nik,
      `Tumpang tindih dengan paket "${f.paket_b_nama}" (${f.opd_b}). Periode overlap ${f.overlap_start}–${f.overlap_end}, ${f.hari_overlap} hari (${f.mm_overlap.toFixed(2)} MM).`,
      'Uji 1 — Tumpang tindih waktu penugasan (Perlem LKPP)',
      JSON.stringify(f)
    );
  }
  const ls = findLumpsumOverlap(db);
  for (const f of ls) {
    // attach ke paket termurah yang ikut dalam violation
    const paketTerget = f.daftar_paket[0];
    if (!paketTerget) continue;
    insertT.run(
      paketTerget.id, 'lintas_lumpsum', '7',
      f.nama, f.nik,
      `Lumpsum > batas pada periode ${f.mulai_pelanggaran}–${f.selesai_pelanggaran} (${f.hari_pelanggaran} hari, ${f.mm_pelanggaran.toFixed(2)} MM). ${f.jumlah_paket_overlap} paket bersamaan.`,
      'Uji 2 — Lumpsum > batas paket bersamaan (Perlem LKPP)',
      JSON.stringify(f)
    );
  }
  return { tumpang_tindih: tt.length, lumpsum: ls.length };
}

module.exports = {
  auditPersonelOrang,
  auditNonPersonel,
  runPaketAudit,
  recomputeLintas,
};
