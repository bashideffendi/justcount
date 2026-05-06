const fs = require('fs');
const path = require('path');
const { DB_PATH, initDb } = require('./schema');

if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  const wal = DB_PATH + '-wal';
  const shm = DB_PATH + '-shm';
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
  console.log('Old DB deleted.');
}

initDb();
console.log('Fresh DB initialized at', DB_PATH);
