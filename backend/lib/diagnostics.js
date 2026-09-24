'use strict';

// 启动/运行期可定位诊断工具。本模块只使用 Node 内置模块，
// 以便在第三方依赖缺失或损坏时依然可以加载并输出提示。

const fs = require('fs');
const net = require('net');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');

// 后端运行所必需的第三方模块
const REQUIRED_MODULES = ['express', 'cors', 'jsonwebtoken', 'better-sqlite3'];

function isModuleMissingError(err) {
  return !!err && (
    err.code === 'MODULE_NOT_FOUND' ||
    /Cannot find module/.test(err.message || '')
  );
}

function isNativeModuleError(err) {
  if (!err) return false;
  return err.code === 'ERR_DLOPEN_FAILED' ||
    /invalid ELF header|not a valid Win32 application|\.node['"]?\s|NODE_MODULE_VERSION/.test(err.message || '');
}

function extractMissingModule(err) {
  const m = /Cannot find module\s+['"]([^'"]+)['"]/.exec(err.message || '');
  return m ? m[1] : null;
}

// 将 require/加载阶段的错误转换为带修复建议的中文提示
function describeLoadError(err) {
  const name = extractMissingModule(err);
  const lines = [];

  if (isModuleMissingError(err)) {
    lines.push(`[启动失败] 缺少依赖模块${name ? `："${name}"` : '（模块名见下方原始错误）'}。`);
    lines.push('可能原因：尚未执行 npm install，或 node_modules 不完整。');
    lines.push('定位与修复：');
    lines.push(`  1. cd ${BACKEND_DIR}`);
    lines.push('  2. npm install');
    lines.push(`  3. 重新启动（npm run dev / npm start）`);
  } else if (isNativeModuleError(err) || /better-sqlite3/.test(String((err && err.message) || ''))) {
    lines.push('[启动失败] better-sqlite3 原生二进制模块无法加载（平台/架构与当前 Node 不匹配）。');
    lines.push(`原始信息：${err && err.message}`);
    lines.push('可能原因：node_modules 是在其他操作系统/架构上拷贝过来的，或 Node 版本已升级。');
    lines.push('定位与修复：');
    lines.push(`  1. cd ${BACKEND_DIR}`);
    lines.push('  2. npm rebuild better-sqlite3   # 若无效则删除 node_modules 后重新 npm install');
    lines.push(`  3. node -e "require('better-sqlite3')(':memory:')" 验证可加载`);
  } else {
    lines.push(`[启动失败] 加载模块时出错：${err && err.message}`);
    lines.push('定位建议：检查上方堆栈；若与依赖有关，尝试在 backend 目录执行 npm install。');
  }

  return lines.join('\n');
}

// 尝试加载一个模块，返回 { ok, error, hint }
function checkModule(name) {
  try {
    require(name);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, name, error: err, hint: describeLoadError(err) };
  }
}

function checkDependencies(modules) {
  return (modules || REQUIRED_MODULES).map((name) => checkModule(name));
}

// 判断目录当前是否可写（不创建任何文件，避免污染）
function isWritableDir(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_err) {
    return false;
  }
}

// 数据库默认存放位置（与 db/init.js 的默认值保持一致）
function defaultDataDir() {
  return path.join(BACKEND_DIR, 'data');
}

// 预检“数据库将来是否可写”：data 目录存在则检查它本身，否则检查 backend 目录
function checkDefaultDataWritable() {
  const dataDir = defaultDataDir();
  const target = fs.existsSync(dataDir) ? dataDir : BACKEND_DIR;
  return {
    ok: isWritableDir(target),
    target,
    dataDir
  };
}

// 将数据库错误转换为带路径与修复建议的中文提示
function describeDbError(err, dbPath) {
  const code = err && (err.code || '');
  const msg = String((err && err.message) || err);
  const dir = dbPath ? path.dirname(dbPath) : defaultDataDir();
  const lines = [];

  if (/SQLITE_CANTOPEN|EPERM|EACCES/.test(code) || /unable to open database file|permission denied/i.test(msg)) {
    lines.push(`[启动失败] 数据库无法打开或不可写：${dbPath || '(未指定路径)'}`);
    lines.push(`原始信息：${msg}`);
    lines.push('可能原因：数据目录不存在、当前用户无写权限，或磁盘只读。');
  } else if (/SQLITE_READONLY|read-only/i.test(msg)) {
    lines.push(`[启动失败] 数据库文件为只读：${dbPath || '(未指定路径)'}`);
    lines.push(`原始信息：${msg}`);
  } else if (/SQLITE_NOTADB|file is not a database/i.test(msg)) {
    lines.push(`[启动失败] 数据库文件已损坏或格式不正确：${dbPath || '(未指定路径)'}`);
    lines.push(`原始信息：${msg}`);
  } else {
    lines.push(`[启动失败] 数据库初始化失败：${msg}`);
    if (dbPath) lines.push(`数据库路径：${dbPath}`);
  }

  lines.push('定位与修复：');
  lines.push(`  - 检查目录是否存在且可写：ls -ld ${dir}`);
  lines.push(`  - 必要时创建并授权：mkdir -p ${dir} && chmod u+rwx ${dir}`);
  lines.push('  - 也可通过环境变量 BLOG_DB_PATH 指定一个可写的数据库文件路径后重启');
  return lines.join('\n');
}

// 将 app.listen 的错误转换为带端口与排查命令的中文提示
function describeListenError(err, port) {
  const code = err && err.code;
  if (code === 'EADDRINUSE') {
    return [
      `[启动失败] 端口 ${port} 已被占用，后端服务无法监听。`,
      '定位占用进程（任选其一）：',
      `  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      `  ss -ltnp | grep ':${port} '`,
      `  fuser -v ${port}/tcp`,
      '修复：停止占用进程，或使用其他端口启动：PORT=<其他端口> npm run dev'
    ].join('\n');
  }
  if (code === 'EACCES') {
    return [
      `[启动失败] 无权监听端口 ${port}（1024 以下端口通常需要更高权限）。`,
      '修复：改用 1024 以上端口，例如 PORT=3001 npm run dev'
    ].join('\n');
  }
  return `[启动失败] 服务监听端口 ${port} 时出错：${err && err.message}`;
}

// 获取一个当前空闲的 TCP 端口（供验证链路使用）
function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, host || '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

module.exports = {
  BACKEND_DIR,
  REQUIRED_MODULES,
  isModuleMissingError,
  isNativeModuleError,
  describeLoadError,
  describeDbError,
  describeListenError,
  checkModule,
  checkDependencies,
  isWritableDir,
  defaultDataDir,
  checkDefaultDataWritable,
  getFreePort
};
