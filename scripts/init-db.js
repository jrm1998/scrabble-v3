'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true, charset: 'utf8mb4',
  });
  let sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const name = process.env.DB_NAME || 'scrabble';
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('DB_NAME may only contain letters, digits and _');
  sql = sql.replace(/\bscrabble\b(?=\s+CHARACTER|;)/g, name);
  await conn.query(sql);
  await conn.end();
  console.log(`Database "${name}" is ready.`);
})().catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
