#!/usr/bin/env node
// MVL Sim smoke test: needs no Connect IQ SDK, no Garmin files and no browser, so it runs anywhere
// (also in CI on Linux, macOS and Windows).
//
//   node test/smoke.mjs
//
// 1. The sample ride generator writes the same bytes as samples/sample-ride.fit.
// 2. The FIT decoder and ride builder read the sample ride.
// 3. The example data field is read, translated and run over the whole ride (stand-ins for the device,
//    its fonts and the canvas), and draws its power.
// 4. The server starts (through start.sh on macOS / Linux) with an empty Connect IQ folder, finds the
//    sample project and setup, serves the page, the README and the FIT file, and refuses a foreign Host.

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { decodeFit } from '../web/fit.js';
import { buildRide } from '../web/ride.js';
import { readBundle } from '../bundle.mjs';
import { Ciq } from '../ciq.mjs';
import { Sim } from '../web/sim.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SAMPLES = join(ROOT, 'samples');
const IS_WIN = platform() === 'win32';
let failed = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
    if (!ok) failed++;
}
const tmp = mkdtempSync(join(tmpdir(), 'mvl-sim-smoke-'));

// ------------------------------------------------------------ 1. sample generator

const regenerated = join(tmp, 'sample-ride.fit');
execFileSync(process.execPath, [join(SAMPLES, 'make-sample-ride.mjs'), regenerated]);
check('sample ride generator is deterministic', readFileSync(regenerated).equals(readFileSync(join(SAMPLES, 'sample-ride.fit'))));

// ------------------------------------------------------------ 2. FIT decoder and ride

const buf = readFileSync(join(SAMPLES, 'sample-ride.fit'));
const ride = buildRide(decodeFit(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
check('sample ride has 2460 seconds', ride.secs.length === 2460, String(ride.secs.length));
check('sample ride has gears, radar and battery', ride.hasGears && ride.hasRadar && ride.hasBattery);
check('sample ride total ascent 115 m', ride.sessionAscent === 115, String(ride.sessionAscent));
check('sample ride FTP 250', ride.ftp === 250, String(ride.ftp));
const events = ride.secs.flatMap(s => s.events);
check('sample ride timer events', JSON.stringify(events) === JSON.stringify(['start', 'lap', 'pause', 'resume', 'pause']), events.join(','));

// ------------------------------------------------------------ 3. example field over the whole ride

const ciq = new Ciq({ ciq: join(tmp, 'no-connectiq') });
const bundle = readBundle(join(SAMPLES, 'example-field'), 'edge1050', 'monkey.jungle', 'eng', ciq);
check('example field: sources read', bundle.sources.length === 2, bundle.sources.map(s => s.file).join(', '));

const drawn = [];
const font = (height) => ({
    height, ascent: Math.round(height * 0.8),
    width: (t) => String(t).length * height * 0.5,
    draw: (ctx, x, y, text) => drawn.push(String(text)),
});
const fontSet = {
    get: (f) => font(typeof f === 'string' ? 30 : 20 + (Number(f) | 0) * 10),
    bitmap: () => font(40),
    vector: () => null,
};
fontSet.builtins = fontSet;
// A canvas context that accepts everything
const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ data: new Uint8ClampedArray(4) })), set: (o, k, v) => { o[k] = v; return true; } });
const device = { id: 'edge1050', width: 480, height: 800, memoryLimit: 131072,
    layouts: [{ name: '1 Field', fields: [{ x: 0, y: 0, w: 480, h: 400, obscurity: [] }] }] };
const sim = new Sim({ bundle, device, fonts: fontSet, ride, ctx, images: new Map(),
    settings: { props: { ftp: 250 }, night: false, weatherMode: 'none', wind: null, userFtp: null, layout: 0, field: 0, others: [] } });
let crashed = null;
for (const k of [0, 30, 600, 1330, 2141, ride.secs.length - 1]) {
    sim.seek(k);
    drawn.length = 0;
    sim.render();
    if (sim.error) { crashed = `${k}: ${sim.error.message || sim.error}`; break; }
}
check('example field runs over the whole ride', !crashed, crashed || '');
sim.seek(2141);
drawn.length = 0;
sim.render();
check('example field draws 3 s power and zone', drawn.includes('218') && drawn.some(t => /Z3/.test(t)), drawn.join(' | '));

// ------------------------------------------------------------ 4. server

const PORT = 8199;
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, APPDATA: join(tmp, 'AppData'), XDG_CONFIG_HOME: join(tmp, '.config') };
const serverArgs = ['--port', String(PORT), SAMPLES];
// start.sh adds --open: the page cannot open in CI (no display), which the server reports and survives
const server = IS_WIN
    ? spawn(process.execPath, [join(ROOT, 'server.mjs'), ...serverArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('sh', [join(ROOT, 'start.sh'), ...serverArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => log += d);
server.stderr.on('data', d => log += d);

function get(path, host = `localhost:${PORT}`) {
    return new Promise((ok, fail) => {
        const r = request({ host: '127.0.0.1', port: PORT, path, headers: { Host: host } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => body += d);
            res.on('end', () => ok({ status: res.statusCode, body }));
        });
        r.on('error', fail);
        r.end();
    });
}
let up = false;
for (let i = 0; i < 50 && !up; i++) {
    try { up = (await get('/api/env')).status === 200; } catch { await new Promise(r => setTimeout(r, 200)); }
}
check('server starts', up, up ? '' : log);
if (up) {
    const e = JSON.parse((await get('/api/env')).body);
    const version = /VERSION = '([^']+)'/.exec(readFileSync(join(ROOT, 'server.mjs'), 'utf8'))[1];
    check('version reported', e.version === version, e.version);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    check('package.json has the same version', pkg.version === version, pkg.version);
    const expected = IS_WIN ? join(tmp, 'AppData', 'Garmin', 'ConnectIQ')
        : platform() === 'darwin' ? join(tmp, 'Library', 'Application Support', 'Garmin', 'ConnectIQ')
        : join(tmp, '.Garmin', 'ConnectIQ');
    check('default Connect IQ folder for this OS', resolve(e.ciq) === resolve(expected), e.ciq);
    check('no SDK found in an empty Connect IQ folder', e.sdk === null && e.ciqFound === false, JSON.stringify({ sdk: e.sdk, ciq: e.ciq }));
    const projects = JSON.parse((await get('/api/projects')).body);
    check('sample project found', JSON.stringify(projects).includes('example-field'));
    const setups = JSON.parse((await get('/api/setups')).body);
    check('sample setup found', JSON.stringify(setups).includes('example.mvlsim.json'));
    check('page served', /<title>MVL Sim<\/title>/.test((await get('/')).body));
    check('README served', (await get('/readme')).body.startsWith('# MVL Sim'));
    const fit = await get('/api/fit?path=' + encodeURIComponent(join(SAMPLES, 'sample-ride.fit')));
    check('FIT file served', fit.status === 200);
    check('foreign Host refused', (await get('/api/env', 'example.com')).status === 403);
}
server.kill();
await new Promise(r => setTimeout(r, 300));
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* still in use on Windows */ }

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
