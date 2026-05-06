// Auto-generate hasil keterangan BAPK dari hasil audit (checklist 3 area + temuan numerik)
const { getDb } = require('../db/schema');

const STATUS_LABEL = {
  patuh: 'Patuh',
  lemah: 'Lemah/Risiko',
  tidak_patuh: 'TIDAK PATUH',
  na: 'N/A',
};

const AREA_LABEL = {
  perencanaan: 'A. AREA PERENCANAAN',
  pelaksanaan: 'B. AREA PELAKSANAAN',
  pelaporan: 'C. AREA PELAPORAN/PENYELESAIAN',
};

const SKENARIO_PERTANYAAN = {
  '1': 'Mohon dijelaskan apakah posisi {jabatan} memang tidak terisi/tidak ada orangnya, dan bagaimana mekanisme pembayaran tenaga ahli selama ini.',
  '2': 'Mohon dijelaskan dasar penggantian tenaga ahli {jabatan} dengan personel berjenjang lebih rendah, dan apakah ada persetujuan PPK secara tertulis.',
  '3': 'Mohon dijelaskan mengapa tenaga ahli {jabatan} yang dipakai tidak memiliki SKA sesuai jenjang yang disyaratkan dalam kontrak.',
  '4': 'Mohon dijelaskan terkait penugasan {nama} (NIK {nik}) yang terindikasi tumpang tindih dengan paket lain pada periode bersamaan.',
  '5': 'Mohon dijelaskan status SKA tenaga ahli {jabatan} yang masa berlakunya berakhir selama periode kontrak.',
  '6': 'Mohon dijelaskan apakah kehadiran/penugasan tenaga ahli {jabatan} memang tidak sesuai dengan man-month yang dibayarkan.',
  '7': 'Mohon dijelaskan terkait penugasan {nama} pada paket lumsum yang melebihi batas {jml} paket bersamaan menurut Perlem LKPP.',
  'N1': 'Mohon dijelaskan apakah biaya non-personel "{uraian}" memang tidak ada realisasinya.',
  'N2': 'Mohon dijelaskan mengapa volume realisasi item "{uraian}" lebih kecil dari volume kontrak.',
  'N4': 'Mohon dijelaskan dasar penetapan harga satuan item "{uraian}" yang diduga lebih tinggi dari bukti pengeluaran sah.',
  'N5': 'Mohon dijelaskan dasar pembayaran item "{uraian}" yang berdasarkan verifikasi tidak didukung bukti sah.',
};

function rupiah(n) {
  if (n == null || isNaN(n)) return 'Rp 0';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function fillTemplate(tmpl, vars) {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] || '___');
}

/**
 * Auto-generate teks hasil keterangan dari hasil audit paket.
 * Output: string multi-line yang bisa langsung jadi `hasil_keterangan` di BAPK.
 */
function buildHasilKeteranganFromAudit(paketId, opts = {}) {
  const db = getDb();
  const paket = db.prepare(`
    SELECT p.*, o.nama AS opd_nama
    FROM paket p JOIN opd o ON o.id = p.opd_id WHERE p.id = ?
  `).get(paketId);
  if (!paket) throw new Error('Paket tidak ditemukan');

  const sp2d = db.prepare('SELECT * FROM paket_sp2d WHERE paket_id = ? ORDER BY tanggal_sp2d').all(paketId);
  const temuan = db.prepare(`SELECT * FROM temuan WHERE paket_id = ? ORDER BY jenis, skenario`).all(paketId);
  const checklist = db.prepare(`
    SELECT i.area, i.kode, i.judul, i.dasar_hukum, i.indikator_patuh,
           h.status, h.catatan, h.lokasi_bukti, h.dampak_pengembalian
    FROM audit_checklist_item i
    LEFT JOIN audit_checklist_hasil h ON h.checklist_item_id = i.id AND h.paket_id = ?
    WHERE i.aktif = 1
    ORDER BY i.area, i.urutan
  `).all(paketId);

  const lines = [];

  // ==================== I. IDENTITAS PAKET ====================
  lines.push('I. IDENTITAS PAKET');
  lines.push('');
  lines.push(`   Nama Pekerjaan : ${paket.nama_pekerjaan}`);
  lines.push(`   OPD Pengelola  : ${paket.opd_nama}`);
  lines.push(`   Tahun Anggaran : ${paket.tahun_anggaran || '-'}`);
  lines.push(`   Nomor Kontrak  : ${paket.no_kontrak || '-'}`);
  lines.push(`   Jenis Kontrak  : ${paket.jenis_kontrak === 'lumpsum' ? 'Lumpsum' : (paket.jenis_kontrak === 'waktu_penugasan' ? 'Waktu Penugasan' : '-')}`);
  lines.push(`   Konsultansi    : ${paket.jenis_konsultansi || '-'}`);
  lines.push(`   Penyedia       : ${(paket.bentuk_badan || '') + ' ' + (paket.nama_penyedia || '-')}`.trim());
  lines.push(`   Nilai Paket    : ${rupiah(paket.nilai_paket)}`);
  lines.push(`   Jumlah SP2D    : ${sp2d.length}`);
  if (sp2d.length > 0) {
    lines.push('   Daftar SP2D    :');
    for (const s of sp2d) {
      lines.push(`     - ${s.no_sp2d} (${s.tanggal_sp2d || '-'}, ${rupiah(s.nilai_sp2d)})`);
    }
  }
  lines.push('');
  lines.push('');

  // ==================== II. HASIL PENGUJIAN AUDIT ====================
  lines.push('II. HASIL PENGUJIAN AUDIT KEPATUHAN');
  lines.push('');
  lines.push('Berdasarkan hasil pemeriksaan tim audit, ditemukan hal-hal sebagai berikut yang memerlukan');
  lines.push('klarifikasi/keterangan dari Saudara:');
  lines.push('');
  lines.push('');

  let nomor = 1;
  let totalDampak = 0;

  // ===== Per area checklist + temuan numerik (untuk pelaksanaan) =====
  for (const area of ['perencanaan', 'pelaksanaan', 'pelaporan']) {
    const areaItems = checklist.filter(c => c.area === area && (c.status === 'lemah' || c.status === 'tidak_patuh'));
    const numerikItems = area === 'pelaksanaan' ? temuan.filter(t => t.jenis === 'personel' || t.jenis === 'non_personel' || t.jenis.startsWith('lintas')) : [];

    if (areaItems.length === 0 && numerikItems.length === 0) {
      lines.push(AREA_LABEL[area]);
      lines.push('   Tidak ada temuan signifikan pada area ini.');
      lines.push('');
      lines.push('');
      continue;
    }

    lines.push(AREA_LABEL[area]);
    lines.push('');

    // Numerik (skenario 1-7, N1-N5) untuk pelaksanaan
    if (numerikItems.length > 0) {
      lines.push('   Pengujian Kuantitatif:');
      lines.push('');
      for (const t of numerikItems) {
        const tplKey = String(t.skenario);
        const pertanyaan = SKENARIO_PERTANYAAN[tplKey] || 'Mohon dijelaskan terkait temuan ini.';
        const vars = { jabatan: t.nama_subjek || '-', nama: t.nama_subjek || '-', nik: t.nik_subjek || '-', jml: '3', uraian: t.nama_subjek || '-' };
        lines.push(`   ${nomor}. [Skenario ${t.skenario}] ${t.uraian}`);
        if (t.dasar) lines.push(`      Dasar  : ${t.dasar}`);
        if (t.selisih > 0) {
          lines.push(`      Nilai pengembalian yang diestimasi: ${rupiah(t.selisih)}`);
          totalDampak += t.selisih;
        }
        lines.push('');
        lines.push(`      Pertanyaan kepada Saudara:`);
        lines.push(`      ${fillTemplate(pertanyaan, vars)}`);
        lines.push('');
        lines.push(`      Jawaban Saudara:`);
        lines.push(`      ........................................................................................`);
        lines.push(`      ........................................................................................`);
        lines.push(`      ........................................................................................`);
        lines.push('');
        nomor++;
      }
    }

    // Checklist (lemah / tidak patuh)
    if (areaItems.length > 0) {
      if (numerikItems.length > 0) lines.push('   Pengujian Kepatuhan Dokumen (Checklist):');
      lines.push('');
      for (const c of areaItems) {
        lines.push(`   ${nomor}. [${c.kode}] ${c.judul} — ${STATUS_LABEL[c.status]}`);
        if (c.catatan) lines.push(`      Catatan auditor: ${c.catatan}`);
        if (c.dasar_hukum) lines.push(`      Dasar hukum   : ${c.dasar_hukum}`);
        if (c.dampak_pengembalian > 0) {
          lines.push(`      Dampak rupiah : ${rupiah(c.dampak_pengembalian)}`);
          totalDampak += c.dampak_pengembalian;
        }
        if (c.lokasi_bukti) lines.push(`      Lokasi bukti  : ${c.lokasi_bukti}`);
        lines.push('');
        lines.push(`      Pertanyaan kepada Saudara:`);
        lines.push(`      Mohon dijelaskan kondisi item ${c.kode} (${c.judul}) ini, dan bagaimana langkah perbaikan/klarifikasi atas temuan tersebut.`);
        lines.push('');
        lines.push(`      Jawaban Saudara:`);
        lines.push(`      ........................................................................................`);
        lines.push(`      ........................................................................................`);
        lines.push(`      ........................................................................................`);
        lines.push('');
        nomor++;
      }
    }
    lines.push('');
  }

  // ==================== III. RINGKASAN ====================
  lines.push('III. RINGKASAN POTENSI TEMUAN');
  lines.push('');
  const cntChecklistLemah = checklist.filter(c => c.status === 'lemah').length;
  const cntChecklistTP = checklist.filter(c => c.status === 'tidak_patuh').length;
  const cntNumerik = temuan.length;
  lines.push(`   Jumlah temuan checklist tidak patuh : ${cntChecklistTP}`);
  lines.push(`   Jumlah temuan checklist lemah/risiko: ${cntChecklistLemah}`);
  lines.push(`   Jumlah temuan kuantitatif (engine)  : ${cntNumerik}`);
  lines.push(`   TOTAL POTENSI PENGEMBALIAN          : ${rupiah(totalDampak)}`);
  if (paket.nilai_paket > 0) {
    lines.push(`   Persentase dari nilai paket         : ${(totalDampak / paket.nilai_paket * 100).toFixed(2)}%`);
  }
  lines.push('');
  lines.push('');
  lines.push('Demikian Berita Acara Permintaan Keterangan ini dibuat berdasarkan hasil pengujian audit.');
  lines.push('Tanggapan dari Saudara sebagaimana tertulis di atas akan menjadi bahan pertimbangan');
  lines.push('penyusunan Laporan Hasil Pemeriksaan (LHP).');
  lines.push('');

  return lines.join('\n');
}

module.exports = { buildHasilKeteranganFromAudit };
