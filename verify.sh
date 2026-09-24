#!/usr/bin/env bash
# 一条命令完成文章创作本地流程的初始化、启动与关键保存场景检查：
#   ./verify.sh
# - 自动确保后端依赖可用（缺失时 npm install；原生模块损坏时提示 npm rebuild）
# - 验证过程使用临时数据库与临时端口，重复执行不会污染 backend/data/blog.db
# 可用 PORT=3099 ./verify.sh 指定主服务端口。
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"

if ! command -v node >/dev/null 2>&1; then
  echo "[verify.sh] 未找到 node，请先安装 Node.js 18+（https://nodejs.org/）。" >&2
  exit 127
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[verify.sh] Node 版本为 $(node --version)，需要 Node.js 18+。" >&2
  exit 1
fi

if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "[verify.sh] 后端依赖缺失，执行 npm install ..."
  (cd "$BACKEND_DIR" && npm install) || {
    echo "[verify.sh] npm install 失败，请根据上方 npm 输出定位问题。" >&2
    exit 1
  }
fi

if ! (cd "$BACKEND_DIR" && node -e "require('better-sqlite3')(':memory:')") >/dev/null 2>&1; then
  echo "[verify.sh] better-sqlite3 无法加载（常见于跨平台拷贝的 node_modules 或 Node 版本升级）。" >&2
  echo "[verify.sh] 尝试修复：(cd $BACKEND_DIR && npm rebuild better-sqlite3)" >&2
  (cd "$BACKEND_DIR" && npm rebuild better-sqlite3) || {
    echo "[verify.sh] npm rebuild 失败，可尝试删除 $BACKEND_DIR/node_modules 后重新 npm install。" >&2
    exit 1
  }
fi

exec node "$BACKEND_DIR/scripts/verify-article-flow.js" "$@"
