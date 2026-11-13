#!/usr/bin/env node
// MVL Sim: local server for the ride emulator. No dependencies.
//
//   node server.mjs [options] [project-or-folder ...]
//
// A path is a Connect IQ project (a folder with manifest.xml) or a folder with projects below it.
// Without paths: the "projects" of config.json, else the current folder. More can be added in the page.
// Options: --port N, --open (opens the page; implies --stop-when-closed), --stop-when-closed (stop when
//          the last page closes), --sdk <sdk folder>, --ciq <ConnectIQ data folder>, --key <developer key>,
//          --setups <folder for new setups>, --config <config.json>, --version.
//          Environment: MVL_SIM_PORT, MVL_SIM_SDK, MVL_SIM_CIQ, MVL_SIM_KEY, MVL_SIM_SETUPS.
//
// Serves the page, the projects (read-only), the device's fonts and FIT files from local paths, and
// runs monkeyc for a compile check. Listens on 127.0.0.1 only.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { join, extname, resolve, basename, dirname, sep, relative, isAbsolute } from 'node:path';
import { tmpdir, platform, homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ciq, IS_WIN } from './ciq.mjs';
import { findProjects, findSetups, describeProject, readBundle, readDevice, SETUP_EXT } from './bundle.mjs';

export const VERSION = '0.2.0';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp',
    '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml', '.fnt': 'text/plain' };

// ---------------------------------------------------------------- options

function parseArgs(argv) {
    const o = { paths: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => { if (i + 1 >= argv.length) fail(`${a} needs a value`); return argv[++i]; };
        if (a === '--open') o.open = o.stopWhenClosed = true;
        else if (a === '--stop-when-closed') o.stopWhenClosed = true;
        else if (a === '--port') o.port = +val();
        else if (a === '--sdk') o.sdk = val();
        else if (a === '--ciq') o.ciq = val();
        else if (a === '--key') o.key = val();
        else if (a === '--config') o.config = val();
        else if (a === '--setups') o.setups = val();
        else if (a === '-v' || a === '--version') { console.log(`MVL Sim ${VERSION}`); process.exit(0); }
        else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
        else if (a.startsWith('--')) fail(`unknown option ${a}`);
        else o.paths.push(a);
    }
    return o;
}
function fail(msg) { console.error(`MVL Sim: ${msg}`); process.exit(2); }

const args = parseArgs(process.argv.slice(2));
const configPath = args.config ? resolve(args.config) : join(HERE, 'config.json');
let config = {};
if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) { fail(`${configPath}: ${e.message}`); }
} else if (args.config) fail(`config file not found: ${configPath}`);
const cfgDir = dirname(configPath);
const cfgPath = (p) => p ? resolve(cfgDir, p) : null;

const PORT = args.port || +(process.env.MVL_SIM_PORT || config.port || 8137);
const ciq = new Ciq({
    ciq: args.ciq || process.env.MVL_SIM_CIQ || cfgPath(config.ciq),
    sdk: args.sdk || process.env.MVL_SIM_SDK || cfgPath(config.sdk),
    key: args.key || process.env.MVL_SIM_KEY || cfgPath(config.key),
});

const norm = (p) => IS_WIN ? p.toLowerCase() : p;
const same = (a, b) => norm(resolve(a)) === norm(resolve(b));
const within = (root, p) => { const r = norm(resolve(root)), q = norm(resolve(p)); return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep); };

// Project roots: folders the page may read projects from
const roots = [];
function addRoot(p) {
    const r = resolve(p);
    if (!existsSync(r) || !statSync(r).isDirectory()) throw new Error(`not a folder: ${r}`);
    if (!roots.some(x => same(x, r))) roots.push(r);
    return r;
}
const initial = args.paths.length ? args.paths : (config.projects || []).map(cfgPath);
for (const p of initial) { try { addRoot(p); } catch (e) { console.warn(`MVL Sim: ${e.message}`); } }
if (!roots.length) addRoot(process.cwd());
// The default folder for setup files: --setups, else "MVL Sim" in the user's Documents (home on Linux
// without one). Setups are the user's own screens, so they do not go into a project folder by default.
function defaultSetupsDir() {
    const docs = join(homedir(), 'Documents');
    return join(existsSync(docs) ? docs : homedir(), 'MVL Sim');
}
const SETUPS = resolve(args.setups || process.env.MVL_SIM_SETUPS || cfgPath(config.setups) || defaultSetupsDir());
// More folders for setups, chosen in "Save as" (the page remembers them and registers them again)
const setupDirs = [];
function addSetupDir(p) {
    const d = resolve(p);
    if (!isAbsolute(p) || !existsSync(d) || !statSync(d).isDirectory()) throw httpError(404, `not an existing folder: ${d}`);
    if (!setupDirs.some(x => same(x, d)) && !same(d, SETUPS)) setupDirs.push(d);
    return d;
}


function listProjects() {
    const out = [], seen = new Set();
    for (const r of roots) {
        for (const dir of findProjects(r)) {
            if (seen.has(norm(dir))) continue;
            seen.add(norm(dir));
            try { out.push(describeProject(dir, r)); } catch (e) { out.push({ id: dir, name: basename(dir), root: r, error: e.message, products: [], jungles: [] }); }
        }
    }
    // Same name from two roots: add the root's folder name
    const counts = {};
    for (const p of out) counts[p.name] = (counts[p.name] || 0) + 1;
    for (const p of out) if (counts[p.name] > 1) p.name += ` (${basename(p.root)})`;
    return out;
}

// A project id is its absolute folder; it must be a project inside a registered root
function projectDir(id) {
    if (!id) throw httpError(400, 'no project');
    const dir = resolve(id);
    if (!roots.some(r => within(r, dir)) || !existsSync(join(dir, 'manifest.xml'))) throw httpError(403, `not a known project: ${dir}`);
    return dir;
}
function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }

// ---------------------------------------------------------------- setups
// A setup file may live in a project folder tree or in the setups folder. App paths in the file are
// relative to the file (so setups can be committed with the apps); the page sees absolute project ids.

const setupFolders = () => [SETUPS, ...setupDirs, ...roots];
const setupAllowed = (p) => p.toLowerCase().endsWith(SETUP_EXT) && setupFolders().some(r => within(r, p));
function listSetups() {
    const files = new Map();
    for (const r of setupFolders()) for (const f of findSetups(r)) files.set(norm(f), f);
    return [...files.values()].map(path => {
        try { const j = JSON.parse(readFileSync(path, 'utf8')); return { path, name: String(j.name || basename(path, SETUP_EXT)), device: j.device || null }; }
        catch (e) { return { path, name: basename(path, SETUP_EXT), error: e.message }; }
    }).sort((a, b) => a.name.localeCompare(b.name));
}
function readSetup(p) {
    p = resolve(p);
    if (!setupAllowed(p)) throw httpError(403, `not a setup file in a known folder: ${p}`);
    if (!existsSync(p)) throw httpError(404, `setup not found: ${p}`);
    const j = JSON.parse(readFileSync(p, 'utf8'));
    for (const f of j.fields || []) if (f && typeof f.app === 'string') f.app = resolve(dirname(p), f.app);
    return { path: p, setup: j };
}
// An app's path in a setup file: relative when the app is near the file (moves with a repo), else absolute
function appRef(file, app) {
    if (!isAbsolute(app)) return app.split(sep).join('/');
    const rel = relative(dirname(file), app);
    const ups = rel.split(sep).filter(x => x === '..').length;
    return (isAbsolute(rel) || ups > 2 ? app : rel || '.').split(sep).join('/');
}
function writeSetup(p, j) {
    p = resolve(p);
    if (!setupAllowed(p)) throw httpError(403, `setups can only be saved as *${SETUP_EXT} in a known folder (${SETUPS}, a project folder or one picked in Save as)`);
    if (!j || typeof j !== 'object' || !Array.isArray(j.fields)) throw httpError(400, 'not a setup');
    const out = { ...j, fields: j.fields.map(f => f && typeof f.app === 'string' ? { ...f, app: appRef(p, f.app) } : f) };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
    return { path: p };
}
function readBody(req, max = 256 * 1024) {
    return new Promise((ok, bad) => {
        let s = '';
        req.on('data', d => { s += d; if (s.length > max) { bad(httpError(413, 'too large')); req.destroy(); } });
        req.on('end', () => ok(s));
        req.on('error', bad);
    });
}

// ---------------------------------------------------------------- folder browser
// Lists the subfolders of a folder for the page's folder dialog (a browser page cannot learn a local path
// by itself). Names only; marks folders that are Connect IQ projects.

function places() {
    const home = homedir(), docs = join(home, 'Documents');
    const out = [{ name: 'Home', path: home }];
    if (existsSync(docs)) out.push({ name: 'Documents', path: docs });
    if (IS_WIN) {
        for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const d = c + ':' + sep; if (existsSync(d)) out.push({ name: c + ':', path: d }); }
    } else out.push({ name: '/', path: '/' });
    return out;
}
function browse(p) {
    const dir = resolve(p || homedir());
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw httpError(404, `not a folder: ${dir}`);
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { throw httpError(403, `cannot read ${dir}: ${e.code || e.message}`); }
    const dirs = [];
    for (const d of entries) {
        if (d.name.startsWith('.') || d.name.startsWith('$')) continue;
        const full = join(dir, d.name);
        let isDir = d.isDirectory();
        if (!isDir && d.isSymbolicLink()) { try { isDir = statSync(full).isDirectory(); } catch { /* broken link */ } }
        if (!isDir) continue;
        dirs.push({ name: d.name, path: full, project: existsSync(join(full, 'manifest.xml')) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const parent = dirname(dir);
    return { path: dir, parent: same(parent, dir) ? null : parent, project: existsSync(join(dir, 'manifest.xml')),
        setups: entries.filter(d => d.isFile() && d.name.toLowerCase().endsWith(SETUP_EXT)).length, dirs, places: places() };
}

// ---------------------------------------------------------------- compile check

function compileCheck(dir, device, jungle) {
    return new Promise((done) => {
        const monkeyc = ciq.monkeyc();
        if (!monkeyc) return done({ ok: false, output: `monkeyc not found (SDK: ${ciq.sdk() || 'none'}). Install an SDK with the SDK Manager or pass --sdk.` });
        const key = ciq.key();
        if (!key) return done({ ok: false, output: 'No developer key configured. Pass --key <path>, set MVL_SIM_KEY, add "key" to config.json, or set monkeyC.developerKeyPath in VS Code.' });
        if (!existsSync(key.path)) return done({ ok: false, output: `Developer key not found: ${key.path} (from ${key.from})` });
        const outDir = join(tmpdir(), 'mvl-sim');
        mkdirSync(outDir, { recursive: true });
        const out = join(outDir, `${basename(dir).replace(/[^\w.-]/g, '_')}-${device}.prg`);
        const cargs = ['-f', join(dir, jungle), '-d', device, '-o', out, '-y', key.path, '-l', '3', '-w'];
        let p;
        if (IS_WIN) {
            const line = `""${monkeyc}" ${cargs.map(a => /^[\w.-]+$/.test(a) ? a : `"${a}"`).join(' ')}"`;
            p = spawn('cmd.exe', ['/d', '/s', '/c', line], { windowsVerbatimArguments: true });
        } else p = spawn(monkeyc, cargs);
        let output = '';
        p.stdout.on('data', d => output += d);
        p.stderr.on('data', d => output += d);
        p.on('error', e => done({ ok: false, output: String(e) }));
        p.on('close', code => done({ ok: code === 0, output: (output.trim() || `exit ${code}`) + `\n(output: ${out})` }));
    });
}

// ---------------------------------------------------------------- http

function send(res, code, body, type = 'text/plain') {
    res.writeHead(code, { 'Content-Type': type + (type.startsWith('text') || type.includes('json') ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store' });
    res.end(body);
}
const json = (res, obj) => send(res, 200, JSON.stringify(obj), 'application/json');
function sendFile(res, path) {
    if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, 'not found');
    send(res, 200, readFileSync(path), TYPES[extname(path).toLowerCase()] || 'application/octet-stream');
}

// Only pages served by this server may talk to it (blocks other sites and DNS rebinding)
function allowed(req) {
    const host = (req.headers.host || '').toLowerCase();
    const okHost = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(host);
    const origin = req.headers.origin;
    const okOrigin = !origin || [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`].includes(origin.toLowerCase());
    return okHost && okOrigin;
}

const server = createServer(async (req, res) => {
    try {
        if (!allowed(req)) return send(res, 403, 'forbidden');
        const url = new URL(req.url, 'http://localhost');
        const q = url.searchParams;
        const path = decodeURIComponent(url.pathname);
        if (path === '/') return sendFile(res, join(WEB, 'index.html'));
        if (path === '/readme') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(readFileSync(join(HERE, 'README.md'))); }
        if (path === '/api/alive') return alive(req, res);
        if (path === '/api/quit' && req.method === 'POST') {
            send(res, 200, 'bye');
            console.log('Another MVL Sim took over this port; stopping.');
            return quit();
        }
        if (path === '/api/env') return json(res, { version: VERSION, ...ciq.summary(), roots, setupsDir: SETUPS, setupFolders: setupFolders(), platform: platform() });
        if (path === '/api/setup-folders' && req.method === 'POST') return json(res, { folder: addSetupDir(q.get('path') || ''), setupFolders: setupFolders() });
        if (path === '/api/browse') return json(res, browse(q.get('path')));
        if (path === '/api/devices') return json(res, ciq.listDevices());
        if (path === '/api/setups') return json(res, listSetups());
        if (path === '/api/setup' && req.method === 'GET') return json(res, readSetup(q.get('path') || ''));
        if (path === '/api/setup' && req.method === 'POST') {
            let j;
            try { j = JSON.parse(await readBody(req)); } catch (e) { throw httpError(400, e.code ? e.message : 'bad JSON'); }
            return json(res, writeSetup(q.get('path') || '', j));
        }
        if (path === '/api/projects') return json(res, listProjects());
        if (path === '/api/roots' && req.method === 'POST') {
            const r = addRoot(q.get('path') || '');
            const found = findProjects(r).length;
            if (!found) { roots.splice(roots.findIndex(x => same(x, r)), 1); return send(res, 404, `No Connect IQ project (manifest.xml) found in ${r} or 3 levels below it.`); }
            return json(res, { root: r, projects: listProjects() });
        }
        if (path === '/api/app') {
            return json(res, readBundle(projectDir(q.get('project')), q.get('device'), q.get('jungle'), q.get('lang'), ciq));
        }
        if (path === '/api/device') return json(res, readDevice(q.get('id'), ciq));
        if (path === '/api/fit') {
            const p = q.get('path') || '';
            if (!/\.fit$/i.test(p)) return send(res, 400, 'not a .fit path');
            return sendFile(res, resolve(p));
        }
        if (path === '/api/check' && req.method === 'POST') {
            const dir = projectDir(q.get('project')), device = q.get('device') || '', jungle = q.get('jungle') || 'monkey.jungle';
            if (!/^[\w-]+$/.test(device) || !/^[\w.-]+\.jungle$/.test(jungle)) return send(res, 400, 'bad args');
            return json(res, await compileCheck(dir, device, jungle));
        }
        if (path.startsWith('/sdkfonts/')) {
            const name = basename(path);
            if (!/^[\w .-]+\.ttf$/i.test(name)) return send(res, 400, 'bad font');
            const f = ciq.fontFile(name.replace(/\.ttf$/i, ''));
            return f ? sendFile(res, f) : send(res, 404, 'font not installed');
        }
        if (path === '/appres') {
            const dir = projectDir(q.get('project'));
            const p = resolve(dir, q.get('file') || '');
            if (!within(dir, p) || !/\.(png|jpe?g|gif|bmp|svg|fnt|json)$/i.test(p)) return send(res, 400, 'bad path');
            return sendFile(res, p);
        }
        const p = resolve(WEB, '.' + path);
        if (within(WEB, p) && !same(WEB, p)) return sendFile(res, p);
        send(res, 404, 'not found');
    } catch (e) {
        send(res, e.code >= 400 && e.code < 600 ? e.code : 500, String(e.code ? e.message : (e && e.stack) || e));
    }
});

// --open: open the page in the default browser once the server is up. If MVL Sim is already
// running (port taken), just open the page and exit.
const URL_ = `http://localhost:${PORT}/`;
function openBrowser() {
    const cmd = IS_WIN ? ['cmd.exe', ['/c', 'start', '""', URL_]] : platform() === 'darwin' ? ['open', [URL_]] : ['xdg-open', [URL_]];
    const p = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsVerbatimArguments: IS_WIN });
    p.on('error', () => console.log(`Open ${URL_} in a browser.`));
    p.unref();
}
// Pages keep /api/alive open. Started with --open (start.cmd), the server stops when no page has
// been open for a while, so closing the browser tab stops it; reloads reconnect well within that.
const pages = new Set();
let idleTimer = null;
const IDLE_MS = 15000;
function alive(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    pages.add(res);
    clearTimeout(idleTimer);
    req.on('close', () => {
        clearInterval(ping);
        pages.delete(res);
        if (args.stopWhenClosed && pages.size === 0) {
            idleTimer = setTimeout(() => {
                if (pages.size) return;
                console.log('The MVL Sim page was closed; stopping.');
                quit();
            }, IDLE_MS);
        }
    });
}
function quit() {
    for (const p of pages) p.end();
    server.close();
    setTimeout(() => process.exit(0), 200);
}

// The port is taken: if it is an MVL Sim (perhaps an older one), ask it to stop and take over,
// so a new start always runs the current code.
async function takeOver() {
    try {
        const env = await fetch(`${URL_}api/env`, { signal: AbortSignal.timeout(2000) });
        if (!env.ok || !(await env.json()).ciq) throw new Error('not MVL Sim');
        const r = await fetch(`${URL_}api/quit`, { method: 'POST', signal: AbortSignal.timeout(2000) });
        if (!r.ok) return false;
        for (let i = 0; i < 20; i++) {
            await new Promise(ok => setTimeout(ok, 150));
            try { await fetch(`${URL_}api/env`, { signal: AbortSignal.timeout(300) }); } catch { return true; }
        }
    } catch { /* not ours or not answering */ }
    return false;
}
let retried = false;
server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    if (!retried) {
        retried = true;
        if (await takeOver()) { console.log('Stopped the MVL Sim that was running; starting this one.'); server.listen(PORT, '127.0.0.1'); return; }
    }
    console.log(`Port ${PORT} is in use and could not be taken over.`);
    console.log('If an older MVL Sim runs there, close its window or end its node.exe in Task Manager, then start again;');
    console.log('or start this one on another port with --port.');
    process.exit(1);
});
server.on('listening', () => {
    const s = ciq.summary();
    console.log(`MVL Sim ${VERSION}: ${URL_}`);
    console.log(`  projects from: ${roots.join(', ')}`);
    console.log(`  new setups in: ${SETUPS}`);
    console.log(`  Connect IQ:    ${s.ciq}${s.ciqFound ? '' : '  (NOT FOUND: install the SDK Manager and devices, or pass --ciq)'}`);
    console.log(`  SDK:           ${s.sdk || 'not found (compile check off)'}`);
    console.log(`  key:           ${s.key ? s.key + (s.keyExists ? '' : '  (file missing)') : 'none (compile check off; pass --key)'}`);
    console.log(args.stopWhenClosed ? 'Closing the page (or this window, or Ctrl+C) stops it.' : 'Press Ctrl+C to stop it.');
    if (args.open) openBrowser();
});
server.listen(PORT, '127.0.0.1');
