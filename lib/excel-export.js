const xlsx = require('xlsx');
const { getDb } = require('../db/schema');

function rupiah(n) {
  if (n == null || isNaN(n)) return '-';
  return Math.round(n);
}

function buildSheet(rows, columns, sheetName, opts = {}) {
  const data = [columns.map(c => c.header)];
  for (const r of rows) data.push(columns.map(c => (c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? ''))));
  const ws = xlsx.utils.aoa_to_sheet(data);
  if (opts.colWidths) {
    ws['!cols'] = opts.colWidths.map(w => ({ wch: w }));
  } else {
    ws['!cols'] = columns.map(() => ({ wch: 22 }));
  }
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return { ws, sheetName };
}

/**
 * Build Excel kertas kerja per paket (6 sheet sesuai spec).
 */
function exportPaketWorkpaper(paketId) {
  const db = getDb();
  const paket = db.prepare(`
    SELECT p.*, o.nama AS opd_nama, o.kode_akses
    FROM paket p JOIN opd o ON o.id = p.opd_id
    WHERE p.id = ?
  `).get(paketId);
  if (!paket) throw new Error('Paket tidak ditemukan');

  const sp2dList = db.prepare('SELECT * FROM paket_sp2d WHERE paket_id = ? ORDER BY tanggal_sp2d, no_sp2d').all(paketId);
  const taKontrak = db.prepare('SELECT * FROM tenaga_ahli_kontrak WHERE paket_id = ?').all(paketId);
  const biayaPersonel = db.prepare('SELECT * FROM biaya_personel WHERE paket_id = ?').all(paketId);
  const biayaNonPersonel = db.prepare('SELECT * FROM biaya_non_personel WHERE paket_id = ?').all(paketId);
  const checklistRows = db.prepare(`
    SELECT i.area, i.kode, i.judul, i.fokus_uji, i.bukti_minimum, i.indikator_patuh, i.red_flag, i.dasar_hukum,
           h.status, h.catatan, h.lokasi_bukti, h.dampak_pengembalian, h.dijalankan_at
    FROM audit_checklist_item i
    LEFT JOIN audit_checklist_hasil h ON h.checklist_item_id = i.id AND h.paket_id = ?
    WHERE i.aktif = 1 ORDER BY i.area, i.urutan
  `).all(paketId);
  const taAktual = db.prepare(`
    SELECT a.*, bp.jabatan AS posisi_kontrak FROM tenaga_ahli_aktual a
    LEFT JOIN biaya_personel bp ON bp.id = a.biaya_personel_id
    WHERE a.paket_id = ?
  `).all(paketId);
  const verifNp = db.prepare(`
    SELECT v.*, b.uraian, b.volume, b.harga_satuan FROM verifikasi_non_personel v
    JOIN biaya_non_personel b ON b.id = v.biaya_non_personel_id
    WHERE b.paket_id = ?
  `).all(paketId);
  const temuan = db.prepare('SELECT * FROM temuan WHERE paket_id = ? ORDER BY jenis, skenario').all(paketId);

  const wb = xlsx.utils.book_new();

  // Sheet 1: Identitas Paket + Daftar SP2D
  const identData = [
    ['IDENTITAS PAKET', ''],
    ['', ''],
    ['Nama OPD', paket.opd_nama],
    ['Kode Akses OPD', paket.kode_akses],
    ['Kode Paket', paket.nomor_paket || '-'],
    ['Nama Pekerjaan', paket.nama_pekerjaan],
    ['Total Nilai Paket', paket.nilai_paket],
    ['Total Nilai Realisasi', paket.nilai_realisasi || 0],
    ['Jumlah SP2D', sp2dList.length],
    ['Tahun Anggaran', paket.tahun_anggaran || '-'],
    ['Nomor Kontrak', paket.no_kontrak || '-'],
    ['Tanggal Kontrak', paket.tanggal_kontrak || '-'],
    ['Tanggal Mulai Pelaksanaan', paket.tanggal_mulai || '-'],
    ['Tanggal Selesai Pelaksanaan', paket.tanggal_selesai || '-'],
    ['Jenis Kontrak', paket.jenis_kontrak || '-'],
    ['Jenis Konsultansi', paket.jenis_konsultansi || '-'],
    ['Bentuk Penyedia', paket.bentuk_badan || '-'],
    ['Nama Penyedia', paket.nama_penyedia || '-'],
    ['Output Diharapkan', paket.output_diharapkan || '-'],
    ['Status', paket.status],
    ['Tanggal Kunci', paket.locked_at || '-'],
    ['Tanggal Audit', paket.audited_at || '-'],
    ['', ''],
    ['DAFTAR SP2D', ''],
    ['No SP2D', 'Tanggal | Nilai | Penerima | Keterangan'],
  ];
  for (const s of sp2dList) {
    identData.push([s.no_sp2d, `${s.tanggal_sp2d || '-'} | Rp ${(s.nilai_sp2d||0).toLocaleString('id-ID')} | ${s.nama_penerima || '-'} | ${s.keterangan || '-'}`]);
  }
  const ws1 = xlsx.utils.aoa_to_sheet(identData);
  ws1['!cols'] = [{ wch: 28 }, { wch: 80 }];
  xlsx.utils.book_append_sheet(wb, ws1, 'Identitas');

  // Sheet 2: TA Kontrak vs Aktual
  const taComparison = [];
  for (const bp of biayaPersonel) {
    const aktual = taAktual.find(a => a.biaya_personel_id === bp.id);
    const tk = taKontrak.find(t => bp.tenaga_ahli_kontrak_id === t.id) || {};
    taComparison.push({
      posisi: bp.jabatan,
      jenjang_syarat: bp.jenjang_disyaratkan || '-',
      bidang: bp.bidang || '-',
      nama_kontrak: tk.nama || '-',
      nik_kontrak: tk.nik || '-',
      periode: tk.periode_mulai ? `${tk.periode_mulai} – ${tk.periode_selesai}` : '-',
      mm_kontrak: bp.mm,
      tarif_kontrak: bp.tarif_per_bulan,
      nilai_kontrak: bp.mm * bp.tarif_per_bulan,
      nama_aktual: aktual?.nama || '(belum diverifikasi)',
      nik_aktual: aktual?.nik || '-',
      status_aktual: aktual?.status || '-',
      jenjang_efektif: aktual?.jenjang_efektif || '-',
      pendidikan: aktual?.pendidikan_jenjang || '-',
      no_ska: aktual?.no_ska || '-',
      hari_aktual: aktual?.hari_kerja_aktual ?? '-',
    });
  }
  const sh2 = buildSheet(taComparison, [
    { header: 'Posisi', key: 'posisi' },
    { header: 'Jenjang Syarat', key: 'jenjang_syarat' },
    { header: 'Bidang', key: 'bidang' },
    { header: 'Nama (Kontrak)', key: 'nama_kontrak' },
    { header: 'NIK (Kontrak)', key: 'nik_kontrak' },
    { header: 'Periode (Kontrak)', key: 'periode' },
    { header: 'MM Kontrak', key: 'mm_kontrak', fmt: v => Number(v) },
    { header: 'Tarif/Bulan', key: 'tarif_kontrak', fmt: v => Number(v) },
    { header: 'Nilai Kontrak', key: 'nilai_kontrak', fmt: v => Number(v) },
    { header: 'Nama (Aktual)', key: 'nama_aktual' },
    { header: 'NIK (Aktual)', key: 'nik_aktual' },
    { header: 'Status', key: 'status_aktual' },
    { header: 'Jenjang Efektif', key: 'jenjang_efektif' },
    { header: 'Pendidikan', key: 'pendidikan' },
    { header: 'No SKA', key: 'no_ska' },
    { header: 'Hari Kerja Aktual', key: 'hari_aktual' },
  ], 'TA Kontrak vs Aktual', { colWidths: [22, 14, 18, 24, 18, 22, 10, 14, 16, 24, 18, 12, 14, 12, 18, 14] });
  xlsx.utils.book_append_sheet(wb, sh2.ws, sh2.sheetName);

  // Sheet 3: KK Pengembalian Personel (per orang × per skenario)
  const kkPersonel = temuan.filter(t => t.jenis === 'personel').map(t => {
    const payload = t.payload_json ? JSON.parse(t.payload_json) : {};
    return {
      skenario: 'Skenario ' + t.skenario,
      nama: t.nama_subjek,
      nik: t.nik_subjek || '-',
      jenjang_efektif: payload.jenjang_efektif || '-',
      tarif_kontrak: payload.tarif_kontrak || 0,
      tarif_berhak: payload.tarif_berhak || 0,
      mm_kontrak: payload.mm_kontrak || 0,
      mm_berhak: payload.mm_berhak || 0,
      nilai_kontrak: t.nilai_kontrak,
      nilai_berhak: t.nilai_berhak,
      pengembalian: t.selisih,
      uraian: t.uraian,
      dasar: t.dasar || '-',
    };
  });
  const sh3 = buildSheet(kkPersonel, [
    { header: 'Skenario', key: 'skenario' },
    { header: 'Nama', key: 'nama' },
    { header: 'NIK', key: 'nik' },
    { header: 'Jenjang Efektif', key: 'jenjang_efektif' },
    { header: 'Tarif Kontrak', key: 'tarif_kontrak', fmt: v => Number(v) },
    { header: 'Tarif Berhak', key: 'tarif_berhak', fmt: v => Number(v) },
    { header: 'MM Kontrak', key: 'mm_kontrak', fmt: v => Number(v) },
    { header: 'MM Berhak', key: 'mm_berhak', fmt: v => Number(v) },
    { header: 'Nilai Kontrak', key: 'nilai_kontrak', fmt: v => Number(v) },
    { header: 'Nilai Berhak', key: 'nilai_berhak', fmt: v => Number(v) },
    { header: 'Pengembalian', key: 'pengembalian', fmt: v => Number(v) },
    { header: 'Uraian', key: 'uraian' },
    { header: 'Dasar', key: 'dasar' },
  ], 'KK Personel', { colWidths: [16, 24, 18, 16, 14, 14, 10, 10, 16, 16, 16, 60, 30] });
  xlsx.utils.book_append_sheet(wb, sh3.ws, sh3.sheetName);

  // Sheet 4: KK Non-Personel
  const kkNp = temuan.filter(t => t.jenis === 'non_personel').map(t => ({
    skenario: 'Skenario ' + t.skenario,
    item: t.nama_subjek,
    nilai_kontrak: t.nilai_kontrak,
    nilai_berhak: t.nilai_berhak,
    pengembalian: t.selisih,
    uraian: t.uraian,
    dasar: t.dasar || '-',
  }));
  const sh4 = buildSheet(kkNp, [
    { header: 'Skenario', key: 'skenario' },
    { header: 'Item', key: 'item' },
    { header: 'Nilai Kontrak', key: 'nilai_kontrak', fmt: v => Number(v) },
    { header: 'Nilai Berhak', key: 'nilai_berhak', fmt: v => Number(v) },
    { header: 'Pengembalian', key: 'pengembalian', fmt: v => Number(v) },
    { header: 'Uraian', key: 'uraian' },
    { header: 'Dasar', key: 'dasar' },
  ], 'KK Non-Personel', { colWidths: [16, 30, 16, 16, 16, 60, 30] });
  xlsx.utils.book_append_sheet(wb, sh4.ws, sh4.sheetName);

  // Sheet 5: Hasil Uji Lintas
  const lintas = temuan.filter(t => t.jenis === 'lintas_tumpang_tindih' || t.jenis === 'lintas_lumpsum').map(t => ({
    jenis: t.jenis === 'lintas_tumpang_tindih' ? 'Uji 1 (Tumpang Tindih)' : 'Uji 2 (Lumpsum > batas)',
    skenario: t.skenario,
    nama: t.nama_subjek,
    nik: t.nik_subjek,
    uraian: t.uraian,
    dasar: t.dasar,
  }));
  const sh5 = buildSheet(lintas, [
    { header: 'Jenis', key: 'jenis' },
    { header: 'Skenario', key: 'skenario' },
    { header: 'Nama', key: 'nama' },
    { header: 'NIK', key: 'nik' },
    { header: 'Uraian', key: 'uraian' },
    { header: 'Dasar Hukum', key: 'dasar' },
  ], 'Lintas Paket', { colWidths: [22, 12, 24, 18, 80, 40] });
  xlsx.utils.book_append_sheet(wb, sh5.ws, sh5.sheetName);

  // Sheet: Checklist 3 Area (Perencanaan, Pelaksanaan, Pelaporan)
  const STATUS_LABEL = { patuh: 'Patuh', lemah: 'Lemah/Risiko', tidak_patuh: 'Tidak Patuh', na: 'N/A' };
  for (const area of ['perencanaan','pelaksanaan','pelaporan']) {
    const rows = checklistRows.filter(r => r.area === area).map(r => ({
      kode: r.kode,
      judul: r.judul,
      fokus_uji: r.fokus_uji,
      status: r.status ? STATUS_LABEL[r.status] : '— Belum Dinilai',
      lokasi_bukti: r.lokasi_bukti || '-',
      dampak: r.dampak_pengembalian || 0,
      catatan: r.catatan || '-',
      bukti_minimum: r.bukti_minimum,
      indikator_patuh: r.indikator_patuh,
      red_flag: r.red_flag,
      dasar_hukum: r.dasar_hukum,
      dijalankan_at: r.dijalankan_at || '-',
    }));
    const sheetName = area === 'perencanaan' ? 'KK Perencanaan' : (area === 'pelaksanaan' ? 'KK Pelaksanaan (Checklist)' : 'KK Pelaporan');
    const sh = buildSheet(rows, [
      { header: 'Kode', key: 'kode' },
      { header: 'Item Uji', key: 'judul' },
      { header: 'Fokus Pemeriksaan', key: 'fokus_uji' },
      { header: 'Status', key: 'status' },
      { header: 'Lokasi/Referensi Bukti', key: 'lokasi_bukti' },
      { header: 'Dampak Rupiah', key: 'dampak', fmt: v => Number(v) },
      { header: 'Catatan Auditor', key: 'catatan' },
      { header: 'Bukti Minimum', key: 'bukti_minimum' },
      { header: 'Indikator Patuh', key: 'indikator_patuh' },
      { header: 'Red Flag', key: 'red_flag' },
      { header: 'Dasar Hukum', key: 'dasar_hukum' },
      { header: 'Tgl Penilaian', key: 'dijalankan_at' },
    ], sheetName, { colWidths: [8, 32, 50, 18, 30, 16, 50, 40, 40, 40, 40, 18] });
    xlsx.utils.book_append_sheet(wb, sh.ws, sh.sheetName);
  }

  // Sheet 6: Ringkasan Eksekutif
  const totalP = kkPersonel.reduce((s, t) => s + (t.pengembalian || 0), 0);
  const totalNp = kkNp.reduce((s, t) => s + (t.pengembalian || 0), 0);
  const checklistByArea = (a) => checklistRows.filter(r => r.area === a);
  const summary = (a) => {
    const rows = checklistByArea(a);
    return {
      total: rows.length,
      patuh: rows.filter(r => r.status === 'patuh').length,
      lemah: rows.filter(r => r.status === 'lemah').length,
      tidak_patuh: rows.filter(r => r.status === 'tidak_patuh').length,
      na: rows.filter(r => r.status === 'na').length,
      belum: rows.filter(r => !r.status).length,
      dampak: rows.reduce((s, r) => s + (r.dampak_pengembalian || 0), 0),
    };
  };
  const sP = summary('perencanaan'), sL = summary('pelaksanaan'), sR = summary('pelaporan');
  const totalDampakChecklist = sP.dampak + sL.dampak + sR.dampak;
  const totalPengembalianAll = totalP + totalNp + totalDampakChecklist;
  const ringkasan = [
    ['RINGKASAN EKSEKUTIF AUDIT KEPATUHAN', ''],
    ['', ''],
    ['Nama OPD', paket.opd_nama],
    ['Nama Paket', paket.nama_pekerjaan],
    ['Nilai Paket', paket.nilai_paket],
    ['Status', paket.status],
    ['', ''],
    ['── PENGUJIAN KUANTITATIF PELAKSANAAN ──', ''],
    ['Pengembalian Personel (Skenario 1-7)', totalP],
    ['Pengembalian Non-Personel (N1-N5)', totalNp],
    ['Subtotal Numerik', totalP + totalNp],
    ['', ''],
    ['── KEPATUHAN CHECKLIST 3 AREA ──', ''],
    ['', 'Patuh / Lemah / Tidak Patuh / N/A / Belum | Dampak Rp'],
    ['Perencanaan (P01-P08)', `${sP.patuh} / ${sP.lemah} / ${sP.tidak_patuh} / ${sP.na} / ${sP.belum} | Rp ${sP.dampak.toLocaleString('id-ID')}`],
    ['Pelaksanaan (L01-L08)', `${sL.patuh} / ${sL.lemah} / ${sL.tidak_patuh} / ${sL.na} / ${sL.belum} | Rp ${sL.dampak.toLocaleString('id-ID')}`],
    ['Pelaporan (R01-R08)', `${sR.patuh} / ${sR.lemah} / ${sR.tidak_patuh} / ${sR.na} / ${sR.belum} | Rp ${sR.dampak.toLocaleString('id-ID')}`],
    ['Subtotal Dampak Checklist', totalDampakChecklist],
    ['', ''],
    ['═══════════════════════════════════════', ''],
    ['TOTAL PENGEMBALIAN (Numerik + Checklist)', totalPengembalianAll],
    ['% Pengembalian dari Nilai Paket', paket.nilai_paket ? `${(totalPengembalianAll / paket.nilai_paket * 100).toFixed(2)}%` : '-'],
    ['', ''],
    ['Tanggal Audit', paket.audited_at || '-'],
    ['Tanggal Kunci Paket', paket.locked_at || '-'],
  ];
  const ws6 = xlsx.utils.aoa_to_sheet(ringkasan);
  ws6['!cols'] = [{ wch: 42 }, { wch: 60 }];
  xlsx.utils.book_append_sheet(wb, ws6, 'Ringkasan Eksekutif');

  return { wb, paket };
}

/**
 * Build Excel rekap lintas paket (5 sheet sesuai spec).
 */
function exportRekap() {
  const db = getDb();
  const wb = xlsx.utils.book_new();

  // Sheet 1: Rekap per paket
  const paketList = db.prepare(`
    SELECT p.*, o.nama AS opd_nama,
      (SELECT COUNT(*) FROM paket_sp2d WHERE paket_id = p.id) AS jml_sp2d,
      (SELECT COALESCE(SUM(selisih),0) FROM temuan WHERE paket_id = p.id AND jenis = 'personel') AS total_personel,
      (SELECT COALESCE(SUM(selisih),0) FROM temuan WHERE paket_id = p.id AND jenis = 'non_personel') AS total_np,
      (SELECT COALESCE(SUM(selisih),0) FROM temuan WHERE paket_id = p.id) AS total_temuan
    FROM paket p JOIN opd o ON o.id = p.opd_id
    ORDER BY o.nama, p.nama_pekerjaan
  `).all();
  const sh1 = buildSheet(paketList, [
    { header: 'OPD', key: 'opd_nama' },
    { header: 'Kode Paket', key: 'nomor_paket' },
    { header: 'Nama Pekerjaan', key: 'nama_pekerjaan' },
    { header: 'Jml SP2D', key: 'jml_sp2d', fmt: v => Number(v) || 0 },
    { header: 'TA', key: 'tahun_anggaran' },
    { header: 'Jenis Kontrak', key: 'jenis_kontrak' },
    { header: 'Nilai Paket', key: 'nilai_paket', fmt: v => Number(v) },
    { header: 'Status', key: 'status' },
    { header: 'Tot Personel', key: 'total_personel', fmt: v => Number(v) },
    { header: 'Tot Non-Personel', key: 'total_np', fmt: v => Number(v) },
    { header: 'Total Temuan', key: 'total_temuan', fmt: v => Number(v) },
  ], 'Rekap Per Paket', { colWidths: [28, 14, 36, 10, 8, 16, 18, 12, 16, 16, 16] });
  xlsx.utils.book_append_sheet(wb, sh1.ws, sh1.sheetName);

  // Sheet 2: Rekap per OPD
  const opdRekap = db.prepare(`
    SELECT o.nama AS opd_nama,
      COUNT(p.id) AS jml_paket,
      COALESCE(SUM(p.nilai_paket), 0) AS total_nilai,
      COALESCE(SUM((SELECT COALESCE(SUM(selisih),0) FROM temuan WHERE paket_id = p.id)), 0) AS total_temuan
    FROM opd o LEFT JOIN paket p ON p.opd_id = o.id
    GROUP BY o.id, o.nama
    ORDER BY total_temuan DESC
  `).all();
  const sh2 = buildSheet(opdRekap, [
    { header: 'OPD', key: 'opd_nama' },
    { header: 'Jml Paket', key: 'jml_paket' },
    { header: 'Total Nilai Kontrak', key: 'total_nilai', fmt: v => Number(v) },
    { header: 'Total Temuan', key: 'total_temuan', fmt: v => Number(v) },
  ], 'Rekap Per OPD', { colWidths: [32, 12, 22, 22] });
  xlsx.utils.book_append_sheet(wb, sh2.ws, sh2.sheetName);

  // Sheet 3 & 4: Tumpang Tindih + Lumpsum
  const { findTumpangTindih, findLumpsumOverlap } = require('./overlap');
  const tt = findTumpangTindih(db);
  const sh3 = buildSheet(tt, [
    { header: 'NIK', key: 'nik' },
    { header: 'Nama', key: 'nama' },
    { header: 'OPD A', key: 'opd_a' },
    { header: 'Paket A', key: 'paket_a_nama' },
    { header: 'Tarif A', key: 'tarif_a', fmt: v => Number(v) },
    { header: 'OPD B', key: 'opd_b' },
    { header: 'Paket B', key: 'paket_b_nama' },
    { header: 'Tarif B', key: 'tarif_b', fmt: v => Number(v) },
    { header: 'Overlap Mulai', key: 'overlap_start' },
    { header: 'Overlap Selesai', key: 'overlap_end' },
    { header: 'Hari', key: 'hari_overlap' },
    { header: 'MM', key: 'mm_overlap', fmt: v => Number(v).toFixed(2) },
  ], 'Uji 1 - Tumpang Tindih', { colWidths: [18, 26, 24, 28, 14, 24, 28, 14, 14, 14, 8, 8] });
  xlsx.utils.book_append_sheet(wb, sh3.ws, sh3.sheetName);

  const ls = findLumpsumOverlap(db);
  const lsFlat = ls.map(f => ({
    nik: f.nik,
    nama: f.nama,
    mulai: f.mulai_pelanggaran,
    selesai: f.selesai_pelanggaran,
    hari: f.hari_pelanggaran,
    mm: f.mm_pelanggaran,
    jml_paket: f.jumlah_paket_overlap,
    paket_termurah: f.daftar_paket[0]?.nama,
    daftar: f.daftar_paket.map(p => `${p.nama} (${p.opd}, Rp ${(p.tarif||0).toLocaleString('id-ID')})`).join(' | '),
  }));
  const sh4 = buildSheet(lsFlat, [
    { header: 'NIK', key: 'nik' },
    { header: 'Nama', key: 'nama' },
    { header: 'Mulai', key: 'mulai' },
    { header: 'Selesai', key: 'selesai' },
    { header: 'Hari', key: 'hari' },
    { header: 'MM', key: 'mm', fmt: v => Number(v).toFixed(2) },
    { header: 'Jml Paket Overlap', key: 'jml_paket' },
    { header: 'Paket Termurah (dipotong)', key: 'paket_termurah' },
    { header: 'Daftar Paket', key: 'daftar' },
  ], 'Uji 2 - Lumpsum > Batas', { colWidths: [18, 26, 12, 12, 8, 8, 14, 30, 80] });
  xlsx.utils.book_append_sheet(wb, sh4.ws, sh4.sheetName);

  // Sheet 5: Ringkasan Eksekutif
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM opd) AS total_opd,
      (SELECT COUNT(*) FROM paket) AS total_paket,
      (SELECT COUNT(*) FROM paket WHERE status = 'terkunci') AS total_audited,
      (SELECT COALESCE(SUM(nilai_paket), 0) FROM paket) AS total_nilai,
      (SELECT COALESCE(SUM(selisih), 0) FROM temuan) AS total_pengembalian
  `).get();
  const topOpd = opdRekap.slice(0, 10);
  const ringkasanData = [
    ['RINGKASAN EKSEKUTIF', ''],
    ['', ''],
    ['Total OPD', totals.total_opd],
    ['Total Paket', totals.total_paket],
    ['Paket Terkunci', totals.total_audited],
    ['Total Nilai Kontrak', totals.total_nilai],
    ['Total Pengembalian', totals.total_pengembalian],
    ['% Pengembalian', totals.total_nilai ? `${(totals.total_pengembalian/totals.total_nilai*100).toFixed(2)}%` : '-'],
    ['', ''],
    ['TOP 10 OPD by Temuan', ''],
    ...topOpd.map((o, i) => [`${i+1}. ${o.opd_nama}`, o.total_temuan]),
  ];
  const ws5 = xlsx.utils.aoa_to_sheet(ringkasanData);
  ws5['!cols'] = [{ wch: 36 }, { wch: 22 }];
  xlsx.utils.book_append_sheet(wb, ws5, 'Ringkasan Eksekutif');

  return { wb };
}

module.exports = { exportPaketWorkpaper, exportRekap };
