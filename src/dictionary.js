'use strict';
const fs = require('fs');

class Dictionary {
  constructor(file) {
    if (!fs.existsSync(file)) throw new Error(`Dictionary file not found: ${file} (run "npm run dict" or add one word per line)`);
    this.words = new Set();
    this.root = { c: Object.create(null), e: false };
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\s+/)) {
      const w = raw.toUpperCase();
      if (!/^[A-Z]{2,15}$/.test(w) || this.words.has(w)) continue;
      this.words.add(w);
      let n = this.root;
      for (const ch of w) n = n.c[ch] || (n.c[ch] = { c: Object.create(null), e: false });
      n.e = true;
    }
    if (this.words.size === 0) throw new Error('Dictionary is empty');
  }
  has(w) { return this.words.has(w); }
  walk(prefix) {
    let n = this.root;
    for (const ch of prefix) { n = n.c[ch]; if (!n) return null; }
    return n;
  }
  /** Other words made from exactly the same letters (index built on first use). */
  anagrams(w) {
    if (!this._ana) {
      this._ana = new Map();
      for (const x of this.words) {
        const k = [...x].sort().join('');
        if (!this._ana.has(k)) this._ana.set(k, []);
        this._ana.get(k).push(x);
      }
    }
    return (this._ana.get([...w].sort().join('')) || []).filter(x => x !== w).slice(0, 5);
  }
  get size() { return this.words.size; }
}
module.exports = Dictionary;
