const { getDb } = require('./schema');
const { generateKodeAkses } = require('../lib/helpers');

function seedDummy() {
  const db = getDb();
  const summary = { opd: 0, paket: 0, ta: 0, biaya_personel: 0, biaya_non_personel: 0 };

  const insertOpd = db.prepare('INSERT OR IGNORE INTO opd(nama, kode_akses) VALUES (?, ?)');
  const findOpd = db.prepare('SELECT id FROM opd WHERE LOWER(nama) = LOWER(?)');
  const insertPaket = db.prepare(`
    INSERT OR IGNORE INTO paket(opd_id, nama_pekerjaan, no_sp2d, nilai_paket, tahun_anggaran,
      no_kontrak, tanggal_mulai, tanggal_selesai, jenis_kontrak, jenis_konsultansi, output_diharapkan, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTa = db.prepare(`
    INSERT INTO tenaga_ahli_kontrak(paket_id, nama, nik, jabatan, periode_mulai, periode_selesai)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertBp = db.prepare(`
    INSERT INTO biaya_personel(paket_id, jabatan, jenjang_disyaratkan, bidang, mm, tarif_per_bulan)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertBnp = db.prepare(`
    INSERT INTO biaya_non_personel(paket_id, kategori, uraian, volume, satuan, harga_satuan)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const opdNames = [
    'Dinas PUPR Kota X',
    'Dinas Perkim Kota X',
    'Dinas Kesehatan Kota X',
    'Dinas Pendidikan Kota X',
    'Dinas Perhubungan Kota X',
  ];

  // NIK yang sengaja dipakai di banyak paket buat trigger Uji 1 & 2
  const sharedNiks = [
    { nik: '3201010101010001', nama: 'Ir. Budi Santoso, S.T., M.T.' },
    { nik: '3201010101010002', nama: 'Andi Wijaya, S.T.' },
    { nik: '3201010101010003', nama: 'Siti Nurhaliza, S.T.' },
  ];

  const tx = db.transaction(() => {
    const opdIds = [];
    for (const namaOpd of opdNames) {
      let row = findOpd.get(namaOpd);
      if (!row) {
        const kode = generateKodeAkses();
        const r = insertOpd.run(namaOpd, kode);
        if (r.changes > 0) {
          summary.opd += 1;
          row = { id: r.lastInsertRowid };
        } else {
          row = findOpd.get(namaOpd);
        }
      }
      opdIds.push(row.id);
    }

    let sp2dCounter = 1000;
    for (let oi = 0; oi < opdIds.length; oi++) {
      const opdId = opdIds[oi];
      const numPaket = 3 + (oi % 3); // 3-5 paket per OPD

      for (let pi = 0; pi < numPaket; pi++) {
        sp2dCounter++;
        const isLumpsum = pi % 2 === 0;
        const isPengawasan = pi % 3 !== 0;
        const nilai = (200 + pi * 50) * 1_000_000;
        const tglMulai = `2025-0${(pi % 9) + 1}-01`;
        const monthsLater = pi + 4;
        const endMonth = ((pi % 9) + 1 + monthsLater) % 12 + 1;
        const tglSelesai = `2025-${String(endMonth).padStart(2, '0')}-30`;

        const noSp2d = `SP2D/DUMMY/${sp2dCounter}/2025`;
        const r = insertPaket.run(
          opdId,
          isPengawasan ? `Pengawasan Pembangunan Gedung Blok-${oi}-${pi}` : `Perencanaan Renovasi Fasilitas-${oi}-${pi}`,
          noSp2d,
          nilai,
          2025,
          `KTR/${oi}/${pi}/2025`,
          tglMulai,
          tglSelesai,
          isLumpsum ? 'lumpsum' : 'waktu_penugasan',
          isPengawasan ? 'pengawasan' : 'perencanaan',
          `Laporan ${isPengawasan ? 'pengawasan mingguan' : 'perencanaan teknis'}`,
          'lengkap',
        );
        if (r.changes === 0) continue;
        const paketId = r.lastInsertRowid;
        summary.paket += 1;

        // Tenaga ahli — campur shared NIK (overlap) + unik per paket
        const tas = [
          {
            nama: sharedNiks[oi % sharedNiks.length].nama,
            nik: sharedNiks[oi % sharedNiks.length].nik,
            jabatan: 'Team Leader',
            periode_mulai: tglMulai,
            periode_selesai: tglSelesai,
          },
          {
            nama: `Ahli Sipil ${oi}-${pi}`,
            nik: `3201${String(oi).padStart(2, '0')}${String(pi).padStart(2, '0')}010101010${pi}`,
            jabatan: 'Ahli Teknik Sipil',
            periode_mulai: tglMulai,
            periode_selesai: tglSelesai,
          },
          {
            nama: `Ahli K3 ${oi}-${pi}`,
            nik: `3202${String(oi).padStart(2, '0')}${String(pi).padStart(2, '0')}010101010${pi}`,
            jabatan: 'Ahli K3 Konstruksi',
            periode_mulai: tglMulai,
            periode_selesai: tglSelesai,
          },
        ];

        for (const ta of tas) {
          insertTa.run(paketId, ta.nama, ta.nik, ta.jabatan, ta.periode_mulai, ta.periode_selesai);
          summary.ta += 1;
        }

        // Biaya personel
        const bps = [
          { jabatan: 'Team Leader', jenjang: 'Madya', bidang: 'Manajemen Konstruksi', mm: monthsLater, tarif: 35_000_000 },
          { jabatan: 'Ahli Teknik Sipil', jenjang: 'Muda', bidang: 'Sipil', mm: monthsLater, tarif: 22_000_000 },
          { jabatan: 'Ahli K3 Konstruksi', jenjang: 'Muda', bidang: 'K3', mm: monthsLater - 1, tarif: 20_000_000 },
        ];
        for (const bp of bps) {
          insertBp.run(paketId, bp.jabatan, bp.jenjang, bp.bidang, bp.mm, bp.tarif);
          summary.biaya_personel += 1;
        }

        // Biaya non-personel
        const bnps = [
          { kategori: 'Transportasi', uraian: 'Sewa kendaraan operasional', volume: monthsLater, satuan: 'bulan', harga: 5_000_000 },
          { kategori: 'Akomodasi', uraian: 'Sewa kantor lapangan', volume: monthsLater, satuan: 'bulan', harga: 3_000_000 },
          { kategori: 'ATK', uraian: 'Alat tulis kantor & cetak', volume: 1, satuan: 'paket', harga: 2_500_000 },
          { kategori: 'Komunikasi', uraian: 'Pulsa & internet', volume: monthsLater, satuan: 'bulan', harga: 800_000 },
        ];
        for (const bnp of bnps) {
          insertBnp.run(paketId, bnp.kategori, bnp.uraian, bnp.volume, bnp.satuan, bnp.harga);
          summary.biaya_non_personel += 1;
        }
      }
    }
  });
  tx();

  return summary;
}

module.exports = seedDummy;

// Allow direct invocation: node db/seed-dummy.js
if (require.main === module) {
  console.log(seedDummy());
}
