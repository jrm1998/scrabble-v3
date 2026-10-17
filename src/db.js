'use strict';
const mysql = require('mysql2/promise');
const crypto = require('crypto');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'scrabble',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

const one = async (sql, params) => (await pool.query(sql, params))[0][0] || null;
const all = async (sql, params) => (await pool.query(sql, params))[0];
const sqlDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function createUser(username, hash) {
  const [res] = await pool.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
  return res.insertId;
}
const findByUsername = (u) => one('SELECT * FROM users WHERE username = ?', [u]);
const getUser = (id) => one('SELECT * FROM users WHERE id = ?', [id]);
const updateProfile = (id, avatar, bio) => pool.query('UPDATE users SET avatar = ?, bio = ? WHERE id = ?', [avatar, bio, id]);
const leaderboard = (limit = 50) => all(
  'SELECT username, avatar, rating, games_played, wins FROM users WHERE games_played > 0 ORDER BY rating DESC, wins DESC LIMIT ?', [limit]);
const publicProfile = (username) => one(
  'SELECT id, username, avatar, bio, rating, games_played, wins, losses, draws, best_word, best_word_score, created_at FROM users WHERE username = ?', [username]);
const recentGames = (userId, n = 10) => all(
  `SELECT g.id, g.mode, g.ranked, g.ended_at, gp.score, gp.result, gp.rating_before, gp.rating_after,
          (SELECT GROUP_CONCAT(CONCAT(o.name, ' ', o.score) SEPARATOR ', ') FROM game_players o WHERE o.game_id = g.id AND o.id <> gp.id) AS opponents
     FROM game_players gp JOIN games g ON g.id = gp.game_id
    WHERE gp.user_id = ? ORDER BY g.ended_at DESC LIMIT ?`, [userId, n]);
const replay = (id) => one('SELECT id, code, mode, ended_at, moves FROM games WHERE id = ?', [id]);

async function saveFinishedGame({ game, players }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO games (id, code, mode, ranked, reason, winner_uid, started_at, ended_at, moves) VALUES (?,?,?,?,?,?,?,?,?)',
      [game.id, game.code, game.mode, game.ranked ? 1 : 0, game.reason, game.winnerUid, sqlDate(game.startedAt), sqlDate(game.endedAt), JSON.stringify(game.moves)]);
    for (const p of players) {
      await conn.query(
        'INSERT INTO game_players (game_id, uid, user_id, name, is_ai, score, result, rating_before, rating_after) VALUES (?,?,?,?,?,?,?,?,?)',
        [game.id, p.uid, p.userId || null, p.name, p.isAI ? 1 : 0, p.score, p.result, p.ratingBefore ?? null, p.ratingAfter ?? null]);
      if (p.userId) {
        // best_word must be assigned before best_word_score (MySQL evaluates SET clauses left to right)
        await conn.query(
          `UPDATE users SET games_played = games_played + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?,
                  rating = COALESCE(?, rating), coins = coins + ?,
                  best_word = IF(? > best_word_score, ?, best_word),
                  best_word_score = GREATEST(best_word_score, ?)
            WHERE id = ?`,
          [p.result === 'win' ? 1 : 0, p.result === 'loss' ? 1 : 0, p.result === 'draw' ? 1 : 0,
           p.ratingAfter ?? null, p.coins || 0, p.bestScore || 0, p.bestWord || null, p.bestScore || 0, p.userId]);
      }
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}

const saveMessage = (scope, uid, name, text) => pool.query('INSERT INTO messages (scope, uid, name, text) VALUES (?,?,?,?)', [scope, uid, name, text]);
const recentLobbyMessages = async (n = 30) => (await all('SELECT uid, name, text, UNIX_TIMESTAMP(created_at) * 1000 AS ts FROM messages WHERE scope = ? ORDER BY id DESC LIMIT ?', ['lobby', n])).reverse();

const hashEp = (ep) => crypto.createHash('sha256').update(ep).digest('hex');
const addSub = (userId, s) => pool.query(
  `INSERT INTO push_subscriptions (user_id, endpoint_hash, endpoint, p256dh, auth) VALUES (?,?,?,?,?)
   ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`,
  [userId, hashEp(s.endpoint), s.endpoint, s.keys.p256dh, s.keys.auth]);
const getSubs = (userId) => all('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
const deleteSub = (endpoint) => pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [hashEp(endpoint)]);

module.exports = { pool, createUser, findByUsername, getUser, updateProfile, leaderboard, publicProfile, recentGames, replay,
  saveFinishedGame, saveMessage, recentLobbyMessages, addSub, getSubs, deleteSub };
