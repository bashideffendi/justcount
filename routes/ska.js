const express = require('express');
const router = express.Router();
const { ensureAdmin } = require('../lib/helpers');
const { checkSka, checkSkaForPaket } = require('../lib/ska-checker');

router.use(ensureAdmin);

// Cek SKA per orang
router.post('/check', async (req, res) => {
  const { nik, nama, refresh } = req.body;
  try {
    const r = await checkSka(nik, nama, !!refresh);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cek SKA semua TA aktual di paket (bulk)
router.post('/paket/:id/check-all', async (req, res) => {
  try {
    const results = await checkSkaForPaket(parseInt(req.params.id, 10), { refresh: !!req.body?.refresh });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
