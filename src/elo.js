'use strict';
// score: 1 = win, 0.5 = draw, 0 = loss. Returns the rating change for player A.
function eloDelta(ra, rb, score, k = 32) {
  const expected = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  return Math.round(k * (score - expected));
}
module.exports = { eloDelta };
