// Local dashboard for the evolve strategy loop.
// Wraps evolve/evolve.js + the claude CLI (subscription, no API key).
// Bind only to 127.0.0.1 — this is a local dev tool.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 7420);
const HOST = '127.0.0.1';

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const EVOLVE_JS   = path.join(REPO_ROOT, 'evolve', 'evolve.js');
const LEADERBOARD = path.join(REPO_ROOT, 'leaderboard.md');
const FINAL_REPORT = path.join(REPO_ROOT, 'FINAL_REPORT.md');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ---------- SSE broadcaster ---------------------------------------------------
//
// Run and chat streams both need the same shape: a ring buffer keyed by ID
// plus a set of attached response objects that get every line.
class Stream {
  constructor(id) {
    this.id = id;
    this.buffer = [];      // history so late-attachers see prior output
    this.clients = new Set();
    this.done = false;
    this.exitCode = null;
  }
  push(event) {
    this.buffer.push(event);
    if (this.buffer.length > 2000) this.buffer.shift();
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(line); } catch {}
    }
  }
  finish(exitCode) {
    this.done = true;
    this.exitCode = exitCode;
    this.push({ type: 'done', code: exitCode });
    for (const res of this.clients) {
      try { res.end(); } catch {}
    }
    this.clients.clear();
  }
  attach(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const evt of this.buffer) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (this.done) { try { res.end(); } catch {} ; return; }
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }
}

const runs  = new Map();   // runId  -> Stream
const chats = new Map();   // sessionId -> { stream: Stream, child, turns }
let activeRun = null;

// ---------- Helpers -----------------------------------------------------------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function notFound(res) { res.writeHead(404); res.end('not found'); }

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const str = Buffer.concat(chunks).toString('utf8');
  try { return str ? JSON.parse(str) : {}; } catch { return null; }
}

function streamLines(readable, onLine) {
  let buf = '';
  readable.setEncoding('utf8');
  readable.on('data', chunk => {
    buf += chunk;
    let idx;
    // Respect \r so progress updates like "\rG1 1/20" become discrete lines.
    while ((idx = buf.search(/[\r\n]/)) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length) onLine(line);
    }
  });
  readable.on('end', () => { if (buf.length) onLine(buf); });
}

function checkCommand(cmd, args = ['--version']) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => (out += d.toString()));
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', code => resolve({ ok: code === 0, version: out.trim() }));
  });
}

async function probeTv() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 800);
    const r = await fetch('http://localhost:9222/json/list', { signal: controller.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// ---------- Route handlers ----------------------------------------------------

async function handleStatus(res) {
  const [nodeMods, claudeCli, tvReachable] = await Promise.all([
    Promise.resolve(fs.existsSync(path.join(REPO_ROOT, 'node_modules'))),
    checkCommand('claude', ['--version']),
    probeTv(),
  ]);
  json(res, 200, {
    repoRoot: REPO_ROOT,
    nodeModulesInstalled: nodeMods,
    claudeCli,
    tvReachable,
    leaderboardExists: fs.existsSync(LEADERBOARD),
    reportExists: fs.existsSync(FINAL_REPORT),
    platform: process.platform,
    activeRunId: activeRun,
  });
}

function handleLaunchTv(res) {
  const scriptByPlatform = {
    darwin: path.join(REPO_ROOT, 'scripts', 'launch_tv_debug_mac.sh'),
    linux:  path.join(REPO_ROOT, 'scripts', 'launch_tv_debug_linux.sh'),
    win32:  path.join(REPO_ROOT, 'scripts', 'launch_tv_debug.bat'),
  };
  const script = scriptByPlatform[process.platform];
  if (!script || !fs.existsSync(script)) {
    return json(res, 400, { error: `No launch script for ${process.platform}` });
  }

  const runId = 'tv-' + crypto.randomUUID();
  const stream = new Stream(runId);
  runs.set(runId, stream);
  stream.push({ type: 'info', text: `Spawning ${path.relative(REPO_ROOT, script)}` });

  const child = process.platform === 'win32'
    ? spawn('cmd', ['/c', script], { cwd: REPO_ROOT })
    : spawn('sh', [script], { cwd: REPO_ROOT });
  streamLines(child.stdout, l => stream.push({ type: 'stdout', text: l }));
  streamLines(child.stderr, l => stream.push({ type: 'stderr', text: l }));
  child.on('error', err => stream.push({ type: 'error', text: err.message }));
  child.on('exit', code => stream.finish(code));

  json(res, 200, { runId });
}

function buildEvolveArgs(cfg) {
  const args = [path.join('evolve', 'evolve.js')];
  if (cfg.strategy && cfg.strategy !== 'sfp') args.push(`--strategy=${cfg.strategy}`);
  if (cfg.seed)  args.push(`--seed=${cfg.seed}`);
  if (cfg.bars)  args.push(`--bars=${cfg.bars}`);
  if (cfg.data === 'live') {
    args.push('--data=live');
    if (cfg.tf)       args.push(`--tf=${cfg.tf}`);
    if (cfg.symbols)  args.push(`--symbols=${cfg.symbols}`);
    if (cfg.noCache)  args.push('--no-cache');
  }
  return args;
}

async function handleEvolveStart(req, res) {
  if (activeRun) return json(res, 409, { error: 'A run is already in flight', activeRun });

  const cfg = (await readBody(req)) || {};
  const runId = 'ev-' + crypto.randomUUID();
  const stream = new Stream(runId);
  runs.set(runId, stream);
  activeRun = runId;

  const args = buildEvolveArgs(cfg);
  stream.push({ type: 'info', text: `node ${args.join(' ')}` });

  const child = spawn('node', args, { cwd: REPO_ROOT });
  streamLines(child.stdout, l => stream.push({ type: 'stdout', text: l }));
  streamLines(child.stderr, l => stream.push({ type: 'stderr', text: l }));
  child.on('error', err => stream.push({ type: 'error', text: err.message }));
  child.on('exit', code => {
    activeRun = null;
    stream.finish(code);
  });

  json(res, 200, { runId });
}

function handleStream(runId, res) {
  const stream = runs.get(runId);
  if (!stream) return notFound(res);
  stream.attach(res);
}

function handleLeaderboard(res) {
  if (!fs.existsSync(LEADERBOARD)) return json(res, 404, { error: 'no leaderboard yet' });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(fs.readFileSync(LEADERBOARD));
}

function handleReport(res) {
  if (!fs.existsSync(FINAL_REPORT)) return json(res, 404, { error: 'no report yet' });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(fs.readFileSync(FINAL_REPORT));
}

function handleGetConfig(res) {
  const stat = fs.statSync(EVOLVE_JS);
  json(res, 200, {
    source: fs.readFileSync(EVOLVE_JS, 'utf8'),
    mtimeMs: stat.mtimeMs,
    path: path.relative(REPO_ROOT, EVOLVE_JS),
  });
}

async function handlePutConfig(req, res) {
  const body = await readBody(req);
  if (!body || typeof body.source !== 'string') {
    return json(res, 400, { error: 'expected JSON { source, expectedMtimeMs? }' });
  }
  const stat = fs.statSync(EVOLVE_JS);
  if (body.expectedMtimeMs && Math.abs(body.expectedMtimeMs - stat.mtimeMs) > 1) {
    return json(res, 409, {
      error: 'file was modified on disk',
      currentSource: fs.readFileSync(EVOLVE_JS, 'utf8'),
      mtimeMs: stat.mtimeMs,
    });
  }

  // Pipe through stdin — avoids the tmp-file-extension problem when the
  // containing package.json sets "type": "module" or similar.
  const checked = await new Promise(resolve => {
    const child = spawn('node', ['--check', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('exit', code => resolve({ code, stderr }));
    child.stdin.end(body.source);
  });
  if (checked.code !== 0) {
    const m = checked.stderr.match(/:(\d+)/);
    return json(res, 400, {
      error: 'syntax check failed',
      stderr: checked.stderr,
      line: m ? Number(m[1]) : null,
    });
  }
  // Write through a tmp file we control (hidden, .js extension so Node/watchers
  // don't trip), then atomic rename into place.
  const tmp = path.join(path.dirname(EVOLVE_JS), `.evolve.${process.pid}.tmp.js`);
  fs.writeFileSync(tmp, body.source);
  fs.renameSync(tmp, EVOLVE_JS);
  const newStat = fs.statSync(EVOLVE_JS);
  json(res, 200, { ok: true, mtimeMs: newStat.mtimeMs });
}

// ---------- Chat via `claude -p` ---------------------------------------------

const SYSTEM_PROMPT = [
  'You are helping the user brainstorm and improve trading strategies inside this repo.',
  'Relevant files:',
  '  evolve/BASELINE.md              — baseline SFP strategy spec',
  '  evolve/strategies/sfp.js        — current SFP implementation',
  '  evolve/strategies/template.js   — template for a new strategy',
  '  evolve/evolve.js                — 3-generation evolution loop',
  '  evolve/strategy.js              — backtest engine (strategy-agnostic)',
  '  evolve/results/run.json         — raw results from the last run',
  '  leaderboard.md, FINAL_REPORT.md — most recent results + commentary',
  'You can Read these directly. Prefer concise answers grounded in actual file contents.',
].join('\n');

function chatSessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function listChatSessions() {
  const files = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : [];
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function handleChat(req, res) {
  const body = await readBody(req);
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return json(res, 400, { error: 'expected JSON { message, sessionId? }' });
  }

  let sessionId = body.sessionId;
  let meta;
  if (sessionId && fs.existsSync(chatSessionFile(sessionId))) {
    meta = JSON.parse(fs.readFileSync(chatSessionFile(sessionId), 'utf8'));
  } else {
    sessionId = crypto.randomUUID();
    meta = {
      id: sessionId,
      title: body.message.slice(0, 60),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnCount: 0,
    };
  }
  meta.turnCount++;
  meta.updatedAt = Date.now();
  fs.writeFileSync(chatSessionFile(sessionId), JSON.stringify(meta, null, 2));

  // Reuse the stream for the whole session so the UI sees turn history.
  let stream = chats.get(sessionId)?.stream;
  if (!stream || stream.done) {
    stream = new Stream(sessionId);
    chats.set(sessionId, { stream, turns: meta.turnCount });
    stream.done = false;
  }
  stream.push({ type: 'user', text: body.message, turn: meta.turnCount });

  const args = [
    '-p', body.message,
    '--session-id', sessionId,
    '--append-system-prompt', SYSTEM_PROMPT,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
  ];
  if (meta.turnCount > 1) args.push('--resume', sessionId);

  // Ignore stdin — message comes via the -p arg, not stdin.
  const child = spawn('claude', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  chats.get(sessionId).child = child;

  streamLines(child.stdout, l => {
    try {
      const evt = JSON.parse(l);
      stream.push({ type: 'claude', turn: meta.turnCount, event: evt });
    } catch {
      stream.push({ type: 'raw', turn: meta.turnCount, text: l });
    }
  });
  streamLines(child.stderr, l => stream.push({ type: 'stderr', turn: meta.turnCount, text: l }));
  child.on('error', err => stream.push({ type: 'error', text: err.message }));
  child.on('exit', code => {
    stream.push({ type: 'turn_done', turn: meta.turnCount, code });
    // Do NOT finish() — the same stream carries future turns too.
  });

  json(res, 200, { sessionId, turn: meta.turnCount });
}

function handleChatStream(sessionId, res) {
  let entry = chats.get(sessionId);
  if (!entry) {
    // Allow attaching even before the first POST, so the UI can subscribe first.
    const stream = new Stream(sessionId);
    entry = { stream, turns: 0 };
    chats.set(sessionId, entry);
  }
  entry.stream.attach(res);
}

// ---------- Static ------------------------------------------------------------

function serveStatic(req, res) {
  const file = req.url === '/' ? '/index.html' : req.url;
  const resolved = path.join(__dirname, 'public', file);
  if (!resolved.startsWith(path.join(__dirname, 'public'))) return notFound(res);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
  const ext = path.extname(resolved).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(resolved).pipe(res);
}

// ---------- Router ------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname;

    // GETs
    if (req.method === 'GET') {
      if (p === '/api/status')                            return handleStatus(res);
      if (p === '/api/leaderboard')                       return handleLeaderboard(res);
      if (p === '/api/report')                            return handleReport(res);
      if (p === '/api/config')                            return handleGetConfig(res);
      if (p === '/api/chat/sessions')                     return json(res, 200, listChatSessions());
      let m;
      if ((m = p.match(/^\/api\/evolve\/([^/]+)\/stream$/))) return handleStream(m[1], res);
      if ((m = p.match(/^\/api\/chat\/([^/]+)\/stream$/)))   return handleChatStream(m[1], res);
      return serveStatic(req, res);
    }

    // Writes
    if (req.method === 'POST' && p === '/api/launch-tv') return handleLaunchTv(res);
    if (req.method === 'POST' && p === '/api/evolve')    return handleEvolveStart(req, res);
    if (req.method === 'POST' && p === '/api/chat')      return handleChat(req, res);
    if (req.method === 'PUT'  && p === '/api/config')    return handlePutConfig(req, res);

    notFound(res);
  } catch (err) {
    console.error('[server] unhandled:', err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT}  (repo: ${REPO_ROOT})`);
});
