#!/usr/bin/env node
/**
 * 文章创作保存链路 · 一键验证
 *
 * 流程：环境预检 → 初始化示例数据 → 启动服务 → 关键保存场景检查 → 清理还原
 *
 * 用法：
 *   npm run verify              # 默认端口 3001
 *   PORT=3101 npm run verify    # 指定其他端口
 *
 * 特性：
 *   - 全部检查在独立的验证数据库 backend/data/verify.db 上进行，结束后自动删除，
 *     不污染正式数据 backend/data/blog.db，可重复执行；
 *   - 缺依赖、数据库不可写、端口被占用时给出可定位提示，退出码为 1；
 *   - 脚本自身只使用 Node.js 内置模块（Node 18+），即使项目依赖缺失也能完成预检。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BACKEND_DIR, 'data');
const VERIFY_DB = path.join(DATA_DIR, 'verify.db');
const PORT = Number(process.env.PORT) || 3001;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const READY_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverProc = null;
const results = [];

// ---------- 输出 ----------

function stage(title) {
  console.log(`\n${title}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function fail(stageName, message, hints = []) {
  console.error(`\n✗ [${stageName}] ${message}`);
  for (const hint of hints.filter(Boolean)) {
    console.error(`  提示: ${hint}`);
  }
  process.exit(1);
}

// ---------- 清理（正常结束与异常退出都会执行） ----------

function removeVerifyDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(VERIFY_DB + suffix);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function cleanupSync() {
  if (serverProc && serverProc.exitCode === null) {
    try { serverProc.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
  }
  try { removeVerifyDbFiles(); } catch { /* 尽力清理 */ }
}

process.on('exit', cleanupSync);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ---------- HTTP 工具 ----------

async function request(method, url, { token, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`请求超时（>${REQUEST_TIMEOUT_MS}ms）: ${method} ${url}`);
    }
    throw new Error(`请求失败: ${method} ${url}（${err.message}）`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    ok(detail ? `${name}（${detail}）` : name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ---------- 阶段 1：环境预检 ----------

function preflightNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    fail('环境预检', `当前 Node.js 版本为 ${process.version}，需要 18 及以上`, [
      '请升级 Node.js 后重试（https://nodejs.org）'
    ]);
  }
  ok(`Node.js ${process.version}（要求 >= 18）`);
}

function preflightDeps() {
  const pkg = require(path.join(BACKEND_DIR, 'package.json'));
  const deps = Object.keys(pkg.dependencies || {});
  const missing = deps.filter((name) => {
    try {
      require.resolve(name, { paths: [BACKEND_DIR] });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    fail('环境预检', `缺少后端依赖: ${missing.join(', ')}`, [
      '请在 backend 目录执行: npm install',
      '若已安装仍报错，可删除 node_modules 后重新 npm install'
    ]);
  }
  ok(`后端依赖完整（${deps.length} 个包）`);
}

function preflightDatabase() {
  // 1) 数据目录存在且可写
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    fail('环境预检', `无法创建数据库目录: ${DATA_DIR}`, [
      `错误: ${err.code || ''} ${err.message}`,
      '请检查父目录权限或磁盘空间后重试'
    ]);
  }
  const probe = path.join(DATA_DIR, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    fail('环境预检', `数据库目录不可写: ${DATA_DIR}`, [
      `错误: ${err.code || ''} ${err.message}`,
      '请检查目录权限（如 chmod u+w）或磁盘空间后重试'
    ]);
  }

  // 2) 清理上次异常退出残留的验证库文件
  try {
    removeVerifyDbFiles();
  } catch (err) {
    fail('环境预检', `无法清理上次验证残留的数据库文件: ${err.message}`, [
      `请确认没有其他进程占用后，手动删除 ${VERIFY_DB}* 再重试`
    ]);
  }

  // 3) 原生模块可加载（用内存库探测，与磁盘写路径分开定位）
  let Database;
  try {
    Database = require(require.resolve('better-sqlite3', { paths: [BACKEND_DIR] }));
    const mem = new Database(':memory:');
    mem.close();
  } catch (err) {
    fail('环境预检', 'better-sqlite3 加载失败（原生模块可能未针对当前平台编译）', [
      err.message,
      '请在 backend 目录执行: npm rebuild better-sqlite3（或重新 npm install）'
    ]);
  }

  // 4) 验证库文件可实际创建写入
  try {
    const probeDb = new Database(VERIFY_DB);
    probeDb.close();
  } catch (err) {
    fail('环境预检', `无法写入验证数据库: ${VERIFY_DB}`, [
      err.message,
      '请检查 data 目录权限、磁盘空间，或确认没有其他进程占用该文件'
    ]);
  }
  ok(`数据库目录可写（${path.relative(BACKEND_DIR, VERIFY_DB)}）`);
}

function preflightPort() {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        fail('环境预检', `端口 ${PORT} 已被占用`, [
          `换端口重试: PORT=${PORT + 1} npm run verify`,
          `或先停止占用进程: lsof -i :${PORT} 找到 PID 后 kill`
        ]);
      }
      fail('环境预检', `端口 ${PORT} 不可用: ${err.message}`);
    });
    tester.once('listening', () => {
      tester.close(() => {
        ok(`端口 ${PORT} 可用`);
        resolve();
      });
    });
    tester.listen(PORT);
  });
}

// ---------- 阶段 2：初始化示例数据 ----------

function seedSampleData() {
  const result = spawnSync(process.execPath, [path.join(BACKEND_DIR, 'db', 'seed.js')], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DB_PATH: VERIFY_DB },
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    fail('初始化示例数据', '示例数据初始化失败', [
      result.error && result.error.message,
      result.stderr && result.stderr.trim(),
      result.stdout && result.stdout.trim()
    ]);
  }
  const match = (result.stdout || '').match(/Seeded (\d+) articles/);
  ok(`示例数据已写入验证库（${match ? match[1] : '?'} 篇文章）`);
}

// ---------- 阶段 3：启动服务 ----------

async function startServer() {
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(PORT), DB_PATH: VERIFY_DB }
  });

  let serverLog = '';
  let serverExit = null;
  serverProc.stdout.on('data', (d) => { serverLog += d; });
  serverProc.stderr.on('data', (d) => { serverLog += d; });
  serverProc.on('exit', (code, signal) => { serverExit = { code, signal }; });
  serverProc.on('error', (err) => {
    fail('启动服务', `无法启动服务进程: ${err.message}`);
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverExit) {
      const hints = [];
      if (/EADDRINUSE/.test(serverLog)) {
        hints.push(`端口 ${PORT} 被占用，可换端口重试: PORT=${PORT + 1} npm run verify`);
      }
      if (/SQLITE_CANTOPEN|SQLITE_READONLY|unable to open database/i.test(serverLog)) {
        hints.push(`数据库不可写，请检查目录权限: ${DATA_DIR}`);
      }
      if (/Cannot find module/.test(serverLog)) {
        hints.push('依赖缺失，请在 backend 目录执行: npm install');
      }
      fail('启动服务', `服务进程提前退出（退出码 ${serverExit.code ?? serverExit.signal}）`, [
        ...hints,
        serverLog.trim()
      ]);
    }
    try {
      const res = await fetch(`${BASE_URL}/articles?limit=1`);
      if (res.ok) {
        ok(`服务已启动（http://127.0.0.1:${PORT}）`);
        return;
      }
    } catch { /* 尚未就绪，继续等待 */ }
    await sleep(250);
  }
  fail('启动服务', `服务在 ${READY_TIMEOUT_MS / 1000}s 内未就绪`, [serverLog.trim()]);
}

async function stopServer() {
  if (!serverProc || serverProc.exitCode !== null) return;
  try { serverProc.kill('SIGTERM'); } catch { return; }
  const deadline = Date.now() + 3000;
  while (serverProc.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (serverProc.exitCode === null) {
    try { serverProc.kill('SIGKILL'); } catch { /* 忽略 */ }
  }
}

// ---------- 阶段 4：关键保存场景检查 ----------

const MARKDOWN_BODY = [
  '# 验证文章',
  '',
  '这是一篇**验证**文章，包含代码块：',
  '',
  '```js',
  "console.log('hello verify');",
  '```',
  '',
  '- 列表项一',
  '- 列表项二'
].join('\n');

function need(ctx, field) {
  if (ctx[field] === null || ctx[field] === undefined) {
    throw new Error(`前置检查未通过（缺少 ${field}），本项无法执行`);
  }
}

async function runChecks(ctx) {
  await check('服务就绪：示例文章列表可访问', async () => {
    const res = await request('GET', `${BASE_URL}/articles?page=1&limit=10`);
    expect(res.status === 200, `期望 200，实际 ${res.status}`);
    expect(res.data && Array.isArray(res.data.articles), '响应缺少 articles 数组');
    expect(res.data.pagination && typeof res.data.pagination.total === 'number', '响应缺少 pagination.total');
    ctx.baseline = res.data.pagination.total;
    expect(ctx.baseline > 0, '示例数据为空');
    return `基线 ${ctx.baseline} 篇示例文章`;
  });

  await check('登录：管理员获取访问令牌', async () => {
    const res = await request('POST', `${BASE_URL}/auth/login`, {
      body: { username: 'admin', password: 'admin123' }
    });
    expect(res.status === 200, `期望 200，实际 ${res.status}`);
    expect(res.data && res.data.token, '响应缺少 token');
    ctx.token = res.data.token;
  });

  await check('登录：错误密码被拒绝（401）', async () => {
    const res = await request('POST', `${BASE_URL}/auth/login`, {
      body: { username: 'admin', password: 'wrong-password' }
    });
    expect(res.status === 401, `期望 401，实际 ${res.status}`);
    expect(res.data && res.data.error, '应返回错误提示 error');
  });

  await check('保存鉴权：未登录保存被拒绝（401）', async () => {
    const res = await request('POST', `${BASE_URL}/articles`, {
      body: { title: '未授权文章', body: '正文' }
    });
    expect(res.status === 401, `期望 401，实际 ${res.status}`);
  });

  await check('输入校验：缺少正文返回 400 及错误提示', async () => {
    need(ctx, 'token');
    const res = await request('POST', `${BASE_URL}/articles`, {
      token: ctx.token,
      body: { title: '只有标题没有正文' }
    });
    expect(res.status === 400, `期望 400，实际 ${res.status}`);
    expect(res.data && typeof res.data.error === 'string' && res.data.error.length > 0,
      '应返回可供前端展示的错误提示 error');
    return `提示文案: ${res.data.error}`;
  });

  await check('失败重试：修正输入后新建文章成功（201）', async () => {
    need(ctx, 'token');
    const payload = {
      title: '验证文章：新建与保存',
      body: MARKDOWN_BODY,
      summary: '验证新建保存链路',
      tags: ['验证', '链路']
    };
    const res = await request('POST', `${BASE_URL}/articles`, { token: ctx.token, body: payload });
    expect(res.status === 201, `期望 201，实际 ${res.status}`);
    expect(res.data && res.data.id, '响应缺少文章 id');
    expect(res.data.body === MARKDOWN_BODY, '正文未原样保存');
    expect(Array.isArray(res.data.tags) && res.data.tags.join(',') === '验证,链路',
      `标签解析异常: ${JSON.stringify(res.data.tags)}`);
    ctx.articleId = res.data.id;
    ctx.createdIds.push(res.data.id);
    ctx.created = res.data;
    return `id=${ctx.articleId}`;
  });

  await check('Markdown：正文原样保存与回读一致', async () => {
    need(ctx, 'articleId');
    const res = await request('GET', `${BASE_URL}/articles/${ctx.articleId}`);
    expect(res.status === 200, `期望 200，实际 ${res.status}`);
    expect(res.data.body === MARKDOWN_BODY, 'Markdown 正文回读不一致（编辑/预览数据源不可靠）');
  });

  await check('编辑文章：更新标题/正文/标签后保存生效', async () => {
    need(ctx, 'token');
    need(ctx, 'articleId');
    const updated = {
      title: '验证文章：已编辑',
      body: `${MARKDOWN_BODY}\n\n## 追加段落`,
      summary: '已更新摘要',
      tags: ['验证', '已编辑']
    };
    const res = await request('PUT', `${BASE_URL}/articles/${ctx.articleId}`, {
      token: ctx.token,
      body: updated
    });
    expect(res.status === 200, `期望 200，实际 ${res.status}`);
    expect(res.data.title === updated.title, '标题未更新');
    expect(res.data.body === updated.body, '正文未更新');
    expect(Array.isArray(res.data.tags) && res.data.tags.join(',') === '验证,已编辑',
      `标签未更新: ${JSON.stringify(res.data.tags)}`);
    expect(res.data.updated_at >= ctx.created.updated_at, 'updated_at 未随保存更新');
  });

  await check('编辑校验：更新不存在的文章返回 404', async () => {
    need(ctx, 'token');
    const res = await request('PUT', `${BASE_URL}/articles/99999999`, {
      token: ctx.token,
      body: { title: 'x', body: 'y' }
    });
    expect(res.status === 404, `期望 404，实际 ${res.status}`);
  });

  await check('返回管理：文章列表首条为新建文章且总数 +1', async () => {
    need(ctx, 'articleId');
    const res = await request('GET', `${BASE_URL}/articles?page=1&limit=10`);
    expect(res.status === 200, `期望 200，实际 ${res.status}`);
    expect(res.data.articles[0] && res.data.articles[0].id === ctx.articleId,
      `列表首条不是新建文章（实际首条 id=${res.data.articles[0] && res.data.articles[0].id}）`);
    expect(res.data.pagination.total === ctx.baseline + 1,
      `总数应为 ${ctx.baseline + 1}，实际 ${res.data.pagination.total}`);
  });

  await check('返回管理：标签列表更新且可按标签筛选', async () => {
    need(ctx, 'articleId');
    const tagsRes = await request('GET', `${BASE_URL}/tags`);
    expect(tagsRes.status === 200, `期望 200，实际 ${tagsRes.status}`);
    expect(tagsRes.data.tags.includes('已编辑'), '标签列表缺少新标签「已编辑」');
    const filtered = await request('GET', `${BASE_URL}/articles?tag=${encodeURIComponent('已编辑')}`);
    expect(filtered.status === 200, `筛选请求期望 200，实际 ${filtered.status}`);
    expect(filtered.data.articles.some((a) => a.id === ctx.articleId), '按标签筛选未找到新建文章');
  });

  await check('清理还原：删除验证文章后数据回到基线', async () => {
    need(ctx, 'token');
    for (const id of ctx.createdIds) {
      const del = await request('DELETE', `${BASE_URL}/articles/${id}`, { token: ctx.token });
      expect(del.status === 200, `删除文章 ${id} 失败: ${del.status}`);
    }
    const list = await request('GET', `${BASE_URL}/articles?page=1&limit=1`);
    expect(list.data.pagination.total === ctx.baseline,
      `删除后总数 ${list.data.pagination.total} ≠ 基线 ${ctx.baseline}`);
    if (ctx.articleId) {
      const gone = await request('GET', `${BASE_URL}/articles/${ctx.articleId}`);
      expect(gone.status === 404, '已删除文章仍可访问');
    }
    return `总数恢复为 ${ctx.baseline}`;
  });
}

// ---------- 主流程 ----------

async function main() {
  console.log('==================================================');
  console.log(' 文章创作保存链路 · 一键验证');
  console.log(' （初始化示例数据 → 启动服务 → 保存场景检查 → 清理）');
  console.log('==================================================');

  stage('[1/5] 环境预检');
  preflightNode();
  preflightDeps();
  preflightDatabase();
  await preflightPort();

  stage('[2/5] 初始化示例数据（独立验证库，不影响 data/blog.db）');
  seedSampleData();

  stage('[3/5] 启动后端服务');
  await startServer();

  stage('[4/5] 关键保存场景检查');
  const ctx = { token: null, baseline: 0, articleId: null, createdIds: [], created: null };
  await runChecks(ctx);

  stage('[5/5] 清理与还原');
  await stopServer();
  removeVerifyDbFiles();
  ok('服务已停止，验证数据库 data/verify.db 已删除');

  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================');
  if (failed.length === 0) {
    console.log(` 结果：${results.length}/${results.length} 项检查通过`);
    console.log(' 正式数据 data/blog.db 未受影响，可重复执行本命令。');
  } else {
    console.log(` 结果：${results.length - failed.length}/${results.length} 项通过，${failed.length} 项失败`);
    for (const r of failed) {
      console.log(`   ✗ ${r.name}`);
    }
    process.exitCode = 1;
  }
  console.log('==================================================');
}

main().catch((err) => {
  console.error(`\n✗ 验证流程异常中断: ${(err && err.stack) || err}`);
  process.exit(1);
});
