const express = require('express');
const cors = require('cors');
const path = require('path');
const initDb = require('./db/init');
const articlesRouter = require('./routes/articles');
const authRouter = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database
try {
  initDb();
} catch (err) {
  console.error(`Failed to initialize database: ${err.message}`);
  console.error('Check that the backend/data directory exists and is writable, then try again.');
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (EADDRINUSE).`);
    console.error(`Stop the process using this port, or start on another one: PORT=${Number(PORT) + 1} npm run dev`);
    process.exit(1);
  }
  throw err;
});
