// Berita Acara Permintaan Keterangan (BAPK) — generator Word DOCX
// Format BPK Perwakilan dengan kop surat (logo + alamat)
// Typography: Times New Roman, ukuran konsisten, alignment seragam
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  ImageRun, convertInchesToTwip, HeightRule, VerticalAlign,
  LevelFormat,
} = require('docx');
const { getDb } = require('../db/schema');

const HARI_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
const BULAN_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
const LOGO_PATH = path.join(__dirname, '..', 'public', 'assets', 'bpk-logo.png');

// === TYPOGRAPHY CONSTANTS (half-points) ===
const FONT = 'Times New Roman';
const SZ = {
  title: 28,        // 14pt — judul BAPK
  header_h1: 24,    // 12pt — "BADAN PEMERIKSA..."
  header_h2: 26,    // 13pt — "PERWAKILAN..." (sedikit lebih besar dari nasional sesuai kop surat BPK)
  header_addr: 20,  // 10pt — alamat & telp
  body: 22,         // 11pt — body teks normal
  body_sm: 20,      // 10pt — NIP, footnote
};

// === TANGGAL HELPERS ===
function formatTanggalIndo(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return `${d.getDate()} ${BULAN_ID[d.getMonth()]} ${d.getFullYear()}`;
}
function hariFromTanggal(s) { if (!s) return ''; return HARI_ID[new Date(s + 'T00:00:00').getDay()]; }
function tahunFromTanggal(s) { if (!s) return ''; return new Date(s + 'T00:00:00').getFullYear().toString(); }

// === BORDER PRESETS ===
const NO_BORDER = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

// === PARAGRAPH BUILDER (default font + size) ===
function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.align || AlignmentType.LEFT,
    spacing: opts.spacing || { line: 276, after: 80 }, // 1.15 line height
    indent: opts.indent || undefined,
    children: [new TextRun({
      text: text || '',
      bold: opts.bold,
      italic: opts.italic,
      size: opts.size || SZ.body,
      font: opts.font || FONT,
      color: opts.color,
    })],
  });
}

function pSplit(parts, opts = {}) {
  return new Paragraph({
    alignment: opts.align || AlignmentType.LEFT,
    spacing: opts.spacing || { line: 276, after: 80 },
    indent: opts.indent || undefined,
    children: parts.map(part => {
      const o = typeof part === 'string' ? { text: part } : part;
      return new TextRun({
        text: o.text,
        bold: o.bold,
        italic: o.italic,
        size: o.size || opts.size || SZ.body,
        font: o.font || FONT,
        color: o.color,
      });
    }),
  });
}

function cell(content, opts = {}) {
  const children = Array.isArray(content) ? content : [content];
  return new TableCell({
    children: children.map(c => typeof c === 'string' ? p(c, opts) : c),
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    borders: opts.bordered ? undefined : NO_BORDER,
    verticalAlign: opts.valign || VerticalAlign.TOP,
    margins: { top: opts.padTop || 40, bottom: opts.padBottom || 40, left: opts.padLeft != null ? opts.padLeft : 80, right: opts.padRight != null ? opts.padRight : 80 },
  });
}

// === KOP SURAT ===
function buildKopSurat(surat) {
  let logoBuf = null;
  if (fs.existsSync(LOGO_PATH)) {
    try { logoBuf = fs.readFileSync(LOGO_PATH); } catch {}
  }

  const logoCell = cell(
    logoBuf
      ? new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 0 },
          children: [new ImageRun({
            data: logoBuf,
            type: 'png',
            transformation: { width: 95, height: 95 },
          })],
        })
      : p('[LOGO BPK]', { align: AlignmentType.CENTER, size: SZ.body_sm, italic: true, color: '888888' }),
    { width: 18, valign: VerticalAlign.CENTER, padLeft: 0 }
  );

  const headerLines = [
    p('BADAN PEMERIKSA KEUANGAN REPUBLIK INDONESIA', {
      bold: true, align: AlignmentType.CENTER, size: SZ.header_h1, spacing: { line: 240, after: 30 },
    }),
    p((surat.bpk_perwakilan || 'PERWAKILAN PROVINSI ............').toUpperCase(), {
      bold: true, align: AlignmentType.CENTER, size: SZ.header_h2, spacing: { line: 240, after: 60 },
    }),
    p(surat.alamat_perwakilan || 'Jl. ......................................................................................', {
      align: AlignmentType.CENTER, size: SZ.header_addr, spacing: { line: 240, after: 30 },
    }),
  ];

  // Telp/Fax line
  const contactParts = [];
  if (surat.telepon) contactParts.push(`Telp. ${surat.telepon}`);
  if (surat.fax) contactParts.push(`Fax. ${surat.fax}`);
  if (contactParts.length > 0) {
    headerLines.push(p(contactParts.join('   '), {
      align: AlignmentType.CENTER, size: SZ.header_addr, spacing: { line: 240, after: 30 },
    }));
  }

  // Email saja (website tidak ditampilkan di kop)
  if (surat.email) {
    headerLines.push(p(surat.email, {
      align: AlignmentType.CENTER, size: SZ.header_addr, italic: true, spacing: { line: 240, after: 0 },
    }));
  }

  const textCell = cell(headerLines, { width: 82, valign: VerticalAlign.CENTER, padLeft: 200 });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      height: { value: 1900, rule: HeightRule.AT_LEAST },
      children: [logoCell, textCell],
    })],
    borders: NO_BORDER,
  });
}

function dividerLine(thick = false) {
  return new Paragraph({
    spacing: { before: 0, after: 200 },
    border: { bottom: { color: '000000', space: 1, style: BorderStyle.SINGLE, size: thick ? 18 : 8 } },
    children: [new TextRun({ text: '' })],
  });
}

// === IDENTITAS TABLE ===
function buildIdentitasTable(ba) {
  const rows = [
    ['Nama', ba.pemberi_nama],
    ['Nama Penyedia', ba.nama_penyedia],
    ['Jabatan', ba.pemberi_jabatan],
    ['SKPD', ba.pemberi_skpd],
    ['Nomor Kontak', ba.pemberi_nomor_kontak],
  ];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) => new TableRow({
      children: [
        cell(p(label, { size: SZ.body }), { width: 25, padTop: 30, padBottom: 30 }),
        cell(p(':', { size: SZ.body }), { width: 3, padLeft: 0, padRight: 0, padTop: 30, padBottom: 30 }),
        cell(p(value || '...........................................................', { size: SZ.body, bold: !!value }),
             { width: 72, padTop: 30, padBottom: 30 }),
      ],
    })),
    borders: NO_BORDER,
  });
}

// === SIGNATURE CELL ===
function ttCell(role, nama, nip) {
  const children = [
    p(role, { bold: true, align: AlignmentType.CENTER, size: SZ.body, spacing: { line: 276, after: 1200 } }),
  ];
  children.push(p(nama || '............................', { align: AlignmentType.CENTER, bold: !!nama, size: SZ.body, spacing: { line: 240, after: 30 } }));
  children.push(p('NIP. ' + (nip || '...........................'), { align: AlignmentType.CENTER, size: SZ.body_sm, spacing: { line: 240, after: 0 } }));
  return cell(children, { width: 33, valign: VerticalAlign.TOP });
}

function buildSignatureTables(ba, pem1, pem2) {
  const tbl1 = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        ttCell('Pemeriksa BPK', pem1?.nama, pem1?.nip),
        ttCell('PPK', ba.ppk_nama, ba.ppk_nip),
        ttCell('Penyedia', ba.penyedia_rep_nama, null),
      ],
    })],
    borders: NO_BORDER,
  });
  const tbl2 = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [
        ttCell('Pemeriksa BPK', pem2?.nama, pem2?.nip),
        ttCell('PPTK', ba.pptk_nama, ba.pptk_nip),
        ttCell('Pemberi Keterangan', ba.pemberi_nama, ba.pemberi_nip),
      ],
    })],
    borders: NO_BORDER,
  });
  return [tbl1, p('', { spacing: { after: 400 } }), tbl2];
}

// === HASIL KETERANGAN PARSER ===
// Output gabungan paragraf + tabel borderless untuk struktur rapi.
//   - Section header (I., II., III.): bold paragraph
//   - Subsection (A., B., C.): bold paragraph indented
//   - Numbered item (1., 2., 3.) + sub-fields → 2-column borderless TABLE
//   - Plain detail line → paragraph
const SUB_LABEL_REGEX = /^(Catatan auditor|Dasar hukum|Dasar|Catatan|Lokasi bukti|Dampak rupiah|Pertanyaan kepada Saudara|Jawaban Saudara|Nilai pengembalian yang diestimasi)\s*:\s*(.*)$/;

// Bangun 1 tabel borderless untuk satu numbered item.
// Layout: kolom 1 (no.) | kolom 2 (judul + sub-fields)
function buildItemBlock(numStr, judul, subLines) {
  // Row 1: [No.] [Judul item bold]
  const rows = [
    new TableRow({
      children: [
        cell(p(numStr, { size: SZ.body, bold: true }), { width: 7, padTop: 30, padBottom: 30, padLeft: 0 }),
        cell(p(judul, { size: SZ.body, bold: true }), { width: 93, padTop: 30, padBottom: 30 }),
      ],
    }),
  ];

  // Sub-rows: catatan, dasar, pertanyaan, jawaban
  for (const sub of subLines) {
    if (sub.kind === 'spacer') {
      rows.push(new TableRow({
        children: [
          cell(p('', { size: SZ.body }), { width: 7, padTop: 0, padBottom: 0 }),
          cell(p('', { size: SZ.body, spacing: { after: 60 } }), { width: 93, padTop: 0, padBottom: 0 }),
        ],
      }));
      continue;
    }
    if (sub.kind === 'label') {
      // Format: "Label: value"
      rows.push(new TableRow({
        children: [
          cell(p('', { size: SZ.body }), { width: 7, padTop: 20, padBottom: 20 }),
          cell(pSplit([
            { text: sub.label + ': ', bold: true },
            { text: sub.value || '', italic: !!sub.value },
          ], { size: SZ.body, align: AlignmentType.JUSTIFIED }), { width: 93, padTop: 20, padBottom: 20 }),
        ],
      }));
      continue;
    }
    // plain text line
    rows.push(new TableRow({
      children: [
        cell(p('', { size: SZ.body }), { width: 7, padTop: 20, padBottom: 20 }),
        cell(p(sub.text, { size: SZ.body, align: AlignmentType.JUSTIFIED }), { width: 93, padTop: 20, padBottom: 20 }),
      ],
    }));
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
    borders: NO_BORDER,
    indent: { size: 360, type: WidthType.DXA }, // indent table 0.25" dari kiri
  });
}

function parseHasilKeterangan(text) {
  if (!text) return [p('(Belum ada hasil keterangan)', { italic: true, color: '888888' })];
  const lines = text.split(/\r?\n/);
  const elements = [];

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    if (!trimmed) {
      elements.push(p('', { spacing: { after: 80 } }));
      i++;
      continue;
    }
    const leadingSpaces = raw.match(/^\s*/)[0].length;
    const content = trimmed.replace(/^\s+/, '');

    // Section header: "I.", "II.", "III." (Roman numerals)
    if (/^(I{1,3}|IV|V|VI{1,3}|IX|X)\.\s/.test(content)) {
      elements.push(p(content, { bold: true, size: SZ.body, spacing: { before: 240, after: 100 } }));
      i++;
      continue;
    }

    // Subsection header: "A.", "B.", "C." dengan judul singkat
    if (/^[A-Z]\.\s/.test(content) && content.length < 80) {
      elements.push(p(content, { bold: true, size: SZ.body, indent: { left: 360 }, spacing: { before: 160, after: 80 } }));
      i++;
      continue;
    }

    // Numbered item "1. ...", "2. ...", dst → bangun item block (table)
    const numMatch = content.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch && leadingSpaces >= 3) {
      const numStr = numMatch[1] + '.';
      const judul = numMatch[2];

      // Collect sub-lines sampai ketemu next numbered item / section / subsection
      const subLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextRaw = lines[j];
        const nextTrim = nextRaw.trimEnd();
        const nextContent = nextTrim.replace(/^\s+/, '');
        const nextLead = nextRaw.match(/^\s*/)[0].length;

        // Stop at: empty line followed by structural element, OR direct structural element
        if (!nextTrim) {
          // Check if next non-empty is structural
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k >= lines.length) { subLines.push({ kind: 'spacer' }); j++; continue; }
          const peek = lines[k].trimEnd().replace(/^\s+/, '');
          if (/^(I{1,3}|IV|V|VI{1,3}|IX|X)\.\s/.test(peek) ||
              (/^[A-Z]\.\s/.test(peek) && peek.length < 80) ||
              (/^\d+\.\s+/.test(peek) && lines[k].match(/^\s*/)[0].length >= 3)) {
            break;
          }
          subLines.push({ kind: 'spacer' });
          j++;
          continue;
        }

        if (nextLead < 3) break; // back to top-level

        if (/^(I{1,3}|IV|V|VI{1,3}|IX|X)\.\s/.test(nextContent)) break;
        if (/^[A-Z]\.\s/.test(nextContent) && nextContent.length < 80) break;
        if (/^\d+\.\s+/.test(nextContent) && nextLead >= 3) break;

        // Sub-label or detail
        const subLabel = nextContent.match(SUB_LABEL_REGEX);
        if (subLabel) {
          subLines.push({ kind: 'label', label: subLabel[1], value: subLabel[2] || '' });
        } else {
          subLines.push({ kind: 'text', text: nextContent });
        }
        j++;
      }

      elements.push(buildItemBlock(numStr, judul, subLines));
      elements.push(p('', { spacing: { after: 100 } }));
      i = j;
      continue;
    }

    // Top-level detail line (e.g., dalam I. IDENTITAS section, "Nama Pekerjaan : ...")
    // Render sebagai paragraf indented dengan format sederhana
    const idMatch = content.match(/^([^:]+?)\s*:\s*(.*)$/);
    if (idMatch && leadingSpaces >= 3 && idMatch[1].length < 30) {
      elements.push(pSplit([
        { text: idMatch[1].trim(), bold: false },
        { text: ' : ' },
        { text: idMatch[2] || '', bold: !!idMatch[2] },
      ], { size: SZ.body, indent: { left: 360 }, spacing: { line: 276, after: 30 } }));
      i++;
      continue;
    }

    // Fallback paragraph
    let indentObj;
    if (leadingSpaces >= 6) indentObj = { left: 1080 };
    else if (leadingSpaces >= 3) indentObj = { left: 360 };
    else indentObj = undefined;
    elements.push(p(content, { size: SZ.body, indent: indentObj, spacing: { line: 276, after: 40 }, align: AlignmentType.JUSTIFIED }));
    i++;
  }
  return elements;
}

/**
 * Generate BAPK sebagai .docx Buffer.
 */
async function generateBA(baId) {
  const db = getDb();
  const ba = db.prepare(`
    SELECT b.*,
           s.nomor AS st_nomor, s.tanggal AS st_tanggal, s.bpk_perwakilan,
           s.alamat_perwakilan, s.telepon, s.fax, s.email, s.website,
           s.nama_pemeriksaan, s.entitas_diperiksa,
           p.nama_pekerjaan AS paket_nama,
           p1.nama AS p1_nama, p1.nip AS p1_nip, p1.jabatan AS p1_jabatan,
           p2.nama AS p2_nama, p2.nip AS p2_nip, p2.jabatan AS p2_jabatan
    FROM berita_acara b
    JOIN surat_tugas s ON s.id = b.surat_tugas_id
    LEFT JOIN paket p ON p.id = b.paket_id
    LEFT JOIN pemeriksa p1 ON p1.id = b.pemeriksa_1_id
    LEFT JOIN pemeriksa p2 ON p2.id = b.pemeriksa_2_id
    WHERE b.id = ?
  `).get(baId);
  if (!ba) throw new Error('Berita Acara tidak ditemukan');

  const surat = {
    bpk_perwakilan: ba.bpk_perwakilan,
    alamat_perwakilan: ba.alamat_perwakilan,
    telepon: ba.telepon, fax: ba.fax, email: ba.email, website: ba.website,
  };
  const pem1 = ba.p1_nama ? { nama: ba.p1_nama, nip: ba.p1_nip } : null;
  const pem2 = ba.p2_nama ? { nama: ba.p2_nama, nip: ba.p2_nip } : null;

  const tanggalBA = ba.tanggal || new Date().toISOString().slice(0, 10);
  const hari = ba.hari || hariFromTanggal(tanggalBA);
  const tahun = tahunFromTanggal(tanggalBA);
  const tanggalStr = formatTanggalIndo(tanggalBA);
  const tanggalST = formatTanggalIndo(ba.st_tanggal);

  const children = [
    // === HEADER (Kop Surat) ===
    buildKopSurat(surat),
    dividerLine(true),

    // === TITLE ===
    p('BERITA ACARA PERMINTAAN KETERANGAN', {
      bold: true, align: AlignmentType.CENTER, size: SZ.title,
      spacing: { before: 240, line: 276, after: 80 },
    }),
    p('Nomor: ' + (ba.nomor || '............................'), {
      align: AlignmentType.CENTER, size: SZ.body, spacing: { line: 276, after: 360 },
    }),

    // === PEMBUKA ===
    pSplit([
      { text: 'Pada hari ini, ' },
      { text: hari || '............', bold: true },
      { text: ', tanggal ' },
      { text: tanggalStr || '............', bold: true },
      { text: ' tahun ' },
      { text: tahun || '............', bold: true },
      { text: ', berdasarkan Surat Tugas Nomor ' },
      { text: ba.st_nomor || '............', bold: true },
      { text: ' tanggal ' },
      { text: tanggalST || '............', bold: true },
      { text: ', tim pemeriksa BPK bersama dengan pihak terkait telah melaksanakan permintaan keterangan kepada:' },
    ], {
      align: AlignmentType.JUSTIFIED, size: SZ.body,
      spacing: { line: 360, after: 240 }, // 1.5 spasi untuk pembuka
    }),

    // === IDENTITAS PEMBERI KETERANGAN ===
    buildIdentitasTable(ba),

    p('', { spacing: { after: 240 } }),

    p('Hasil permintaan keterangan dituliskan di bawah tulisan ini yang telah ditandatangani bersama sebagai tanda persetujuan dari pihak terkait.', {
      align: AlignmentType.JUSTIFIED, size: SZ.body,
      spacing: { line: 360, after: 360 },
    }),

    // === HASIL KETERANGAN (parsed structure) ===
    ...parseHasilKeterangan(ba.hasil_keterangan),

    p('', { spacing: { after: 600 } }),

    // === TANDA TANGAN ===
    ...buildSignatureTables(ba, pem1, pem2),
  ];

  const doc = new Document({
    creator: 'Just Count',
    title: 'Berita Acara Permintaan Keterangan',
    // Set default font + size untuk seluruh document
    styles: {
      default: {
        document: {
          run: { font: FONT, size: SZ.body },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.5),
            bottom: convertInchesToTwip(0.7),
            left: convertInchesToTwip(0.9),
            right: convertInchesToTwip(0.9),
          },
        },
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateBA };
