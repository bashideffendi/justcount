// Parser Excel SP2D — handle format real (11 kolom: No, Nama SKPD, Jenis Akun, ...)
// dan format simple lama (5 kolom: Nama OPD, Nama Pekerjaan, ...)

const BULAN_ID = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, agu: 8, agust: 8,
  sep: 9, okt: 10, nov: 11, des: 12,
};

function parseTanggalIndo(s) {
  if (!s) return null;
  if (s instanceof Date) return s.toISOString().slice(0, 10);
  s = String(s).trim();
  // ISO format already?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // "26 Maret 2025" / "1 Jan 2025"
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthName = m[2].toLowerCase();
    const year = parseInt(m[3], 10);
    const month = BULAN_ID[monthName];
    if (month) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // "26/03/2025" or "26-03-2025"
  const m2 = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  // Excel serial date? (already converted by xlsx with cellDates: true biasanya)
  const num = parseFloat(s);
  if (!isNaN(num) && num > 30000 && num < 60000) {
    const d = new Date(Math.round((num - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function parseNilai(s) {
  if (s == null || s === '') return NaN;
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(/,/g, '.'));
}

function normalizeJenisKonsultansi(s) {
  if (!s) return null;
  const v = String(s).toLowerCase().trim();
  if (v === 'perencanaan') return 'perencanaan';
  if (v === 'pengawasan') return 'pengawasan';
  if (/perencanaan\s*\/\s*pengawasan/.test(v) || /pengawasan\s*\/\s*perencanaan/.test(v)) return 'gabungan';
  if (/non\s*konstruksi/.test(v)) return 'non_konstruksi';
  return null;
}

/**
 * Heuristic ekstrak bentuk badan + nama penyedia dari string penerima SP2D.
 * Contoh:
 *   "AHMAD NAJIBUL HOERI CV. BINTANG MAS CONSULTANT" → CV, "Bintang Mas Consultant"
 *   "SUBHAN AFFANDI, KONSULTAN PERORANGAN" → Perorangan, "Subhan Affandi"
 *   "ABD. HOLID MUBEROK / CV RISQI ALAM KONSULTAN" → CV, "Risqi Alam Konsultan"
 */
function parsePenerima(s) {
  if (!s) return { bentuk_badan: null, nama_penyedia: null };
  const raw = String(s).trim();
  const upper = raw.toUpperCase();

  if (/PERORANGAN/.test(upper)) {
    // Ambil bagian sebelum koma atau "KONSULTAN PERORANGAN"
    const m = raw.split(/[,/]/)[0].trim();
    return { bentuk_badan: 'Perorangan', nama_penyedia: titleCase(m) };
  }
  // CV / PT — cari posisi pertama
  const cvMatch = raw.match(/\bC\.?V\.?\s+([^,/]+)$/i);
  if (cvMatch) return { bentuk_badan: 'CV', nama_penyedia: titleCase(cvMatch[1].trim()) };
  const ptMatch = raw.match(/\bP\.?T\.?\s+([^,/]+)$/i);
  if (ptMatch) return { bentuk_badan: 'PT', nama_penyedia: titleCase(ptMatch[1].trim()) };
  return { bentuk_badan: null, nama_penyedia: null };
}

function titleCase(s) {
  if (!s) return s;
  return String(s).toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bCv\b/g, 'CV').replace(/\bPt\b/g, 'PT').replace(/\bDed\b/g, 'DED');
}

/**
 * Resolve column mapping. Support both new format (11 col) dan format simple lama (5 col).
 */
function detectColumns(headers) {
  const map = {};
  const norm = h => String(h).toLowerCase().trim();
  for (const h of headers) {
    const n = norm(h);
    // OPD
    if (n === 'nama opd' || n === 'opd' || n === 'nama skpd' || n === 'skpd') map.opd = h;
    // Nama Pekerjaan / Keterangan Dokumen
    else if (n === 'nama pekerjaan' || n === 'pekerjaan' || n === 'keterangan dokumen' || n === 'keterangan' || n === 'uraian') map.pekerjaan = h;
    // SP2D
    else if (n === 'nomor sp2d' || n === 'no sp2d' || n === 'no. sp2d' || n === 'sp2d') map.no_sp2d = h;
    // Nilai
    else if (n === 'nilai sp2d' || n === 'nilai paket' || n === 'nilai') map.nilai = h;
    else if (n === 'nilai realisasi' || n === 'realisasi') map.nilai_realisasi = h;
    // Tahun
    else if (n === 'tahun anggaran' || n === 'tahun') map.tahun = h;
    // Tanggal SP2D
    else if (n === 'tanggal sp2d' || n === 'tgl sp2d' || n === 'tanggal') map.tanggal_sp2d = h;
    // Jenis konsultansi
    else if (n === 'jenis' || n === 'jenis konsultansi') map.jenis_konsultansi = h;
    // Jenis akun & rekening
    else if (n === 'jenis akun' || n === 'akun') map.jenis_akun = h;
    else if (n === 'nama rekening' || n === 'rekening') map.nama_rekening = h;
    // Penerima
    else if (n === 'nama pnerima' || n === 'nama penerima' || n === 'penerima' || n === 'rekanan' || n === 'pelaksana') map.nama_penerima = h;
    // Nomor paket (grouping multiple SP2D ke 1 paket)
    else if (n === 'nomor paket' || n === 'no paket' || n === 'no. paket' || n === 'kode paket' || n === 'id paket' || n === 'group' || n === 'grup' || n === 'group paket') map.nomor_paket = h;
  }
  return map;
}

function parseSp2dRows(rows) {
  if (rows.length === 0) return { error: 'Sheet kosong', columns: null, parsed: [] };
  const headers = Object.keys(rows[0]);
  const map = detectColumns(headers);

  const wajib = ['opd', 'pekerjaan', 'no_sp2d', 'nilai'];
  const missing = wajib.filter(k => !map[k]);
  if (missing.length > 0) {
    return {
      error: `Header tidak lengkap. Wajib: Nama SKPD/OPD, Nama Pekerjaan/Keterangan Dokumen, Nomor SP2D, Nilai SP2D/Paket. Kurang: ${missing.join(', ')}`,
      detected_headers: headers,
      detected_map: map,
      parsed: [],
    };
  }

  const parsed = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const baris = i + 2;

    const namaOpd = String(r[map.opd] || '').trim();
    const namaPekerjaan = String(r[map.pekerjaan] || '').trim();
    const noSp2d = String(r[map.no_sp2d] || '').trim();
    const nilai = parseNilai(r[map.nilai]);

    if (!namaOpd || !namaPekerjaan || !noSp2d || isNaN(nilai)) {
      errors.push({ baris, alasan: 'Field wajib kosong/invalid', data: { namaOpd, namaPekerjaan, noSp2d, nilai } });
      continue;
    }

    const tanggalSp2d = map.tanggal_sp2d ? parseTanggalIndo(r[map.tanggal_sp2d]) : null;
    const tahunFromTanggal = tanggalSp2d ? parseInt(tanggalSp2d.slice(0, 4), 10) : null;
    const tahunFromCol = map.tahun ? parseInt(r[map.tahun], 10) : null;
    const tahun = tahunFromCol || tahunFromTanggal || null;

    const jenisKonsultansi = map.jenis_konsultansi ? normalizeJenisKonsultansi(r[map.jenis_konsultansi]) : null;

    const namaPenerima = map.nama_penerima ? String(r[map.nama_penerima] || '').trim() || null : null;
    const { bentuk_badan, nama_penyedia } = parsePenerima(namaPenerima);
    const nomorPaket = map.nomor_paket ? String(r[map.nomor_paket] || '').trim() || null : null;

    parsed.push({
      baris,
      nomor_paket: nomorPaket,
      nama_opd: namaOpd,
      nama_pekerjaan: namaPekerjaan,
      no_sp2d: noSp2d,
      nilai_sp2d: nilai,
      nilai_realisasi: map.nilai_realisasi ? parseNilai(r[map.nilai_realisasi]) || null : null,
      tahun_anggaran: tahun,
      tanggal_sp2d: tanggalSp2d,
      jenis_akun: map.jenis_akun ? String(r[map.jenis_akun] || '').trim() || null : null,
      nama_rekening: map.nama_rekening ? String(r[map.nama_rekening] || '').trim() || null : null,
      jenis_konsultansi: jenisKonsultansi,
      nama_penerima: namaPenerima,
      bentuk_badan, nama_penyedia,
    });
  }

  return { error: null, detected_map: map, detected_headers: headers, parsed, errors };
}

/**
 * Group parsed rows berdasarkan kombinasi (nama_opd, nomor_paket).
 * Kalau nomor_paket kosong → tiap row jadi group sendiri.
 * Output: array of paket groups, masing-masing { nama_opd, nomor_paket, nama_pekerjaan, jenis_konsultansi, sp2d: [{...}] }
 */
function groupBySp2d(parsed) {
  const groups = [];
  const map = new Map();
  let autoCounter = 1;

  for (const r of parsed) {
    let key;
    if (r.nomor_paket) {
      key = `${r.nama_opd.toLowerCase()}::${r.nomor_paket}`;
    } else {
      // No nomor → masing-masing standalone
      key = `__solo__${autoCounter++}`;
    }
    if (!map.has(key)) {
      map.set(key, {
        nomor_paket: r.nomor_paket,
        nama_opd: r.nama_opd,
        nama_pekerjaan: r.nama_pekerjaan,
        jenis_konsultansi: r.jenis_konsultansi,
        bentuk_badan: r.bentuk_badan,
        nama_penyedia: r.nama_penyedia,
        tahun_anggaran: r.tahun_anggaran,
        sp2d: [],
        first_baris: r.baris,
      });
      groups.push(map.get(key));
    }
    const g = map.get(key);
    // Konsolidasi: kalau ada SP2D dengan jenis konsultansi beda di group sama, prioritaskan yang first row
    g.sp2d.push({
      no_sp2d: r.no_sp2d,
      tanggal_sp2d: r.tanggal_sp2d,
      nilai_sp2d: r.nilai_sp2d,
      nilai_realisasi: r.nilai_realisasi,
      jenis_akun: r.jenis_akun,
      nama_rekening: r.nama_rekening,
      nama_penerima: r.nama_penerima,
      keterangan: r.nama_pekerjaan,
      baris: r.baris,
    });
  }
  return groups;
}

module.exports = { parseSp2dRows, parseTanggalIndo, parseNilai, normalizeJenisKonsultansi, detectColumns, parsePenerima, titleCase, groupBySp2d };
