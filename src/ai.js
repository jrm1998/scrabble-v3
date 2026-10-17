'use strict';
const crypto = require('crypto');
const { SIZE, CENTER, isEmptyBoard, evaluateMove } = require('./engine');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const transpose = (g) => g[0].map((_, c) => g.map(row => row[c]));

/** Every legal move for `rack` (letters, '*' = blank), found with a trie walk from anchor squares. */
function generateMoves(board, rack, dict) {
  const empty = isEmptyBoard(board);
  const grid = board.map(row => row.map(t => (t ? t.l : '')));
  const counts = {};
  for (const l of rack) counts[l] = (counts[l] || 0) + 1;
  const out = new Map();

  for (const flip of [false, true]) {
    const g = flip ? transpose(grid) : grid;
    for (let r = 0; r < SIZE; r++) {
      if (empty && r !== CENTER) continue;
      const row = g[r];
      const cross = new Array(SIZE).fill(null);
      const anchor = new Array(SIZE).fill(false);
      for (let c = 0; c < SIZE; c++) {
        if (row[c]) continue;
        let up = '', dn = '';
        for (let rr = r - 1; rr >= 0 && g[rr][c]; rr--) up = g[rr][c] + up;
        for (let rr = r + 1; rr < SIZE && g[rr][c]; rr++) dn += g[rr][c];
        if (up || dn) {
          const s = new Set();
          for (const L of LETTERS) if (dict.has(up + L + dn)) s.add(L);
          cross[c] = s;
          anchor[c] = true;
        } else if ((c > 0 && row[c - 1]) || (c < SIZE - 1 && row[c + 1])) anchor[c] = true;
      }
      if (empty) { anchor.fill(false); anchor[CENTER] = true; }

      const placed = [];
      const emit = () => {
        const placements = placed.map(p => (flip ? { r: p.c, c: r, l: p.l, b: p.b } : { r, c: p.c, l: p.l, b: p.b }));
        const key = placements.map(p => `${p.r},${p.c},${p.l}${p.b ? '*' : ''}`).sort().join('|');
        if (out.has(key)) return;
        const ev = evaluateMove(board, placements, dict);
        if (ev.ok) out.set(key, { placements, score: ev.score, words: ev.words, bingo: ev.bingo });
      };
      const tryLetters = (node, fn) => {
        for (const L of Object.keys(node.c)) {
          if (counts[L] > 0) { counts[L]--; fn(L, false); counts[L]++; }
          else if (counts['*'] > 0) { counts['*']--; fn(L, true); counts['*']++; }
        }
      };
      const extendRight = (node, col, anchorCol) => {
        if (col >= SIZE || !row[col]) {
          if (node.e && col > anchorCol && placed.length) emit();
          if (col < SIZE) {
            tryLetters(node, (L, b) => {
              if (cross[col] && !cross[col].has(L)) return;
              placed.push({ c: col, l: L, b });
              extendRight(node.c[L], col + 1, anchorCol);
              placed.pop();
            });
          }
        } else {
          const nxt = node.c[row[col]];
          if (nxt) extendRight(nxt, col + 1, anchorCol);
        }
      };
      const leftPart = (node, left, limit, anchorCol) => {
        const k = left.length;
        for (let i = 0; i < k; i++) placed.push({ c: anchorCol - k + i, l: left[i].l, b: left[i].b });
        extendRight(node, anchorCol, anchorCol);
        for (let i = 0; i < k; i++) placed.pop();
        if (limit > 0) {
          tryLetters(node, (L, b) => {
            left.push({ l: L, b });
            leftPart(node.c[L], left, limit - 1, anchorCol);
            left.pop();
          });
        }
      };

      for (let c = 0; c < SIZE; c++) {
        if (!anchor[c]) continue;
        if (c > 0 && row[c - 1]) {
          let s = c;
          while (s > 0 && row[s - 1]) s--;
          const node = dict.walk(row.slice(s, c).join(''));
          if (node) extendRight(node, c, c);
        } else {
          let limit = 0;
          for (let cc = c - 1; cc >= 0 && !row[cc] && !anchor[cc]; cc--) limit++;
          leftPart(dict.root, [], Math.min(limit, 6), c);
        }
      }
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

const pick = (arr) => arr[crypto.randomInt(arr.length)];

/** moves must be sorted by score, best first. */
function chooseMove(moves, level) {
  if (!moves.length) return null;
  const n = moves.length;
  if (level === 'hard') return moves[0];
  if (level === 'easy') return pick(moves.slice(Math.floor(n * 0.5)));
  const lo = Math.floor(n * 0.15);
  return pick(moves.slice(lo, Math.max(lo + 1, Math.ceil(n * 0.5))));
}

module.exports = { generateMoves, chooseMove };
