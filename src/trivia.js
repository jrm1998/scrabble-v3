'use strict';
const { VALUES } = require('./engine');

/** Trivia for a played word: API info (definition etc., may be missing) + facts we can work out ourselves. */
function buildTrivia(word, { dict, info, score } = {}) {
  const facts = [];
  if (word.length >= 3 && word === [...word].reverse().join('')) facts.push('A palindrome: it reads the same backwards');
  if (word.includes('Q') && !word.includes('U')) facts.push('A Q word without a U, worth remembering!');
  const high = ['Q', 'Z', 'X', 'J', 'K'].find(l => word.includes(l));
  if (high) facts.push(`Contains ${high}, a ${VALUES[high]}-point tile`);
  if (!/[AEIOU]/.test(word)) facts.push('Has no vowels');
  const ana = dict && dict.anagrams ? dict.anagrams(word) : [];
  if (ana.length) facts.push(`Anagrams: ${ana.join(', ')}`);
  if (word.length >= 7) facts.push(`${word.length} letters long`);
  const i = info && info.found ? info : null;
  return {
    word, score,
    found: !!i, generated: !!(i && i.generated), source: i && i.source, formOf: i && i.formOf, phonetic: i && i.phonetic, origin: i && i.origin,
    meanings: i ? i.meanings : [], synonyms: i ? i.synonyms : [],
    facts: facts.slice(0, 4),
  };
}
module.exports = { buildTrivia };
