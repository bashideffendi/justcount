const express = require('express');
const xlsx = require('xlsx');
const router = express.Router();
const { ensureAdmin } = require('../lib/helpers');
const { exportPaketWorkpaper, exportRekap } = require('../lib/excel-export');

router.use(ensureAdmin);

router.get('/paket/:id', (req, res) => {
  try {
    const { wb, paket } = exportPaketWorkpaper(parseInt(req.params.id, 10));
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeName = (paket.nama_pekerjaan || 'paket').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50);
    res.setHeader('Content-Disposition', `attachment; filename="KK_${paket.id}_${safeName}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/rekap', (req, res) => {
  try {
    const { wb } = exportRekap();
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="Rekap_Audit_Konsultansi_${stamp}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
