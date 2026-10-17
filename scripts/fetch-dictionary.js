'use strict';
// Downloads the public-domain ENABLE word list (~173k words) to data/words.txt.
const https = require('https');
const fs = require('fs');
const path = require('path');
const URL_ = 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt';
const out = path.join(__dirname, '..', 'data', 'words.txt');
https.get(URL_, (res) => {
  if (res.statusCode !== 200) { console.error('Download failed: HTTP ' + res.statusCode); process.exit(1); }
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const n = text.split(/\s+/).filter(Boolean).length;
    if (n < 100000) { console.error('Unexpected word list size: ' + n); process.exit(1); }
    fs.writeFileSync(out, text);
    console.log(`Saved ${n} words to ${out}`);
  });
}).on('error', (e) => { console.error('Download failed:', e.message); process.exit(1); });
