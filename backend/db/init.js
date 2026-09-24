const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { describeDbError } = require('../lib/diagnostics');

// 允许通过环境变量指定数据库文件路径（验证链路使用临时库，避免污染开发库）；
// 未设置时保持原有默认路径 backend/data/blog.db 不变。
const DB_PATH = process.env.BLOG_DB_PATH
  ? path.resolve(process.env.BLOG_DB_PATH)
  : path.join(__dirname, '..', 'data', 'blog.db');

let db;

function getDb() {
  if (!db) {
    // 确保数据库所在目录存在（与 db/seed.js 原有行为一致）
    const dir = path.dirname(DB_PATH);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      throw new Error(describeDbError(err, DB_PATH));
    }

    try {
      db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
    } catch (err) {
      throw new Error(describeDbError(err, DB_PATH));
    }
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
module.exports.DB_PATH = DB_PATH;
