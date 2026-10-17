'use strict';
const crypto = require('crypto');

const SIZE = 15;
const CENTER = 7;
const VALUES = { A:1,B:3,C:3,D:2,E:1,F:4,G:2,H:4,I:1,J:8,K:5,L:1,M:3,N:1,O:1,P:3,Q:10,R:1,S:1,T:1,U:1,V:4,W:4,X:8,Y:4,Z:10,'*':0 };
const DIST   = { A:9,B:2,C:2,D:4,E:12,F:2,G:3,H:2,I:9,J:1,K:1,L:4,M:2,N:6,O:8,P:2,Q:1,R:6,S:4,T:6,U:4,V:2,W:2,X:1,Y:2,Z:1,'*':2 };

// Premium squares are defined for one quadrant and mirrored (the standard board is symmetric).
const PREMIUM = (() => {
  const g = Array.from({ length: SIZE }, () => Array(SIZE).fill(''));
  const quadrant = {
    TW: [[0,0],[0,7],[7,0]],
    DW: [[1,1],[2,2],[3,3],[4,4],[7,7]],
    TL: [[1,5],[5,1],[5,5]],
    DL: [[0,3],[2,6],[3,0],[3,7],[6,2],[6,6],[7,3]],
  };
  for (const [type, cells] of Object.entries(quadrant))
    for (const [r, c] of cells)
      for (const rr of [r, 14 - r]) for (const cc of [c, 14 - c]) g[rr][cc] = type;
  return g;
})();

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function makeBag() {
  const bag = [];
  for (const [l, n] of Object.entries(DIST)) for (let i = 0; i < n; i++) bag.push(l);
  return shuffle(bag);
}
const newBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
const isEmptyBoard = (board) => board.every(row => row.every(t => !t));
const rackValue = (rack) => rack.reduce((s, l) => s + (VALUES[l] || 0), 0);
const inBounds = (r, c) => r >= 0 && c >= 0 && r < SIZE && c < SIZE;

/**
 * Validate and score a move. board[r][c] is null or {l:'A', b:false}.
 * placements: [{r,c,l,b}] (b = tile is a blank). dict: object with .has(WORD) (optional).
 */
function evaluateMove(board, placements, dict) {
  const fail = (error) => ({ ok: false, error });
  if (!Array.isArray(placements) || placements.length === 0) return fail('Place at least one tile');
  if (placements.length > 7) return fail('You can place at most 7 tiles');

  const placed = new Map();
  for (const p of placements) {
    if (!p || !Number.isInteger(p.r) || !Number.isInteger(p.c) || !inBounds(p.r, p.c)) return fail('Tile is off the board');
    if (typeof p.l !== 'string' || !/^[A-Z]$/.test(p.l)) return fail('Invalid letter');
    if (board[p.r][p.c]) return fail('That square is already occupied');
    const k = p.r * SIZE + p.c;
    if (placed.has(k)) return fail('Two tiles on one square');
    placed.set(k, { l: p.l, b: !!p.b });
  }
  const rows = new Set(placements.map(p => p.r));
  const cols = new Set(placements.map(p => p.c));
  if (rows.size > 1 && cols.size > 1) return fail('Tiles must be placed in a single row or column');

  const get = (r, c) => placed.get(r * SIZE + c) || board[r][c];
  const wordAt = (r, c, dr, dc) => {
    while (inBounds(r - dr, c - dc) && get(r - dr, c - dc)) { r -= dr; c -= dc; }
    const cells = [];
    while (inBounds(r, c) && get(r, c)) { cells.push([r, c]); r += dr; c += dc; }
    return cells;
  };

  const lines = [];
  const first = placements[0];
  if (placements.length > 1) {
    const horizontal = rows.size === 1;
    const [dr, dc] = horizontal ? [0, 1] : [1, 0];
    const main = wordAt(first.r, first.c, dr, dc);
    const inMain = new Set(main.map(([r, c]) => r * SIZE + c));
    if (!placements.every(p => inMain.has(p.r * SIZE + p.c))) return fail('Tiles must form one continuous word with no gaps');
    lines.push(main);
    for (const p of placements) {
      const cross = wordAt(p.r, p.c, dc, dr);
      if (cross.length > 1) lines.push(cross);
    }
  } else {
    const h = wordAt(first.r, first.c, 0, 1);
    const v = wordAt(first.r, first.c, 1, 0);
    if (h.length > 1) lines.push(h);
    if (v.length > 1) lines.push(v);
    if (!lines.length) return fail('A word must be at least 2 letters');
  }

  if (isEmptyBoard(board)) {
    if (!placed.has(CENTER * SIZE + CENTER)) return fail('The first word must cover the center star');
    if (placements.length < 2) return fail('The first word must be at least 2 letters');
  } else if (!lines.some(cells => cells.some(([r, c]) => !placed.has(r * SIZE + c)))) {
    return fail('Your word must connect to tiles already on the board');
  }

  const words = [];
  const bad = [];
  let total = 0;
  for (const cells of lines) {
    let sum = 0, wm = 1, word = '';
    for (const [r, c] of cells) {
      const t = get(r, c);
      word += t.l;
      let v = t.b ? 0 : VALUES[t.l];
      if (placed.has(r * SIZE + c)) {
        const pr = PREMIUM[r][c];
        if (pr === 'DL') v *= 2; else if (pr === 'TL') v *= 3;
        else if (pr === 'DW') wm *= 2; else if (pr === 'TW') wm *= 3;
      }
      sum += v;
    }
    const score = sum * wm;
    words.push({ word, score });
    total += score;
    if (dict && !dict.has(word)) bad.push(word);
  }
  if (bad.length) return fail(`Not in the dictionary: ${bad.join(', ')}`);
  const bingo = placements.length === 7;
  if (bingo) total += 50;
  return { ok: true, score: total, words, bingo };
}

module.exports = { SIZE, CENTER, VALUES, DIST, PREMIUM, shuffle, makeBag, newBoard, isEmptyBoard, rackValue, evaluateMove, inBounds };
