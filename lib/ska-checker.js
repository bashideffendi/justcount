const axios = require('axios');
const { getDb } = require('../db/schema');

const BASE_URL = process.env.SKA_API_URL || 'https://cek-sertifikat-keahlian.up.railway.app';
const TTL_DAYS = parseInt(process.env.SKA_CACHE_TTL_DAYS || '30', 10);
const TIMEOUT_MS = 30_000;

function _saveCache(nik, nama, ditemukan, hasil, status, errorMsg = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO ska_cache(nik, nama, ditemukan, hasil_json, status_scrape, error_msg, dicek_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(nik, nama) DO UPDATE SET
      ditemukan = excluded.ditemukan,
      hasil_json = excluded.hasil_json,
      status_scrape = excluded.status_scrape,
      error_msg = excluded.error_msg,
      dicek_at = excluded.dicek_at
  `).run(nik || '', nama || '', ditemukan ? 1 : 0,
         hasil ? JSON.stringify(hasil) : null, status, errorMsg);
}

function _readCache(nik, nama) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM ska_cache
    WHERE nik = ? AND nama = ?
      AND (julianday('now') - julianday(dicek_at)) < ?
    LIMIT 1
  `).get(nik || '', nama || '', TTL_DAYS);
}

/**
 * Cek SKA via API tool sendiri (cek-sertifikat-keahlian.up.railway.app).
 * Search by NIK kalau ada, fallback ke nama. Cache hasil 30 hari (configurable).
 *
 * @returns {
 *   ditemukan, hasil: {profil, sertifikat[]}, status_scrape: 'success'|'not_found'|'error'|'timeout',
 *   error_msg, from_cache, fallback_url
 * }
 */
async function checkSka(nik, nama, refresh = false) {
  if (!nik && !nama) throw new Error('Minimal NIK atau nama harus diisi');

  if (!refresh) {
    const cached = _readCache(nik, nama);
    if (cached) {
      return {
        ditemukan: !!cached.ditemukan,
        hasil: cached.hasil_json ? JSON.parse(cached.hasil_json) : null,
        status_scrape: cached.status_scrape,
        error_msg: cached.error_msg,
        from_cache: true,
        cached_at: cached.dicek_at,
        fallback_url: _fallbackUrl(nik, nama),
      };
    }
  }

  // Search dulu
  try {
    const searchType = nik ? 'NIK' : 'Nama';
    const q = nik || nama;
    const searchRes = await axios.get(`${BASE_URL}/api/search`, {
      params: { type: searchType, q },
      timeout: TIMEOUT_MS,
    });

    if (!searchRes.data?.results?.length) {
      _saveCache(nik, nama, false, null, 'not_found');
      return { ditemukan: false, hasil: null, status_scrape: 'not_found', from_cache: false, fallback_url: _fallbackUrl(nik, nama) };
    }

    const best = searchRes.data.results[0];
    // Detail
    const detailRes = await axios.get(`${BASE_URL}/api/detail`, {
      params: { path: best.detail_url },
      timeout: TIMEOUT_MS,
    });

    const hasil = detailRes.data;
    _saveCache(nik || best.nik, nama || best.nama, true, hasil, 'success');
    return { ditemukan: true, hasil, status_scrape: 'success', from_cache: false, fallback_url: _fallbackUrl(nik, nama) };
  } catch (e) {
    const isTimeout = /timeout/i.test(e.message);
    const status = isTimeout ? 'timeout' : 'error';
    _saveCache(nik, nama, false, null, status, e.message);
    return {
      ditemukan: false, hasil: null, status_scrape: status,
      error_msg: e.message, from_cache: false,
      fallback_url: _fallbackUrl(nik, nama),
    };
  }
}

function _fallbackUrl(nik, nama) {
  // Fallback link kalau scrape gagal
  if (nik) return `https://cekskk.com/tracking/ska?via=nik&p=${encodeURIComponent(nik)}`;
  if (nama) return `https://cekskk.com/tracking/ska?via=nama&p=${encodeURIComponent(nama)}`;
  return 'https://cekskk.com';
}

/**
 * Untuk paket: cek SKA semua tenaga_ahli_aktual yang punya NIK/nama.
 * Diserialkan (1 req at a time) untuk hindari rate limit.
 */
async function checkSkaForPaket(paketId, { refresh = false } = {}) {
  const db = getDb();
  const taas = db.prepare(`
    SELECT id, nik, nama FROM tenaga_ahli_aktual
    WHERE paket_id = ? AND (nik IS NOT NULL OR nama IS NOT NULL)
  `).all(paketId);

  const results = [];
  for (const t of taas) {
    try {
      const r = await checkSka(t.nik, t.nama, refresh);
      results.push({ taa_id: t.id, nik: t.nik, nama: t.nama, ...r });
    } catch (e) {
      results.push({ taa_id: t.id, nik: t.nik, nama: t.nama, status_scrape: 'error', error_msg: e.message });
    }
    // Rate limit: jeda 1.5 detik antar request (kalau gak dari cache)
    if (!results[results.length - 1].from_cache) {
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  return results;
}

module.exports = { checkSka, checkSkaForPaket };
