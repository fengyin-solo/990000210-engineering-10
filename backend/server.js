const { describeLoadError, describeDbError, describeListenError } = require('./lib/diagnostics');

let express, cors, initDb, articlesRouter, authRouter;
try {
  express = require('express');
  cors = require('cors');
  initDb = require('./db/init');
  articlesRouter = require('./routes/articles');
  authRouter = require('./routes/auth');
} catch (err) {
  console.error(describeLoadError(err));
  process.exit(1);
}

const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database（失败时给出含数据库路径与修复建议的提示）
try {
  initDb();
} catch (err) {
  // db/init.js 已对错误做过包装时直接输出；否则在此补充数据库定位信息
  const message = /\[启动失败]/.test(err.message)
    ? err.message
    : describeDbError(err, initDb.DB_PATH);
  console.error(message);
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/articles', articlesRouter);

// Tags route
const { getTags } = require('./routes/articles');
app.get('/api/tags', getTags);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// 端口占用/无权限等监听错误：给出可定位提示并以非零码退出
server.on('error', (err) => {
  console.error(describeListenError(err, PORT));
  process.exit(1);
});
