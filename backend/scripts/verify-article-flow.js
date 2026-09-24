#!/usr/bin/env node
'use strict';

// 文章创作本地流程的可重复验证链路：
//   预检（Node 版本 / 依赖 / 默认数据目录可写）
//   → 临时数据库初始化 + 种子（不触碰开发库 backend/data/blog.db）
//   → 启动真实后端服务（空闲端口）
//   → 关键保存场景：登录鉴权、新建、Markdown 逐字存取、列表/标签/搜索、
//     编辑保存、失败重试与幂等、401/400/404、返回列表可见
//   → 故障注入：端口占用、数据库不可写、缺依赖/原生模块损坏的可定位提示
//   → 清理临时库与进程，并断言开发库前后完全一致
//
// 用法：npm run verify        （可选 PORT=3099 指定主服务端口）

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const diag = require('../lib/diagnostics');

const BACKEND_DIR = diag.BACKEND_DIR;
const FRONTEND_DIR = path.join(BACKEND_DIR, '..', 'frontend');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-article.json');

const STARTUP_TIMEOUT_MS = 15000;

// ---------- 输出与断言 ----------

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`
};

const results = [];

function info(msg) { console.log(C.cyan('› ') + msg); }
function warn(msg) { console.log(C.yellow('! ') + msg); }

async function check(name, fn, { optional = false } = {}) {
  process.stdout.write(`  ${C.gray('·')} ${name} ... `);
  try {
    const detail = await fn();
    process.stdout.write(C.green('PASS') + '\n');
    results.push({ name, status: 'pass', detail });
  } catch (err) {
    if (optional) {
      process.stdout.write(C.yellow('SKIP') + ` (${err.message})\n`);
      results.push({ name, status: 'skip', detail: err.message });
    } else {
      process.stdout.write(C.red('FAIL') + '\n');
      results.push({ name, status: 'fail', detail: err.message });
      if (err.stack && process.env.VERIFY_DEBUG) console.log(err.stack);
    }
  }
}

function assert(cond, detail) {
  if (!cond) throw new Error(detail || '断言失败');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- 子进程 ----------

function childEnv(extra) {
  return { ...process.env, ...extra };
}

// 一次性启动服务，等待其退出（用于故障注入）；超时强杀
function runServerOnce(env, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: BACKEND_DIR,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: false });
    });
  });
}

// 启动服务并等待 “Server running”
function startServer(port, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: BACKEND_DIR,
      env: childEnv({ PORT: String(port), BLOG_DB_PATH: dbPath }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.out = '';
    child.err = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      child.out += chunk;
      if (!settled && /Server running on/.test(chunk)) {
        settled = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => { child.err += d.toString(); });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`服务提前退出（code=${code}）\n--- stdout ---\n${child.out}\n--- stderr ---\n${child.err}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`服务启动超时（${STARTUP_TIMEOUT_MS}ms）\n--- stderr ---\n${child.err}`));
      }
    }, STARTUP_TIMEOUT_MS);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.killed) return resolve();
    const force = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
    }, 3000);
    child.on('exit', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  });
}

function runSeed(dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join('db', 'seed.js')], {
      cwd: BACKEND_DIR,
      env: childEnv({ BLOG_DB_PATH: dbPath }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => {
      code === 0 ? resolve({ out, err }) : reject(new Error(`种子脚本退出码 ${code}\n${out}\n${err}`));
    });
  });
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------- HTTP ----------

async function request(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${state.port}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { status: res.status, data };
}

async function waitForReady(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/tags`);
      if (res.ok) return;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`服务重启后未在 ${timeoutMs}ms 内就绪：${lastErr && lastErr.message}`);
}

// ---------- 共享状态 ----------

const state = {
  port: null,
  dbPath: null,
  tmpDir: null,
  server: null,
  token: null,
  articleId: null,
  payload: null
};

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

async function getTotal() {
  const r = await request('GET', '/api/articles?page=1&limit=1');
  assert(r.status === 200, `列表接口状态码 ${r.status}`);
  return r.data.pagination.total;
}

// ---------- 预检 ----------

async function preflight() {
  console.log(C.cyan('\n[1/6] 预检：运行环境'));
  let ok = true;

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    console.log(`  ${C.green('✓')} Node 版本 ${process.version}（需要 >= 18，内置 fetch）`);
  } else {
    console.log(`  ${C.red('✗')} Node 版本 ${process.version} 过低，请升级到 Node 18+`);
    ok = false;
  }

  for (const dep of diag.checkDependencies()) {
    if (dep.ok) {
      console.log(`  ${C.green('✓')} 依赖可加载：${dep.name}`);
    } else {
      console.log(`  ${C.red('✗')} 依赖不可用：${dep.name}`);
      console.log(dep.hint.split('\n').map((l) => '    ' + l).join('\n'));
      ok = false;
    }
  }

  const writable = diag.checkDefaultDataWritable();
  if (writable.ok) {
    console.log(`  ${C.green('✓')} 默认数据目录可写：${writable.target}`);
  } else {
    console.log(`  ${C.red('✗')} 默认数据位置不可写：${writable.target}`);
    console.log(diag.describeDbError(
      { code: 'SQLITE_CANTOPEN', message: 'unable to open database file' },
      path.join(writable.dataDir, 'blog.db')
    ).split('\n').map((l) => '    ' + l).join('\n'));
    ok = false;
  }

  if (!ok) throw new Error('预检未通过，请按上方提示修复后重试');
}

// ---------- 开发库快照（污染检查） ----------

function snapshotDevDb() {
  const dataDir = path.join(BACKEND_DIR, 'data');
  const snap = new Map();
  if (fs.existsSync(dataDir)) {
    for (const f of fs.readdirSync(dataDir)) {
      if (!/^blog\.db/.test(f)) continue;
      const p = path.join(dataDir, f);
      const st = fs.statSync(p);
      snap.set(f, { size: st.size, mtimeMs: st.mtimeMs, hash: sha256(p) });
    }
  }
  return snap;
}

function assertSnapshotUnchanged(before, label) {
  const after = snapshotDevDb();
  const beforeKeys = [...before.keys()].sort();
  const afterKeys = [...after.keys()].sort();
  assert(JSON.stringify(beforeKeys) === JSON.stringify(afterKeys),
    `${label}：开发库文件集合发生变化 ${JSON.stringify(beforeKeys)} -> ${JSON.stringify(afterKeys)}`);
  for (const [name, b] of before) {
    const a = after.get(name);
    assert(b.hash === a.hash && b.size === a.size && b.mtimeMs === a.mtimeMs,
      `${label}：开发库文件 ${name} 内容发生变化`);
  }
}

// ---------- 主流程 ----------

async function main() {
  const beforeSnapshot = snapshotDevDb();

  await preflight();

  // 初始化：临时目录 + 临时数据库
  console.log(C.cyan('\n[2/6] 初始化：临时数据库 + 种子数据'));
  state.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-verify-'));
  state.dbPath = path.join(state.tmpDir, 'verify.db');
  console.log(`  ${C.gray('临时目录：')}${state.tmpDir}`);
  console.log(`  ${C.gray('临时数据库：')}${state.dbPath}（开发库 backend/data/blog.db 不会被使用）`);

  const seedRes = await runSeed(state.dbPath);
  const seeded = /Seeded (\d+) articles/.exec(seedRes.out);
  assert(seeded && Number(seeded[1]) === 15, `种子数据数量异常：${seedRes.out.trim()}`);
  console.log(`  ${C.green('✓')} 种子脚本写入 ${seeded[1]} 篇文章`);

  // 启动
  console.log(C.cyan('\n[3/6] 启动后端服务'));
  state.port = process.env.PORT ? Number(process.env.PORT) : await diag.getFreePort();
  state.server = await startServer(state.port, state.dbPath);
  console.log(`  ${C.green('✓')} 服务已启动：http://127.0.0.1:${state.port}（BLOG_DB_PATH 指向临时库）`);
  await waitForReady(state.port);

  // 关键保存场景
  console.log(C.cyan('\n[4/6] 关键保存场景检查'));

  await check('错误密码登录返回 401', async () => {
    const r = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
    assert(r.status === 401, `期望 401，实际 ${r.status}`);
  });

  await check('正确凭据登录返回 JWT', async () => {
    const r = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    assert(r.status === 200, `期望 200，实际 ${r.status}`);
    assert(typeof r.data.token === 'string' && r.data.token.length > 10, '未返回有效 token');
    state.token = r.data.token;
  });

  await check('未携带令牌创建文章返回 401 且不写入数据', async () => {
    const before = await getTotal();
    const r = await request('POST', '/api/articles', { body: fixture });
    assert(r.status === 401, `期望 401，实际 ${r.status}`);
    assert(await getTotal() === before, '被拒绝的请求不应该新增文章');
  });

  await check('缺少标题/正文的保存请求返回 400 且不写入数据', async () => {
    const before = await getTotal();
    const r1 = await request('POST', '/api/articles', {
      token: state.token,
      body: { body: 'only body' }
    });
    assert(r1.status === 400, `期望 400，实际 ${r1.status}`);
    const r2 = await request('POST', '/api/articles', {
      token: state.token,
      body: { title: 'only title' }
    });
    assert(r2.status === 400, `期望 400，实际 ${r2.status}`);
    assert(await getTotal() === before, '校验失败的请求不应该新增文章');
  });

  await check('新建文章：按样例数据保存成功（POST 201）', async () => {
    const r = await request('POST', '/api/articles', { token: state.token, body: fixture });
    assert(r.status === 201, `期望 201，实际 ${r.status}：${JSON.stringify(r.data)}`);
    assert(r.data.id > 0, '未返回新文章 id');
    assert(r.data.title === fixture.title, '返回标题与提交不一致');
    assert(r.data.summary === fixture.summary, '返回摘要与提交不一致');
    assert(JSON.stringify(r.data.tags) === JSON.stringify(fixture.tags),
      `返回标签不一致：${JSON.stringify(r.data.tags)}`);
    state.articleId = r.data.id;
    state.payload = { ...fixture };
  });

  await check('读取详情：保存的 Markdown 正文逐字一致（预览数据源正确）', async () => {
    const r = await request('GET', `/api/articles/${state.articleId}`);
    assert(r.status === 200, `期望 200，实际 ${r.status}`);
    assert(r.data.title === fixture.title, '标题不一致');
    assert(r.data.body === fixture.body, '正文未逐字保存，Markdown 预览内容将与编辑内容不符');
    assert(r.data.summary === fixture.summary, '摘要不一致');
    assert(JSON.stringify(r.data.tags) === JSON.stringify(fixture.tags), '标签不一致');
  });

  await check('Markdown 预览可渲染（与前端编辑器使用同一 marked）', async () => {
    const marked = require(path.join(FRONTEND_DIR, 'node_modules', 'marked'));
    const html = marked.parse(fixture.body);
    for (const token of ['<h1>', '<h2>', '<code', '<blockquote', '<table', '<li>', 'E2E-MARKER-20260924']) {
      assert(html.includes(token), `渲染结果缺少 ${token}`);
    }
  }, { optional: true });

  await check('保存后返回文章管理列表：新文章在第一页可见且分页总数正确', async () => {
    const r = await request('GET', '/api/articles?page=1&limit=10');
    assert(r.status === 200, `期望 200，实际 ${r.status}`);
    assert(r.data.pagination.total === 16, `期望总数 16（15 种子 + 1 新建），实际 ${r.data.pagination.total}`);
    assert(r.data.articles.some((a) => a.id === state.articleId), '新文章应按创建时间倒序出现在第一页');
  });

  await check('标签过滤：按样例标签 E2E 仅命中新文章', async () => {
    const r = await request('GET', '/api/articles?tag=E2E');
    assert(r.status === 200, `期望 200，实际 ${r.status}`);
    assert(r.data.pagination.total === 1, `期望命中 1 篇，实际 ${r.data.pagination.total}`);
    assert(r.data.articles[0].id === state.articleId, '命中的应为新文章');
    const tags = await request('GET', '/api/tags');
    assert(tags.data.tags.includes('E2E'), '/api/tags 应包含新标签 E2E');
  });

  await check('关键字搜索可以找到新文章', async () => {
    const r = await request('GET', `/api/articles?search=${encodeURIComponent('链路自检样例文章')}`);
    assert(r.status === 200, `期望 200，实际 ${r.status}`);
    assert(r.data.articles.some((a) => a.id === state.articleId), '搜索结果应包含新文章');
  });

  await check('编辑文章：修改标题/正文/标签后保存，详情与 updated_at 同步', async () => {
    const before = await request('GET', `/api/articles/${state.articleId}`);
    state.payload = {
      title: `${fixture.title}（已编辑）`,
      summary: fixture.summary,
      tags: ['链路自检', '已编辑'],
      body: `${fixture.body}\n\n> 编辑追加内容：EDITED-ROUNDTRIP\n`
    };
    const r = await request('PUT', `/api/articles/${state.articleId}`, { token: state.token, body: state.payload });
    assert(r.status === 200, `期望 200，实际 ${r.status}`);
    assert(r.data.title === state.payload.title, '编辑后标题未更新');
    assert(r.data.body === state.payload.body, '编辑后正文未逐字更新');
    assert(JSON.stringify(r.data.tags) === JSON.stringify(state.payload.tags), '编辑后标签未更新');
    assert(Date.parse(r.data.updated_at) >= Date.parse(before.data.updated_at), 'updated_at 不应倒退');
    const again = await request('GET', `/api/articles/${state.articleId}`);
    assert(again.data.body === state.payload.body, '重新读取的正文与编辑保存内容不一致');
  });

  await check('失败重试：保存请求遇网络失败后重试成功，且不产生重复文章', async () => {
    // 模拟“保存失败”：停止服务，期间发出的请求无法到达数据库
    await stopServer(state.server);
    state.server = null;
    let networkFailed = false;
    try {
      await request('PUT', `/api/articles/${state.articleId}`, { token: state.token, body: state.payload });
    } catch (err) {
      networkFailed = true;
      assert(/fetch|ECONN|network|fetch failed/i.test(err.message), `意外的失败类型：${err.message}`);
    }
    assert(networkFailed, '服务停止时保存请求应当失败');

    // “重试”：服务恢复后用相同载荷再次保存
    state.server = await startServer(state.port, state.dbPath);
    await waitForReady(state.port);
    const retry = await request('PUT', `/api/articles/${state.articleId}`, { token: state.token, body: state.payload });
    assert(retry.status === 200, `重试保存期望 200，实际 ${retry.status}`);
    const detail = await request('GET', `/api/articles/${state.articleId}`);
    assert(detail.data.body === state.payload.body, '重试后正文与提交不一致');
    assert(await getTotal() === 16, '失败重试不应产生重复文章（总数应仍为 16）');
  });

  await check('鉴权与校验：401/400/404 场景下数据保持不变', async () => {
    const baseline = await request('GET', `/api/articles/${state.articleId}`);

    const noToken = await request('PUT', `/api/articles/${state.articleId}`, {
      body: { ...state.payload, title: '不应被写入' }
    });
    assert(noToken.status === 401, `无令牌期望 401，实际 ${noToken.status}`);

    const invalid = await request('PUT', `/api/articles/${state.articleId}`, {
      token: state.token,
      body: { body: 'missing title' }
    });
    assert(invalid.status === 400, `缺字段期望 400，实际 ${invalid.status}`);

    const missing = await request('PUT', '/api/articles/99999999', { token: state.token, body: state.payload });
    assert(missing.status === 404, `不存在的文章期望 404，实际 ${missing.status}`);

    const after = await request('GET', `/api/articles/${state.articleId}`);
    assert(after.data.title === baseline.data.title, '被拒绝的请求不应改动标题');
    assert(after.data.body === baseline.data.body, '被拒绝的请求不应改动正文');
    assert(await getTotal() === 16, '被拒绝的请求不应改变文章总数');
  });

  // 故障注入
  console.log(C.cyan('\n[5/6] 故障注入：可定位提示'));

  await check('端口占用：服务拒绝启动并提示端口与排查命令', async () => {
    const port = await diag.getFreePort();
    const blocker = await listenOn(port);
    try {
      const res = await runServerOnce({
        PORT: String(port),
        BLOG_DB_PATH: path.join(state.tmpDir, 'busy-port.db')
      });
      assert(res.code !== 0, '端口被占用时进程应以非零码退出');
      const output = `${res.out}\n${res.err}`;
      assert(new RegExp(`端口 ${port} 已被占用`).test(output), `输出未指明占用端口：${output}`);
      assert(output.includes('lsof') && output.includes('PORT='), `输出未给出定位/修复命令：${output}`);
    } finally {
      await new Promise((r) => blocker.close(() => r()));
    }
  });

  await check('数据库不可写：服务拒绝启动并提示路径与授权方法', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      throw new Error('以 root 运行时目录权限位会被绕过，跳过该用例（非 root 环境会真实执行）');
    }
    const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-verify-ro-'));
    fs.chmodSync(roDir, 0o555); // r-x r-x r-x，不可写
    try {
      const res = await runServerOnce({
        PORT: String(await diag.getFreePort()),
        BLOG_DB_PATH: path.join(roDir, 'ro.db')
      });
      assert(res.code !== 0, '数据库不可写时进程应以非零码退出');
      const output = `${res.out}\n${res.err}`;
      assert(/数据库无法打开或不可写/.test(output), `输出未说明数据库不可写：${output}`);
      assert(output.includes(roDir), `输出未给出不可写路径：${output}`);
      assert(/chmod|BLOG_DB_PATH/.test(output), `输出未给出授权/改路径建议：${output}`);
    } finally {
      fs.chmodSync(roDir, 0o755);
      fs.rmSync(roDir, { recursive: true, force: true });
    }
  });

  await check('缺依赖：探测真实缺失模块时提示 npm install', async () => {
    const r = diag.checkModule('definitely-not-installed-blog-verify-xyz');
    assert(!r.ok, '不存在的模块应当探测失败');
    assert(/缺少依赖模块/.test(r.hint) && r.hint.includes('npm install'),
      `提示中缺少定位与 npm install 建议：${r.hint}`);
  });

  await check('原生模块损坏：better-sqlite3 加载失败时提示 npm rebuild', async () => {
    const hint = diag.describeLoadError({
      code: 'ERR_DLOPEN_FAILED',
      message: 'invalid ELF header .../better-sqlite3/build/Release/better_sqlite3.node'
    });
    assert(hint.includes('npm rebuild better-sqlite3'), `提示中缺少 rebuild 建议：${hint}`);
  });

  await check('诊断映射：EADDRINUSE / SQLITE_CANTOPEN 均映射到中文定位提示', async () => {
    const portHint = diag.describeListenError({ code: 'EADDRINUSE' }, 3001);
    assert(portHint.includes('3001') && portHint.includes('lsof'), '端口提示应含端口号与排查命令');
    const dbHint = diag.describeDbError(
      { code: 'SQLITE_CANTOPEN', message: 'unable to open database file' },
      '/some/path/blog.db'
    );
    assert(dbHint.includes('/some/path/blog.db') && dbHint.includes('BLOG_DB_PATH'),
      '数据库提示应含路径与修复建议');
  });

  // 污染检查
  console.log(C.cyan('\n[6/6] 重复执行安全性：开发数据库未被污染'));
  await check('backend/data 下开发库 blog.db* 文件集合与内容哈希前后完全一致', async () => {
    assertSnapshotUnchanged(beforeSnapshot, '验证链路');
  });

} // end main

function printSummary() {
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  console.log(C.cyan('\n──────── 验证结果汇总 ────────'));
  for (const r of results) {
    const icon = r.status === 'pass' ? C.green('PASS') : r.status === 'fail' ? C.red('FAIL') : C.yellow('SKIP');
    console.log(`  ${icon}  ${r.name}${r.status === 'fail' ? C.red(`\n        └ ${r.detail}`) : ''}`);
  }
  console.log(C.cyan('──────────────────────────────'));
  console.log(`  合计 ${pass + fail + skip}：${C.green(`${pass} 通过`)}, ` +
    `${fail ? C.red(`${fail} 失败`) : '0 失败'}, ${skip} 跳过`);
  return fail === 0;
}

async function cleanup() {
  await stopServer(state.server);
  if (state.tmpDir) {
    fs.rmSync(state.tmpDir, { recursive: true, force: true });
  }
}

process.on('SIGINT', () => { warn('\n收到中断，正在清理...'); cleanup().finally(() => process.exit(130)); });
process.on('SIGTERM', () => { cleanup().finally(() => process.exit(143)); });

(async () => {
  let failed = false;
  try {
    await main();
  } catch (err) {
    failed = true;
    console.log(`\n${C.red('✗ 验证链路中止：')}${err.message}`);
  } finally {
    await cleanup();
  }
  if (results.length) {
    const ok = printSummary();
    process.exit(ok && !failed ? 0 : 1);
  }
  process.exit(failed ? 1 : 0);
})();
