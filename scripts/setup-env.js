'use strict';
// Creates .env from .env.example and fills in a random JWT_SECRET. Safe to re-run.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
if (/^JWT_SECRET=.{16,}/m.test(text)) {
  console.log('.env already has a JWT_SECRET - nothing to do.');
} else {
  text = text.replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET=' + crypto.randomBytes(48).toString('hex'));
  fs.writeFileSync(envPath, text);
  console.log('Wrote .env with a new JWT_SECRET.');
}
console.log('Next: check DB_USER / DB_PASSWORD in .env (XAMPP default: user root, empty password), then run: npm run db:init');
