# Blog Platform

A lightweight personal blog platform built with Vue 3 + Vite (frontend) and Node.js + Express (backend).

## Tech Stack

### Frontend
- **Vue 3** - Progressive JavaScript framework
- **Vite** - Next generation frontend tooling
- **Vue Router** - Official router for Vue.js
- **Pinia** - State management library
- **Element Plus** - Vue 3 UI component library
- **Axios** - HTTP client
- **Marked** - Markdown parser

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web application framework
- **better-sqlite3** - Fast SQLite3 library
- **jsonwebtoken** - JWT implementation
- **cors** - Cross-Origin Resource Sharing

## Project Structure

```
blog-platform/
├── frontend/          # Vue 3 + Vite frontend
│   ├── src/
│   │   ├── api/       # API client
│   │   ├── components/# Reusable components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores
│   │   └── views/     # Page components
│   └── ...
├── backend/           # Node.js + Express backend
│   ├── db/            # Database initialization and seeds
│   ├── routes/        # API routes
│   ├── middleware/    # Express middleware
│   └── data/          # SQLite database file
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. **Clone or navigate to the project directory**

```bash
cd blog-platform
```

2. **Install backend dependencies**

```bash
cd backend
npm install
```

3. **Install frontend dependencies**

```bash
cd ../frontend
npm install
```

4. **Initialize the database with seed data**

```bash
cd ../backend
npm run seed
```

### Running the Application

1. **Start the backend server (port 3001)**

```bash
cd backend
npm run dev
```

The API server will start at `http://localhost:3001`

2. **Start the frontend development server (port 5173)**

Open a new terminal:

```bash
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173`

## Features

- **Article Management**: Create, read, update, and delete blog articles
- **Markdown Support**: Write articles in Markdown with live preview
- **Tag System**: Organize articles with tags and filter by tags
- **Pagination**: Navigate through articles with pagination (10 per page)
- **Admin Panel**: Protected admin area for managing articles
- **JWT Authentication**: Secure admin login with JSON Web Tokens

## API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/login` | Admin login | No |
| GET | `/api/articles` | List articles (with pagination and tag filter) | No |
| GET | `/api/articles/:id` | Get single article | No |
| POST | `/api/articles` | Create new article | Yes |
| PUT | `/api/articles/:id` | Update article | Yes |
| DELETE | `/api/articles/:id` | Delete article | Yes |
| GET | `/api/tags` | Get all unique tags | No |

## Admin Credentials

- **Username**: admin
- **Password**: admin123

## Configuration

### Backend

- Server port: `3001` (configurable via `PORT` environment variable)
- JWT secret: `blog-platform-secret-key` (hardcoded in middleware/auth.js)
- Database file: `backend/data/blog.db`

### Frontend

- Dev server port: `5173`
- API proxy: `/api` requests are proxied to `http://localhost:3001`

## Build for Production

### Backend

The backend runs directly with Node.js:

```bash
cd backend
npm start
```

### Frontend

Build the frontend for production:

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`

## 工程化验证链路（文章创作：输入 → 保存 → 失败重试 → 返回列表）

一条命令即可完成**初始化、启动与关键保存场景检查**，用于在本地或 CI 中可重复地验证文章创作链路：

```bash
./verify.sh
# 等价于：cd backend && npm install（首次）&& npm run verify
```

脚本会自动完成：

1. **预检**：Node >= 18、后端依赖可加载、默认数据目录可写；
2. **初始化**：在系统临时目录创建**独立的临时数据库**并执行种子脚本（15 篇样例文章）；
3. **启动**：在空闲端口启动真实的后端服务（可用 `PORT=3099 ./verify.sh` 指定）；
4. **关键保存场景**（共 14 项 HTTP 黑盒检查）：
   - 登录成功/失败（JWT）；未登录或字段不全时创建/编辑被拒绝（401/400）且不写入数据；
   - 新建文章（POST 201）后读取详情，**Markdown 正文逐字一致**（前端预览使用同一份 `marked` 渲染样例）；
   - 保存后返回文章管理列表：新文章出现在第一页、分页总数正确；标签过滤与关键字搜索可命中；
   - 编辑保存（PUT）后标题/正文/标签更新、`updated_at` 不倒退；
   - **失败重试**：保存请求遇服务中断失败，服务恢复后用相同载荷重试成功，且不产生重复文章；
   - 401/400/404 等被拒绝请求后既有数据保持不变；
5. **故障注入**（5 项）：端口占用、数据库不可写时服务以非零码退出并输出含端口/路径与排查命令的中文提示；缺依赖提示 `npm install`、better-sqlite3 原生模块损坏（如跨平台拷贝）提示 `npm rebuild better-sqlite3`；
6. **防污染校验**：对比 `backend/data/blog.db*` 运行前后的文件集合、大小、mtime 与 SHA-256，**重复执行不改变开发数据库**；临时库与服务进程在结束时自动清理。

输出示例：`合计 19：19 通过, 0 失败, 0 跳过`，任一检查失败时进程以非零码退出（`VERIFY_DEBUG=1 ./verify.sh` 可打印错误堆栈）。

固定样例数据位于 `backend/scripts/fixtures/sample-article.json`，仅被验证链路使用。

### 启动期可定位提示（不改变正常运行行为）

- 依赖缺失或损坏：`cd backend && npm install`（原生模块不匹配时执行 `npm rebuild better-sqlite3`）；
- 端口占用（默认 3001）：输出 `lsof`/`ss`/`fuser` 排查命令，或用 `PORT=<端口> npm run dev` 换端口；
- 数据库不可写：输出数据库路径与 `chmod` / `BLOG_DB_PATH` 修复建议；
- 也可通过环境变量 `BLOG_DB_PATH=/path/to/blog.db` 指定数据库文件（验证链路即通过它使用临时库，默认路径 `backend/data/blog.db` 不变）。

## License

MIT
