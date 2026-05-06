require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { initDb, DATA_DIR } = require('./db/schema');
initDb();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[warn] ADMIN_PASSWORD belum di-set, default = admin123 (PRODUCTION: WAJIB SET!)');
  process.env.ADMIN_PASSWORD = 'admin123';
}
if (!process.env.SESSION_SECRET) {
  if (IS_PROD) {
    console.error('[fatal] SESSION_SECRET wajib di-set di production. Server berhenti.');
    process.exit(1);
  }
  console.warn('[warn] SESSION_SECRET belum di-set (dev), generate random per-restart');
  process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
}

// Persistent dirs: pakai DATA_DIR (env-controlled) biar bisa mount Railway volume
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
for (const d of [UPLOAD_DIR, SESSION_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.set('trust proxy', 1);

// === SECURITY: helmet (security headers) ===
app.use(helmet({
  contentSecurityPolicy: false, // disable CSP karena kita load Alpine + Google Fonts dari CDN
  crossOriginEmbedderPolicy: false,
}));

// === PERFORMANCE: gzip compression ===
app.use(compression());

// === RATE LIMITING ===
// General: 300 req/15min per IP — cukup untuk pemakaian normal
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request, coba lagi 15 menit' },
});
app.use('/api/', generalLimiter);

// Login: 10 attempt/15min per IP — proteksi brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  message: { error: 'Terlalu banyak percobaan login, coba lagi 15 menit' },
});
app.use(['/api/auth/admin/login', '/api/auth/opd/login', '/api/auth/sign-up'], loginLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// === SESSION: file-based store (tahan restart) ===
app.use(session({
  store: new FileStore({
    path: SESSION_DIR,
    ttl: 8 * 60 * 60, // 8 jam
    retries: 1,
    logFn: () => {}, // silence verbose logs
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD, // wajib HTTPS di production
    maxAge: 1000 * 60 * 60 * 8, // 8 jam
  },
}));

// === REQUEST LOGGING (basic) ===
if (IS_PROD) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const userTag = req.session?.email ? `[${req.session.email}]` : (req.session?.opdNama ? `[opd:${req.session.opdNama}]` : '');
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms ${userTag}`);
    });
    next();
  });
}

// Health (untuk uptime monitoring)
app.get('/healthz', (req, res) => {
  const { getDb } = require('./db/schema');
  let dbOk = false;
  try { getDb().prepare('SELECT 1').get(); dbOk = true; } catch {}
  res.json({
    ok: dbOk,
    ts: Date.now(),
    uptime_sec: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    db: dbOk ? 'ok' : 'error',
    version: '0.1.0',
  });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/opd', require('./routes/opd'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/ska', require('./routes/ska'));
app.use('/api/export', require('./routes/export'));

// Static (cache 1 hari di production)
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: IS_PROD ? '1d' : 0,
  etag: true,
}));

// Serve bukti/uploads dengan auth
app.get('/uploads/:filename', (req, res) => {
  if (!req.session.isAdmin && !req.session.opdId) {
    return res.status(401).send('Unauthorized');
  }
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

// Fallback route untuk SPA-like behavior
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', err.message, err.stack?.split('\n')[1]);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: IS_PROD ? 'Server error (lihat log)' : (err.message || 'Server error') });
});

// === AUTO-BACKUP DAILY ===
function runBackup() {
  try {
    const { DB_PATH } = require('./db/schema');
    if (!fs.existsSync(DB_PATH)) return;
    const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dest = path.join(BACKUP_DIR, `audit_${stamp}.db`);
    fs.copyFileSync(DB_PATH, dest);
    // Clean old backups (keep 30 hari)
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('audit_') && f.endsWith('.db'));
    if (files.length > 30) {
      files.sort();
      for (const f of files.slice(0, files.length - 30)) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      }
    }
    console.log(`[backup] ✓ ${dest} (${files.length} files in backups/)`);
  } catch (e) {
    console.error('[backup] error:', e.message);
  }
}
// Run at startup + setiap 24 jam
setTimeout(runBackup, 30 * 1000); // 30 detik setelah start
setInterval(runBackup, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`=== Just Count ===  ${IS_PROD ? '[PRODUCTION]' : '[DEV]'}`);
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Admin login: http://localhost:${PORT}/admin/login`);
  console.log(`OPD login:   http://localhost:${PORT}/opd`);
  if (IS_PROD) console.log(`[security] helmet on, gzip on, rate-limit on, file-session on, auto-backup on`);
});
