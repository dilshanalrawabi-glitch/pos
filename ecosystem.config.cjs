const path = require('path');

/**
 * PM2 — from repo root:
 *   npm start
 *   npm run pm2:start
 *   npm run pm2:logs
 *   npm run pm2:stop
 *
 * Or with global PM2: pm2 start ecosystem.config.cjs
 *   pm2 logs
 *   pm2 stop all
 *
 * If `python` is not on PATH (Windows), set interpreter to `py` or your venv python, e.g.:
 *   interpreter: path.join(__dirname, 'backend', '.venv', 'Scripts', 'python.exe'),
 */
module.exports = {
  apps: [
    {
      name: 'pos-backend',
      cwd: path.join(__dirname, 'backend'),
      script: 'app.py',
      interpreter: 'python',
      autorestart: true,
    },
    {
      name: 'pos-frontend',
      cwd: path.join(__dirname, 'frontend'),
      script: 'node_modules/vite/bin/vite.js',
      interpreter: 'node',
      autorestart: true,
    },
  ],
};
