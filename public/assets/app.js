// Just Count — shared client utilities
const J = {
  rupiah(n) {
    if (n == null || isNaN(n)) return '-';
    return 'Rp ' + Math.round(n).toLocaleString('id-ID');
  },
  number(n) {
    if (n == null || isNaN(n)) return '-';
    return Number(n).toLocaleString('id-ID');
  },
  date(s) {
    if (!s) return '-';
    return new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  statusBadge(status) {
    const map = {
      belum_diisi: { color: 'red',     label: 'Belum Diisi' },
      draft:       { color: 'amber',   label: 'Draft' },
      lengkap:     { color: 'emerald', label: 'Lengkap' },
      terkunci:    { color: 'slate',   label: 'Terkunci' },
    };
    return map[status] || { color: 'slate', label: status };
  },
  // Label maps untuk konsistensi display (Title Case)
  LBL_JENIS_KONSULTANSI: { perencanaan: 'Perencanaan', pengawasan: 'Pengawasan', gabungan: 'Perencanaan & Pengawasan', non_konstruksi: 'Non-Konstruksi' },
  LBL_JENIS_KONTRAK: { lumpsum: 'Lumpsum', waktu_penugasan: 'Waktu Penugasan' },
  LBL_BENTUK: { PT: 'PT', CV: 'CV', Perorangan: 'Perorangan' },
  jenisKonsultansi(v) { return this.LBL_JENIS_KONSULTANSI[v] || v || '-'; },
  jenisKontrak(v) { return this.LBL_JENIS_KONTRAK[v] || v || '-'; },
  bentukBadan(v) { return this.LBL_BENTUK[v] || v || '-'; },
  async fetch(url, opts = {}) {
    const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
    if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    }
    const r = await fetch(url, { credentials: 'same-origin', ...opts, headers });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const err = new Error((data && data.error) || `HTTP ${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  async logout(role) {
    await this.fetch(`/api/auth/${role}/logout`, { method: 'POST' });
    location.href = role === 'admin' ? '/admin/login' : '/opd';
  },
  toast(msg, kind = 'info') {
    const root = document.getElementById('toast-root') || (() => {
      const r = document.createElement('div');
      r.id = 'toast-root';
      r.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(r);
      return r;
    })();
    const t = document.createElement('div');
    t.className = `alert alert-${kind === 'error' ? 'error' : kind === 'success' ? 'success' : kind === 'warn' ? 'warn' : 'info'}`;
    t.style.cssText = 'min-width:240px;max-width:380px;box-shadow:var(--shadow-md);margin:0;animation:slidein .2s';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 4000);
  },
  debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  },
  // Auto-uppercase: bind to @input pada free-text inputs (jangan pada NIK, no SP2D, dll yang sudah upper)
  upr(e, modelObj, key) {
    const v = e.target.value.toUpperCase();
    if (e.target.value !== v) {
      const pos = e.target.selectionStart;
      e.target.value = v;
      try { e.target.setSelectionRange(pos, pos); } catch {}
    }
    if (modelObj && key) modelObj[key] = v;
  },
};
window.J = J;
