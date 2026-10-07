// OpenSCAD Playground — server-side model files API.
//
// A tiny, dependency-free HTTP service that exposes a directory of `.scad`
// (and optionally `.json`) files so the playground can list, open and save
// models on the server instead of only inside the browser.
//
// Endpoints (mounted under /api, which nginx proxies to this service):
//   GET    /api/health             -> { ok, dir, count }
//   GET    /api/files              -> [{ name, size, mtime }]
//   GET    /api/files/<name>       -> file contents (text/plain)
//   PUT    /api/files/<name>       -> write contents (atomic)
//   DELETE /api/files/<name>       -> delete
//
// Configuration (environment):
//   FILES_DIR    directory to serve            (default: /data/models)
//   PORT         listen port                   (default: 8080)
//   ALLOWED_EXT  comma-separated extensions    (default: .scad,.json)
//   MAX_BYTES    max upload size               (default: 5242880)
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const FILES_DIR = path.resolve(process.env.FILES_DIR || '/data/models');
const PORT = parseInt(process.env.PORT || '8080', 10);
const API_PREFIX = '/api';
const ALLOWED_EXT = (process.env.ALLOWED_EXT || '.scad,.json')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MAX_BYTES = parseInt(process.env.MAX_BYTES || String(5 * 1024 * 1024), 10);

// A file name is a single path segment with an allowed extension. Anything
// containing a separator, a NUL or a leading dot is rejected, which rules out
// directory traversal (`../`) and hidden temp files.
const NAME_RX = /^[A-Za-z0-9._ ()\-]+$/;

function safeName(raw) {
  if (raw == null) return null;
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch (e) {
    return null;
  }
  if (name.length === 0 || name.length > 128) return null;
  if (name.startsWith('.')) return null;
  if (!NAME_RX.test(name)) return null;
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return null;
  return name;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function listFiles() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  const names = await fsp.readdir(FILES_DIR);
  const out = [];
  for (const n of names) {
    if (!ALLOWED_EXT.includes(path.extname(n).toLowerCase())) continue;
    const st = await fsp.stat(path.join(FILES_DIR, n)).catch(() => null);
    if (!st || !st.isFile()) continue;
    out.push({ name: n, size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
    if (p === API_PREFIX || p === `${API_PREFIX}/`) p = `${API_PREFIX}/health`;
    if (!p.startsWith(`${API_PREFIX}/`)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const route = p.slice(API_PREFIX.length); // e.g. /health, /files, /files/a.scad

    if (route === '/health') {
      return sendJson(res, 200, {
        ok: true,
        dir: FILES_DIR,
        count: (await listFiles()).length,
      });
    }

    if (route === '/files') {
      if (req.method === 'GET') return sendJson(res, 200, await listFiles());
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (route.startsWith('/files/')) {
      const name = safeName(route.slice('/files/'.length));
      if (!name) return sendJson(res, 400, { error: 'invalid file name' });
      const full = path.join(FILES_DIR, name);

      if (req.method === 'GET') {
        const data = await fsp.readFile(full).catch(() => null);
        if (data == null) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
        });
        return res.end(data);
      }

      if (req.method === 'PUT') {
        const body = await readBody(req, MAX_BYTES);
        await fsp.mkdir(FILES_DIR, { recursive: true });
        // Write to a hidden temp file then rename, so readers never observe a
        // half-written file.
        const tmp = path.join(
          FILES_DIR,
          `.${name}.${crypto.randomBytes(4).toString('hex')}.tmp`,
        );
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, full);
        const st = await fsp.stat(full);
        return sendJson(res, 200, { name, size: st.size, mtime: st.mtimeMs });
      }

      if (req.method === 'DELETE') {
        const deleted = await fsp
          .unlink(full)
          .then(() => true)
          .catch(() => false);
        return sendJson(res, deleted ? 200 : 404, { deleted, name });
      }

      return sendJson(res, 405, { error: 'method not allowed' });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${req.method} ${req.url} ->`, e);
    sendJson(res, (e && e.statusCode) || 500, {
      error: String((e && e.message) || e),
    });
  }
});

server.listen(PORT, () => {
  console.log(
    `files-api listening on :${PORT} dir=${FILES_DIR} ext=[${ALLOWED_EXT.join(',')}] max=${MAX_BYTES}B`,
  );
});
