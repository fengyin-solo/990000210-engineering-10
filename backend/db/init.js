const Database = require('better-sqlite3');
const path = require('path');

// Default database file; can be overridden via the DB_PATH environment
// variable (used by `npm run verify` to run checks against an isolated
// database so the real blog.db is never touched).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blog.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      summary TEXT,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('Database initialized successfully');
  return db;
}

module.exports = initDb;
module.exports.getDb = getDb;
