// MVL Sim page: setups (device + screen layout + what each field shows), FIT loading, screen, map,
// timeline and playback.

import { decodeFit } from './fit.js';
import { buildRide, idleRide, TIMER_ON } from './ride.js';
import { BitmapFont, FontSet, loadDeviceFonts } from './fonts.js';
import { hms } from './sim.js';
import { Screen } from './screen.js';
import { METRICS, DEFAULT_METRICS, UNITS } from './builtin.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const store = {
    get(k, d) { try { const v = localStorage.getItem('mvlsim.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('mvlsim.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const SETUP_EXT = '.mvlsim.json';

const state = {
    env: null, projects: [], devices: [], setups: [],
    setup: null, setupPath: null, dirty: false,
    deviceInfo: null, deviceFonts: null, apps: new Map(), // cache key -> loaded app
    ride: null, rideName: '', screen: null,
    k: 0, playing: false, speed: 10, lastFrame: 0, acc: 0,
};

const screen = $('screen');
const ctx = screen.getContext('2d');

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomControl: true }).setView([50, 10], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);
let trackLine = null, doneLine = null, marker = null, follow = true;
map.on('dragstart', () => { follow = false; });
map.on('click', (e) => {
    if (!state.ride) return;
    // Nearest point on the track -> its second
    let best = -1, bd = Infinity;
    const secs = state.ride.secs;
    for (let i = 0; i < secs.length; i += 1) {
        const s = secs[i];
        if (s.lat == null) continue;
        const d = (s.lat - e.latlng.lat) ** 2 + ((s.lon - e.latlng.lng) * Math.cos(s.lat * Math.PI / 180)) ** 2;
        if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) { follow = true; seek(best); }
});

function drawTrack() {
    if (trackLine) trackLine.remove();
    if (doneLine) doneLine.remove();
    if (marker) marker.remove();
    trackLine = doneLine = marker = null;
    const pts = state.ride.track;
    if (!pts.length) return;
    trackLine = L.polyline(pts, { color: '#3d8bfd', weight: 4, opacity: 0.55 }).addTo(map);
    doneLine = L.polyline([], { color: '#ff7a1a', weight: 4, opacity: 0.9 }).addTo(map);
    marker = L.circleMarker(pts[0], { radius: 8, color: '#fff', weight: 2, fillColor: '#ff7a1a', fillOpacity: 1 }).addTo(map);
    map.fitBounds(trackLine.getBounds(), { padding: [20, 20] });
}

function updateMap() {
    if (!state.ride) return;
    const s = state.ride.secs[state.k];
    if (!marker || s.lat == null) return;
    const ll = [s.lat, s.lon];
    marker.setLatLng(ll);
    doneLine.setLatLngs(state.ride.track.slice(0, s.trackIndex + 1));
    if (follow && !map.getBounds().pad(-0.15).contains(ll)) map.panTo(ll, { animate: false });
}

// ---------------------------------------------------------------- server

async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(await r.text() || `${path}: ${r.status}`);
    return r.json();
}
const projectById = (id) => state.projects.find(p => p.id === id);
const isField = (p) => p && !p.error && p.type === 'datafield';
const appName = (id) => projectById(id)?.name || String(id).split(/[\\/]/).pop();

async function refreshLists() {
    [state.projects, state.setups] = await Promise.all([api('/api/projects'), api('/api/setups')]);
}

// ---------------------------------------------------------------- setups

// A new setup: one app in a 1-field screen, or device data only when there is no data field
function defaultSetup(name, device, appId) {
    const p = projectById(appId) || state.projects.find(isField);
    const dev = device || (p && p.products[0]) || state.devices[0]?.id || 'edge1050';
    return {
        mvlSim: 1, name: name || (p ? p.name : 'New setup'), device: dev, layout: '1 Field',
        fields: [p ? appField(p) : { metric: 'speed' }],
        night: false, weather: 'auto', wind: { bearing: 270, speed: 4 }, userFtp: null,
    };
}
const appField = (p) => ({ app: p.id, jungle: p.jungles[0] || 'monkey.jungle', lang: (p.languages && p.languages[0]) || 'eng', settings: {} });

// Fit the field list to the layout: keep fields by position; apps that no longer fit take the last
// device-data slots; empty slots get default metrics not used yet.
function normalizeFields(setup, layout) {
    const n = layout.fields.length;
    const old = (setup.fields || []).map(f => f && (f.app ? f : { metric: METRICS[f.metric] ? f.metric : 'none' }));
    const out = old.slice(0, n);
    for (const extra of old.slice(n).filter(f => f && f.app)) {
        for (let j = n - 1; j >= 0; j--) if (!out[j] || !out[j].app) { out[j] = extra; break; }
    }
    const used = new Set(out.filter(f => f && f.metric).map(f => f.metric));
    const free = DEFAULT_METRICS.filter(m => !used.has(m));
    for (let i = 0; i < n; i++) if (!out[i]) out[i] = { metric: free.shift() || 'none' };
    setup.fields = out;
}

function markDirty() {
    state.dirty = true;
    saveDraft();
    renderSetupBar();
}
function saveDraft() {
    store.set('draft', { setup: state.setup, path: state.setupPath, dirty: state.dirty });
}

async function openSetupFile(path) {
    const r = await api(`/api/setup?path=${encodeURIComponent(path)}`);
    state.setupPath = r.path;
    state.setup = r.setup;
    state.dirty = false;
    store.set('setupPath', r.path);
    saveDraft();
    await applySetup();
}

async function saveSetup(path) {
    const r = await api(`/api/setup?path=${encodeURIComponent(path)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.setup) });
    state.setupPath = r.path;
    state.dirty = false;
    store.set('setupPath', r.path);
    saveDraft();
    state.setups = await api('/api/setups');
    renderSetupBar();
    setStatus(`saved ${r.path}`);
}

function setupPathFor(name, dir = state.env.setupsDir) {
    const slug = name.trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'setup';
    return dir + (dir.includes('\\') ? '\\' : '/') + slug + SETUP_EXT;
}
const dirOf = (p) => p.replace(/[\\/][^\\/]*$/, '');
const samePath = (a, b) => (a || '').toLowerCase().replace(/[\\/]+$/, '') === (b || '').toLowerCase().replace(/[\\/]+$/, '');

// A folder for setups outside the known ones: the server must know it before it saves there
async function addSetupFolder(p) {
    const r = await api(`/api/setup-folders?path=${encodeURIComponent(p)}`, { method: 'POST' });
    state.env.setupFolders = r.setupFolders;
    const list = store.get('setupFolders', []);
    if (!list.some(x => samePath(x, r.folder))) store.set('setupFolders', [...list, r.folder]);
    return r.folder;
}

// Save as: a name and a folder (the default setups folder, an added folder, a project folder or any other)
async function saveAs() {
    state.env = await api('/api/env'); // folders added since the start
    const dlg = $('saveDlg'), sel = $('saveFolder'), nameIn = $('saveName');
    const roots = state.env.roots || [];
    const label = (d) => samePath(d, state.env.setupsDir) ? `${d}  (default)` : roots.some(r => samePath(r, d)) ? `${d}  (project folder)` : d;
    const cur = state.setupPath ? dirOf(state.setupPath) : store.get('saveFolder', state.env.setupsDir);
    const folders = [...state.env.setupFolders];
    if (cur && !folders.some(d => samePath(d, cur))) folders.push(cur);
    const fill = (pick) => {
        sel.innerHTML = folders.map(d => `<option value="${esc(d)}">${esc(label(d))}</option>`).join('') + '<option value="">Other folder…</option>';
        sel.value = folders.find(d => samePath(d, pick)) || state.env.setupsDir;
    };
    fill(cur);
    let last = sel.value;
    nameIn.value = state.setup.name;
    $('saveMsg').textContent = '';
    const update = () => { $('saveTarget').textContent = sel.value && nameIn.value.trim() ? setupPathFor(nameIn.value, sel.value) : ''; };
    sel.onchange = async () => {
        if (sel.value) { last = sel.value; update(); return; }
        // Other folder…: browse for it, then the server may save there
        const picked = await pickFolder({ title: 'Folder for the setup', start: last, ok: 'Use this folder' });
        if (picked) {
            try {
                const d = await addSetupFolder(picked);
                if (!folders.some(x => samePath(x, d))) folders.push(d);
                last = d;
            } catch (err) { $('saveMsg').textContent = err.message; }
        }
        fill(last);
        update();
    };
    nameIn.oninput = update;
    update();
    $('saveOk').onclick = async (e) => {
        e.preventDefault();
        const name = nameIn.value.trim();
        if (!name) { nameIn.focus(); return; }
        try {
            const dir = sel.value;
            const path = setupPathFor(name, dir);
            if (state.setups.some(s => samePath(s.path, path)) && !samePath(path, state.setupPath)
                && !confirm(`${path} exists. Replace it?`)) return;
            state.setup.name = name;
            store.set('saveFolder', dir);
            dlg.close();
            await saveSetup(path);
        } catch (err) { $('saveMsg').textContent = err.message; }
    };
    dlg.showModal();
    nameIn.select();
}

async function newSetup() {
    if (state.dirty && !confirm('Discard the unsaved changes of this setup?')) return;
    const name = prompt('Name of the new setup:', 'New setup');
    if (!name) return;
    const firstApp = state.setup?.fields.find(f => f.app);
    state.setup = defaultSetup(name.trim(), state.setup?.device, firstApp?.app);
    state.setupPath = null;
    state.dirty = true;
    saveDraft();
    await applySetup();
}

function renderSetupBar() {
    const sel = $('setup');
    const opts = state.setups.map(s => `<option value="${esc(s.path)}" title="${esc(s.path)}"${s.error ? ' disabled' : ''}>${esc(s.name)}${s.error ? ' (unreadable)' : ''}</option>`);
    if (!state.setupPath) opts.unshift(`<option value="">${esc(state.setup?.name || 'New setup')} (not saved)</option>`);
    sel.innerHTML = opts.join('');
    sel.value = state.setupPath || '';
    $('saveSetup').textContent = state.dirty ? 'Save*' : 'Save';
    $('saveSetup').classList.toggle('primary', state.dirty);
    document.title = `MVL Sim – ${state.setup?.name || ''}${state.rideName ? ' – ' + state.rideName : ''}`;
}

// ---------------------------------------------------------------- loading a setup

// Device list: devices of the data fields found first, then everything installed
function renderDeviceSelect() {
    const used = new Set(state.projects.filter(isField).flatMap(p => p.products));
    const byId = new Map(state.devices.map(d => [d.id, d]));
    const opt = (id) => `<option value="${esc(id)}">${esc(byId.get(id)?.name || id)} (${esc(id)})</option>`;
    const usedIds = [...used].filter(id => byId.has(id)).sort();
    const rest = state.devices.map(d => d.id).filter(id => !used.has(id));
    $('device').innerHTML = (usedIds.length ? `<optgroup label="Devices of your data fields">${usedIds.map(opt).join('')}</optgroup>` : '')
        + `<optgroup label="All installed devices">${rest.map(opt).join('')}</optgroup>`;
    if (state.setup && !byId.has(state.setup.device)) $('device').insertAdjacentHTML('afterbegin', `<option value="${esc(state.setup.device)}">${esc(state.setup.device)} (not installed)</option>`);
    $('device').value = state.setup ? state.setup.device : '';
}

// Image load via onload: img.decode() can stay pending while the page is in a background tab
function loadImage(url) {
    return new Promise((ok, bad) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => bad(new Error('cannot load ' + url));
        img.src = url;
    });
}

async function loadApp(f, device) {
    const key = [f.app, device, f.jungle, f.lang].join('|');
    if (state.apps.has(key)) return state.apps.get(key);
    const name = appName(f.app);
    const q = `project=${encodeURIComponent(f.app)}&device=${encodeURIComponent(device)}&jungle=${encodeURIComponent(f.jungle || 'monkey.jungle')}&lang=${encodeURIComponent(f.lang || 'eng')}`;
    const bundle = await api(`/api/app?${q}`);
    const bitmaps = new Map();
    await Promise.all(bundle.fonts.map(async (fo) => {
        bitmaps.set(fo.id, new BitmapFont(fo.id, fo.fnt, await loadImage(fo.png)));
    }));
    // Bitmap resources and layout bitmaps, loaded up front so drawing stays synchronous
    const urls = new Set(bundle.bitmaps.map(b => b.url));
    for (const items of Object.values(bundle.layouts)) for (const it of items) if (it.attrs.url) urls.add(it.attrs.url);
    const images = new Map(), warnings = [...bundle.warnings];
    await Promise.all([...urls].map(async (u) => {
        try { images.set(u, await loadImage(u)); } catch { warnings.push(`Could not load bitmap ${decodeURIComponent(u.split('file=')[1] || u)}`); }
    }));
    const app = { name, bundle, fonts: new FontSet(state.deviceFonts, bitmaps), images, warnings };
    state.apps.set(key, app);
    return app;
}

// (Re)build everything from state.setup: device, layout, apps, screen
async function applySetup() {
    const s = state.setup;
    showError(null);
    setStatus('Loading…');
    try {
        if (!state.deviceInfo || state.deviceInfo.id !== s.device) {
            state.deviceInfo = await api(`/api/device?id=${encodeURIComponent(s.device)}`);
            state.deviceFonts = await loadDeviceFonts(state.deviceInfo);
            state.apps.clear();
        }
    } catch (e) {
        state.screen = null;
        renderDeviceSelect(); renderSetupBar();
        setStatus(''); showError(e.message); drawIdle('Device not available');
        return;
    }
    const dev = state.deviceInfo;
    let li = dev.layouts.findIndex(l => l.name === s.layout);
    if (li < 0) { li = 0; s.layout = dev.layouts[0].name; }
    normalizeFields(s, dev.layouts[li]);
    state.layoutIndex = li;
    screen.width = dev.width; screen.height = dev.height;
    screen.classList.toggle('pixel', dev.width < 400);
    screen.classList.toggle('round', dev.shape === 'round');
    autoColumns(); fitScreen();

    const warnings = [...(state.startWarnings || []), ...dev.warnings, ...state.deviceFonts.warnings];
    state.loaded = await Promise.all(s.fields.map(async (f, i) => {
        if (!f.app) return null;
        const p = projectById(f.app);
        if (p && !p.products.includes(s.device)) warnings.push(`Field ${i + 1}: ${p.name} does not list ${s.device} in its manifest.`);
        try {
            const a = await loadApp(f, s.device);
            for (const w of a.warnings) warnings.push(`Field ${i + 1} (${a.name}): ${w}`);
            return a;
        } catch (e) { return { name: appName(f.app), loadError: e.message }; }
    }));
    renderDeviceSelect();
    $('layout').innerHTML = dev.layouts.map((l, i) => `<option value="${i}">${esc(l.name)}</option>`).join('');
    $('layout').value = String(li);
    renderSetupBar();
    renderFields();
    renderSettings();
    showWarnings(warnings);
    setStatus('');
    startScreen();
}

function commonSettings() {
    const s = state.setup;
    let mode = s.weather || 'auto';
    if (mode === 'auto') mode = state.ride && state.ride.hasWeather ? 'fit' : 'manual';
    return { night: !!s.night, weatherMode: mode, wind: s.wind || { bearing: 270, speed: 4 }, userFtp: s.userFtp ?? null, radarBar: s.radarBar !== false,
        units: s.units === 'statute' ? 'statute' : 'metric', clock12: !!s.clock12 };
}

// The ride the screen runs on: the open FIT file, else an Edge that is on but not recording
let idle = null;
function curRide() { return state.ride || (idle ??= idleRide()); }

function startScreen() {
    if (!state.setup || !state.deviceInfo) { state.screen = null; drawIdle(); return; }
    const ride = curRide();
    const fields = state.setup.fields.map((f, i) => {
        if (!f.app) return { metric: f.metric };
        const a = state.loaded[i];
        if (!a || a.loadError) return { app: { name: a?.name || appName(f.app), loadError: a?.loadError || 'not loaded' } };
        return { app: { ...a, props: f.settings || {} } };
    });
    state.screen = new Screen({ device: state.deviceInfo, layoutIndex: state.layoutIndex, fields, ride, ctx,
        common: commonSettings(), deviceFonts: state.deviceFonts.fonts });
    const k = Math.min(state.k, ride.secs.length - 1);
    state.k = -1;
    seek(Math.max(0, k));
}

function drawIdle(text) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, screen.width, screen.height);
    ctx.fillStyle = '#888'; ctx.font = `${Math.round(screen.width / 16)}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(text ?? '', screen.width / 2, screen.height / 2);
    ctx.textAlign = 'left';
}

// ---------------------------------------------------------------- fields panel

function renderFields() {
    const s = state.setup, dev = state.deviceInfo;
    const layout = dev.layouts[state.layoutIndex];
    const apps = state.projects.filter(isField);
    const metricOpts = Object.entries(METRICS).map(([id, m]) => [`m:${id}`, id === 'none' ? '(empty)' : m.label]);
    const rows = layout.fields.map((loc, i) => {
        const f = s.fields[i];
        const val = f.app ? `a:${f.app}` : `m:${f.metric}`;
        const appOpts = apps.map(p => `<option value="a:${esc(p.id)}"${val === 'a:' + p.id ? ' selected' : ''} title="${esc(p.id)}">${esc(p.name)}${p.products.includes(s.device) ? '' : ' (not for this device)'}</option>`);
        if (f.app && !projectById(f.app)) appOpts.push(`<option value="a:${esc(f.app)}" selected>${esc(appName(f.app))} (not found)</option>`);
        const obsc = loc.obscurity.length ? ` <span class="muted" title="getObscurityFlags()">${esc(loc.obscurity.join(','))}</span>` : '';
        let html = `<div class="fieldrow"><label>Field ${i + 1}${obsc}<select data-i="${i}" class="pick">`
            + (appOpts.length ? `<optgroup label="Connect IQ data fields">${appOpts.join('')}</optgroup>` : '')
            + `<optgroup label="Device data">${metricOpts.map(([v, l]) => `<option value="${v}"${v === val ? ' selected' : ''}>${esc(l)}</option>`).join('')}</optgroup></select></label>`;
        if (f.app) html += appDetails(f, i);
        return html + '</div>';
    });
    $('fields').innerHTML = rows.join('');
    $('fields').querySelectorAll('select.pick').forEach(sel => sel.addEventListener('change', onPick));
    $('fields').querySelectorAll('[data-app]').forEach(el => el.addEventListener('change', onAppSetting));
}

// Jungle, language and the app's own settings, under its field
function appDetails(f, i) {
    const p = projectById(f.app);
    const a = state.loaded && state.loaded[i];
    const parts = [];
    if (p && p.jungles.length > 1) parts.push(`<label>Jungle<select data-app="jungle" data-i="${i}">${p.jungles.map(j => `<option${j === f.jungle ? ' selected' : ''}>${esc(j)}</option>`).join('')}</select></label>`);
    const langs = p && p.languages.length ? p.languages : [];
    if (langs.length > 1) parts.push(`<label>Language<select data-app="lang" data-i="${i}">${langs.map(l => `<option${l === f.lang ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`);
    if (a && a.bundle && a.bundle.properties.length) {
        const strings = a.bundle.strings;
        const title = (t) => t ? (strings[t.replace(/^@Strings\./, '')] ?? t) : null;
        const set = f.settings || {};
        const props = a.bundle.properties.map(pr => {
            const v = pr.id in set ? set[pr.id] : pr.value;
            const def = a.bundle.settings.find(x => x.key === pr.id);
            const name = esc(title(def?.title) || pr.id), tip = esc(pr.id), d = `data-app="prop" data-i="${i}" data-prop="${esc(pr.id)}"`;
            if (def && def.options.length) return `<label title="${tip}">${name}<select ${d}>${def.options.map(o =>
                `<option value="${esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(title(o.label) || o.value)}</option>`).join('')}</select></label>`;
            if (pr.type === 'boolean') return `<label title="${tip}">${name}<input type="checkbox" ${d} ${v === true || v === 'true' ? 'checked' : ''}></label>`;
            return `<label title="${tip}">${name}<input type="${pr.type === 'string' ? 'text' : 'number'}" ${d} value="${esc(v)}"${pr.type === 'float' ? ' step="any"' : ''}></label>`;
        });
        parts.push(`<details${store.get('open.' + f.app, false) ? ' open' : ''} data-open="${esc(f.app)}"><summary>Settings (${props.length})</summary>${props.join('')}</details>`);
    }
    return parts.length ? `<div class="appdetails">${parts.join('')}</div>` : '';
}

async function onPick(e) {
    const i = +e.target.dataset.i, v = e.target.value, s = state.setup;
    if (v.startsWith('m:')) {
        const wasApp = !!s.fields[i].app;
        s.fields[i] = { metric: v.slice(2) };
        markDirty();
        if (wasApp) return applySetup();
        if (state.screen) { state.screen.fields[i].metric = v.slice(2); render(); }
        return;
    }
    const p = projectById(v.slice(2));
    if (!p) return;
    s.fields[i] = appField(p);
    markDirty();
    await applySetup();
}

function onAppSetting(e) {
    const t = e.target, i = +t.dataset.i, f = state.setup.fields[i];
    if (t.dataset.app === 'prop') {
        f.settings = { ...(f.settings || {}), [t.dataset.prop]: t.type === 'checkbox' ? t.checked : t.value };
        markDirty();
        // Only this app replays with the new setting
        const fs = state.screen && state.screen.fields[i];
        if (fs && fs.sim) { fs.sim.settings = { ...fs.sim.settings, props: f.settings }; fs.sim.reset(); const k = state.k; state.k = -1; seek(k); }
        return;
    }
    f[t.dataset.app] = t.value; // jungle / lang
    markDirty();
    applySetup();
}
document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.dataset.open) store.set('open.' + d.dataset.open, d.open);
}, true);

// ---------------------------------------------------------------- setup settings (shared by all fields)

function renderSettings() {
    const s = state.setup;
    if (!s) return;
    const rows = [];
    const fitFtp = state.ride && state.ride.ftp != null ? state.ride.ftp : '–';
    rows.push(`<label title="UserProfile.getFunctionalThresholdPower(); empty = the FIT file's own FTP">User profile FTP <span><input type="number" id="userFtp" value="${s.userFtp ?? ''}" placeholder="${fitFtp}"> W</span></label>`);
    rows.push(`<label title="The device's unit settings: System.getDeviceSettings() distanceUnits, elevationUnits, temperatureUnits ..., and the device's own fields">Units <select id="units"><option value="metric">metric</option><option value="statute">statute (mi, ft, °F)</option></select></label>`);
    rows.push(`<label title="System.getDeviceSettings().is24Hour, and the Time of Day field (3:53, no AM/PM, as on the Edge)">12-hour clock<input type="checkbox" id="clock12" ${s.clock12 ? 'checked' : ''}></label>`);
    rows.push(`<label>Night (black background)<input type="checkbox" id="night" ${s.night ? 'checked' : ''}></label>`);
    const rd = state.ride && state.ride.hasRadar ? '' : ' (no radar in this ride)';
    rows.push(`<label title="The device's own radar strip on the right edge while a vehicle is behind">Radar bar${rd}<input type="checkbox" id="radarBar" ${s.radarBar !== false ? 'checked' : ''}></label>`);
    const fitW = state.ride && state.ride.hasWeather ? 'from FIT' : 'from FIT (none in this file)';
    rows.push(`<label>Weather <select id="weatherMode">
        <option value="auto">auto</option><option value="fit">${fitW}</option>
        <option value="manual">manual wind</option><option value="none">none (null)</option></select></label>`);
    const w = s.wind || { bearing: 270, speed: 4 };
    rows.push(`<label>Wind from (°) / speed (m/s)<span><input type="number" id="windBearing" value="${w.bearing}" step="10">
        <input type="number" id="windSpeed" value="${w.speed}" step="0.5"></span></label>`);
    rows.push(`<div class="muted" style="font-size:11px">Changing a setting replays the ride from the start with it.</div>`);
    $('settings').innerHTML = rows.join('');
    $('weatherMode').value = s.weather || 'auto';
    $('units').value = s.units === 'statute' ? 'statute' : 'metric';
    $('settings').querySelectorAll('input,select').forEach(inp => inp.addEventListener('change', onSettingChange));
}

function onSettingChange(e) {
    const s = state.setup, t = e.target;
    if (t.id === 'userFtp') s.userFtp = t.value === '' ? null : +t.value;
    else if (t.id === 'night') s.night = t.checked;
    else if (t.id === 'radarBar') s.radarBar = t.checked;
    else if (t.id === 'weatherMode') s.weather = t.value;
    else if (t.id === 'units') s.units = t.value;
    else if (t.id === 'clock12') s.clock12 = t.checked;
    else if (t.id === 'windBearing') s.wind = { ...s.wind, bearing: +t.value };
    else if (t.id === 'windSpeed') s.wind = { ...s.wind, speed: +t.value };
    markDirty();
    if (!state.screen) return;
    state.screen.setCommon(commonSettings());
    if (t.id === 'night' || t.id === 'radarBar') { render(); return; } // display only
    state.screen.reset();
    const k = state.k;
    state.k = -1;
    seek(k);
}

// ---------------------------------------------------------------- FIT

async function loadFitBuffer(buf, name) {
    setStatus('Reading FIT…');
    try {
        state.ride = buildRide(decodeFit(buf));
    } catch (e) {
        showError(`FIT: ${e.message}`);
        setStatus('');
        return;
    }
    state.rideName = name;
    setStatus('');
    state.k = 0;
    renderSetupBar();
    drawTrack();
    renderSettings();
    startScreen();
    drawTimeline();
}

async function loadFitPath(p) {
    p = p.trim().replace(/^"|"$/g, '');
    if (!p) return;
    const r = await fetch(`/api/fit?path=${encodeURIComponent(p)}`);
    if (!r.ok) { showError(`Could not read ${p}: ${await r.text()}`); return; }
    store.set('fitPath', p);
    $('fitPath').value = p;
    await loadFitBuffer(await r.arrayBuffer(), p.split(/[\\/]/).pop());
}

// Folder dialog: browse the local folders through the server (a page cannot read a local path itself).
// Resolves to the chosen folder, or null when cancelled.
function pickFolder({ title, start, ok = 'Choose this folder', hint = '', check = null }) {
    const dlg = $('folderDlg');
    $('fdTitle').textContent = title;
    $('fdOk').textContent = ok;
    $('fdHint').textContent = hint;
    let cur = null;
    const show = async (p) => {
        $('fdMsg').textContent = '';
        try {
            const r = await api(`/api/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
            cur = r;
            $('fdPath').value = r.path;
            $('fdUp').disabled = !r.parent;
            $('fdPlaces').innerHTML = r.places.map(x => `<button type="button" data-path="${esc(x.path)}">${esc(x.name)}</button>`).join('');
            $('fdList').innerHTML = r.dirs.length
                ? r.dirs.map(d => `<div class="fditem" data-path="${esc(d.path)}">📁 ${esc(d.name)}${d.project ? ' <span class="tag">Connect IQ project</span>' : ''}</div>`).join('')
                : '<div class="muted" style="padding:6px">no subfolders</div>';
            const notes = [];
            if (r.project) notes.push('This folder is a Connect IQ project.');
            if (r.setups) notes.push(`${r.setups} setup file${r.setups > 1 ? 's' : ''} here.`);
            $('fdInfo').textContent = notes.join(' ');
        } catch (e) { $('fdMsg').textContent = e.message; }
    };
    return new Promise((done) => {
        const finish = (v) => { dlg.onclose = null; dlg.close(); done(v); };
        $('fdPlaces').onclick = (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.path); };
        $('fdList').onclick = (e) => { const d = e.target.closest('.fditem'); if (d) show(d.dataset.path); };
        $('fdUp').onclick = () => { if (cur && cur.parent) show(cur.parent); };
        $('fdPath').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); show($('fdPath').value.trim().replace(/^"|"$/g, '')); } };
        $('fdCancel').onclick = (e) => { e.preventDefault(); finish(null); };
        dlg.onclose = () => done(null);
        $('fdOk').onclick = async (e) => {
            e.preventDefault();
            if (!cur) return;
            if (check) {
                const err = await check(cur.path);
                if (err) { $('fdMsg').textContent = err; return; }
            }
            finish(cur.path);
        };
        dlg.showModal();
        show(start || null);
    });
}

async function addRoot() {
    const p = await pickFolder({
        title: 'Add a folder with Connect IQ data fields', start: store.get('lastBrowse', null), ok: 'Add this folder',
        hint: 'A project folder (with manifest.xml) or a folder with projects below it (up to 3 levels).',
        check: async (path) => {
            try { await api(`/api/roots?path=${encodeURIComponent(path)}`, { method: 'POST' }); return null; }
            catch (e) { return e.message; }
        },
    });
    if (!p) return;
    try {
        const r = await api(`/api/roots?path=${encodeURIComponent(p)}`, { method: 'POST' });
        const roots = store.get('roots', []);
        if (!roots.includes(r.root)) store.set('roots', [...roots, r.root]);
        store.set('lastBrowse', dirOf(r.root));
        state.startWarnings = null;
        await refreshLists();
        renderSetupBar();
        if (state.setup) { renderDeviceSelect(); renderFields(); }
        setStatus(`added ${r.root}: pick its data fields in the Fields list`);
    } catch (e) { showError(e.message); }
}

// ---------------------------------------------------------------- playback

function seek(k) {
    if (!state.screen) return;
    k = Math.max(0, Math.min(curRide().secs.length - 1, Math.round(k)));
    const ms = state.screen.seek(k);
    state.k = k;
    render();
    if (ms > 40) setStatus(`replayed in ${ms.toFixed(0)} ms`);
}

function render() {
    const sc = state.screen;
    if (!sc) return;
    sc.render();
    const errs = [];
    sc.fields.forEach((f, i) => {
        const who = `Field ${i + 1} (${f.app ? f.app.name : ''})`;
        if (f.app && f.app.loadError) errs.push(`${who}: cannot load\n${f.app.loadError}`);
        else if (f.translateError) errs.push(`${who}: translate error\n${f.translateError}`);
        else if (f.sim && f.sim.error) {
            const e = f.sim.error;
            errs.push(`${who}: IQ! ${e.message}\n  at ${e.where}\n  ride time ${hms(e.k)}${e.js ? '\n  (simulator-side error: see the browser console)' : ''}`);
        }
    });
    showError(errs.length ? errs.join('\n\n') : null);
    updateMap();
    updatePanel();
    drawTimeline();
}

function updatePanel() {
    const r = curRide(), s = r.secs[state.k], sc = state.screen;
    const t = s.t - r.tStart;
    const u = UNITS[state.setup && state.setup.units === 'statute' ? 'statute' : 'metric'];
    const clock = new Date((s.t + r.epoch + r.localOffset) * 1000).toISOString().slice(11, 19);
    $('clock').textContent = r.idle ? `no ride: the device is on, not recording   ${clock}` : `${hms(t)} / ${hms(r.secs.length - 1)}   ${clock}`;
    const timer = ['off', 'stopped', 'paused', 'on'][s.timer];
    const g = s.gear;
    const gears = g.fIdx == null ? '–' : `${g.fSize}×${g.rSize} (${g.fIdx}/${s.frontMax ?? '?'} – ${g.rIdx}/${s.rearMax ?? '?'})`;
    let radar = r.hasRadar ? 'off' : 'no data';
    if (s.radar) {
        const n = s.radar.speeds.filter((v, i) => v > 0).length;
        const near = s.radar.ranges.map((x, i) => ({ x, v: s.radar.speeds[i] })).filter(o => o.v > 0).sort((a, b) => a.x - b.x)[0];
        radar = n ? `${n} target${n > 1 ? 's' : ''}, nearest ${Math.round(near.x / u.shortLen)} ${u.shortName} at ${Math.round(u.speed(near.v))} ${u.speedName}` : 'on, clear';
    }
    const sim0 = sc && sc.sims[0];
    const w = sim0 ? sim0.env.weather() : null;
    const st = s.stats;
    const rows = [
        ['Timer', `${timer} (${hms(s.timerMs / 1000)})`],
        ['Speed', s.speed == null ? '–' : `${u.speed(s.speed).toFixed(1)} ${u.speedName}`],
        ['Power', s.power == null ? '–' : `${s.power}${st.avgPower != null ? ` (avg ${Math.round(st.avgPower)}, max ${st.maxPower})` : ''}`],
        ['Heart rate', s.hr ?? '–'], ['Cadence', s.cadence ?? '–'],
        ['Altitude', s.altitude == null ? '–' : `${u.length(s.altitude).toFixed(1)} ${u.lengthName}`],
        ['Ascent / descent', `${Math.round(u.length(s.totalAscent))} / ${Math.round(u.length(s.totalDescent))} ${u.lengthName}${r.sessionAscent != null ? ` (ride ${Math.round(u.length(r.sessionAscent))})` : ''}`],
        ['Distance', `${u.distance(s.distance).toFixed(2)} ${u.distanceName}`],
        ['Heading', s.heading == null ? '–' : `${Math.round((s.heading * 180 / Math.PI + 360) % 360)}°`],
        ['Gears', gears], ['Radar', radar],
        ['Wind', w ? `from ${w.bearing}° at ${(+w.speed).toFixed(1)} m/s${u === UNITS.statute ? ` (${u.speed(+w.speed).toFixed(1)} mph)` : ''}` : sim0 ? 'none' : '–'],
        ['Battery', s.battery != null ? `${s.battery} %` : '80 % (not in the file)'],
    ];
    $('inputs').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td class="num">${esc(b)}</td></tr>`).join('');

    // FIT fields and println output of every app, labelled by field
    const ff = [], logs = [];
    const several = sc ? sc.sims.length > 1 : false;
    if (sc) sc.fields.forEach((f, i) => {
        if (!f.sim) return;
        const tag = `${i + 1}: ${f.app.name}`;
        for (const x of f.sim.fitFields.values()) {
            const v = Array.isArray(x.v) ? x.v.map(y => f.sim.rt.$.str(y)).join(',') : f.sim.rt.$.str(x.v);
            const msg = { 18: 'session', 19: 'lap', 20: 'record' }[x.meta.mesgType] || x.meta.mesgType;
            ff.push(`<tr><td>${esc(x.meta.name)} <span class="muted">(${esc(msg)}${several ? ', ' + esc(tag) : ''})</span></td><td class="num">${esc(v)}</td></tr>`);
        }
        for (const l of f.sim.logLines.slice(-200)) logs.push(several ? `[${tag}] ${l}` : l);
    });
    $('fitFields').innerHTML = ff.join('') || '<tr><td class="muted">none</td></tr>';
    const log = $('log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.textContent = logs.slice(-300).join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
}

function frame(ts) {
    if (state.playing && state.screen) {
        const dt = state.lastFrame ? (ts - state.lastFrame) / 1000 : 0;
        state.acc += dt * state.speed;
        const steps = Math.floor(state.acc);
        if (steps > 0) {
            state.acc -= steps;
            const n = curRide().secs.length;
            const target = Math.min(n - 1, state.k + steps);
            seek(target);
            if (target >= n - 1) setPlaying(false);
        }
    }
    state.lastFrame = ts;
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function setPlaying(p) {
    state.playing = p && !!state.screen;
    state.acc = 0;
    $('play').textContent = state.playing ? 'Pause' : 'Play';
    if (state.playing) follow = true;
}

// ---------------------------------------------------------------- timeline

const tl = $('timeline');
const tctx = tl.getContext('2d');
let tlCache = null;

function drawTimeline() {
    const dpr = window.devicePixelRatio || 1;
    const W = tl.clientWidth, H = tl.clientHeight;
    if (tl.width !== Math.round(W * dpr) || tl.height !== Math.round(H * dpr)) {
        tl.width = Math.round(W * dpr); tl.height = Math.round(H * dpr); tlCache = null;
    }
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, W, H);
    if (!state.ride) {
        tctx.fillStyle = '#9aa0a8'; tctx.font = '13px system-ui'; tctx.textAlign = 'center';
        tctx.fillText('Open or drop a .fit file to play a ride through the screen', W / 2, H / 2);
        tctx.textAlign = 'left';
        return;
    }
    if (!tlCache || tlCache.ride !== state.ride || tlCache.W !== W) tlCache = buildTimelineImage(W, H, dpr);
    tctx.drawImage(tlCache.img, 0, 0, W, H);
    const n = state.ride.secs.length;
    const x = (state.k / (n - 1)) * W;
    tctx.fillStyle = '#ff7a1a';
    tctx.fillRect(Math.round(x) - 1, 0, 2, H);
}

function buildTimelineImage(W, H, dpr) {
    const c = document.createElement('canvas');
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const secs = state.ride.secs, n = secs.length;
    const px = (i) => (i / (n - 1)) * W;
    // Paused stretches
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < n; i++) if (secs[i].timer !== TIMER_ON) g.fillRect(px(i), 0, Math.max(1, W / n), H);
    // Altitude area
    const alts = secs.map(s => s.altitude).filter(a => a != null);
    if (alts.length) {
        const lo = Math.min(...alts), hi = Math.max(...alts), span = Math.max(10, hi - lo);
        g.beginPath(); g.moveTo(0, H);
        for (let x = 0; x <= W; x++) {
            const s = secs[Math.min(n - 1, Math.round(x / W * (n - 1)))];
            const a = s.altitude ?? lo;
            g.lineTo(x, H - 6 - (a - lo) / span * (H * 0.55));
        }
        g.lineTo(W, H); g.closePath();
        g.fillStyle = '#3a4048'; g.fill();
    }
    // Power, 30 s average per pixel column
    const hasPower = secs.some(s => s.power != null);
    if (hasPower) {
        const maxP = 600;
        g.beginPath();
        for (let x = 0; x <= W; x++) {
            const i0 = Math.round(x / W * (n - 1));
            let sum = 0, cnt = 0;
            for (let i = Math.max(0, i0 - 15); i < Math.min(n, i0 + 15); i++) if (secs[i].power != null) { sum += secs[i].power; cnt++; }
            const p = cnt ? sum / cnt : 0;
            const y = H - 4 - Math.min(1, p / maxP) * (H - 10);
            if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.strokeStyle = 'rgba(61,139,253,0.85)'; g.lineWidth = 1; g.stroke();
    }
    // Radar: a tick where a vehicle is behind
    if (state.ride.hasRadar) {
        g.fillStyle = '#ffcc00';
        for (let i = 0; i < n; i++) {
            const r = secs[i].radar;
            if (r && r.speeds.some(v => v > 0)) g.fillRect(px(i), 0, Math.max(1, W / n), 5);
        }
    }
    g.fillStyle = '#9aa0a8'; g.font = '10px system-ui';
    g.fillText('altitude (grey) · power 30 s (blue) · radar (yellow) · paused (light)', 6, 16);
    return { img: c, ride: state.ride, W };
}

let dragging = false;
function tlSeek(e) {
    if (!state.ride) return;
    const r = tl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    follow = true;
    seek(f * (state.ride.secs.length - 1));
}
tl.addEventListener('pointerdown', (e) => { dragging = true; tl.setPointerCapture(e.pointerId); tlSeek(e); });
tl.addEventListener('pointermove', (e) => { if (dragging) tlSeek(e); });
tl.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('resize', () => { tlCache = null; drawTimeline(); });

// ---------------------------------------------------------------- controls

const fail = (e) => { showError(e.message); console.error(e); };
$('setup').addEventListener('change', async () => {
    const p = $('setup').value;
    if (!p) return;
    if (state.dirty && !confirm('Discard the unsaved changes of this setup?')) { renderSetupBar(); return; }
    await openSetupFile(p).catch(fail);
});
$('newSetup').addEventListener('click', () => newSetup().catch(fail));
$('saveSetup').addEventListener('click', () => (state.setupPath ? saveSetup(state.setupPath) : saveAs()).catch(fail));
$('saveAs').addEventListener('click', () => saveAs().catch(fail));
$('device').addEventListener('change', () => { state.setup.device = $('device').value; markDirty(); applySetup().catch(fail); });
$('layout').addEventListener('change', () => {
    state.setup.layout = state.deviceInfo.layouts[+$('layout').value].name;
    markDirty();
    applySetup().catch(fail);
});
$('reload').addEventListener('click', async () => {
    state.apps.clear();
    await refreshLists().catch(fail);
    applySetup().catch(fail);
});
$('addRoot').addEventListener('click', () => addRoot().catch(fail));
$('play').addEventListener('click', () => setPlaying(!state.playing));
$('speed').addEventListener('change', (e) => { state.speed = +e.target.value; });
$('back60').addEventListener('click', () => seek(state.k - 60));
$('back1').addEventListener('click', () => seek(state.k - 1));
$('fwd1').addEventListener('click', () => seek(state.k + 1));
$('fwd60').addEventListener('click', () => seek(state.k + 60));
$('openBtn').addEventListener('click', () => $('fitFile').click());
$('fitFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await loadFitBuffer(await f.arrayBuffer(), f.name);
});
$('loadPath').addEventListener('click', () => loadFitPath($('fitPath').value));
$('fitPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFitPath($('fitPath').value); });
// Compile check: every Connect IQ field of the setup, one after the other
$('checkBtn').addEventListener('click', async () => {
    const s = state.setup;
    const seen = new Set(), jobs = [];
    for (const f of s ? s.fields : []) {
        if (!f.app) continue;
        const key = f.app + '|' + f.jungle;
        if (!seen.has(key)) { seen.add(key); jobs.push(f); }
    }
    const out = $('check');
    out.className = ''; out.style.color = '';
    if (!jobs.length) { out.textContent = 'No Connect IQ data field in this setup.'; out.className = 'muted'; return; }
    let text = '', allOk = true;
    for (const f of jobs) {
        out.textContent = text + `${appName(f.app)}: running monkeyc…`;
        try {
            const j = await api(`/api/check?project=${encodeURIComponent(f.app)}&device=${encodeURIComponent(s.device)}&jungle=${encodeURIComponent(f.jungle)}`, { method: 'POST' });
            allOk = allOk && j.ok;
            text += `${appName(f.app)}: ${j.ok ? 'OK' : 'FAILED'}\n${j.output}\n\n`;
        } catch (e) { allOk = false; text += `${appName(f.app)}: ${e.message}\n\n`; }
    }
    out.textContent = text.trim();
    out.style.color = allOk ? 'var(--ok)' : 'var(--err)';
});
state.speed = +$('speed').value;
screen.addEventListener('click', () => {
    const on = !screen.classList.contains('actual');
    screen.classList.toggle('actual', on);
    $('screenWrap').classList.toggle('actual', on);
    store.set('actual', on);
    fitScreen();
});
if (store.get('actual', false)) { screen.classList.add('actual'); $('screenWrap').classList.add('actual'); }

window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if ($('saveDlg').open || $('folderDlg').open) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!state.playing); }
    else if (e.key === 'ArrowLeft') seek(state.k - (e.shiftKey ? 60 : 1));
    else if (e.key === 'ArrowRight') seek(state.k + (e.shiftKey ? 60 : 1));
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(Infinity);
});
window.addEventListener('beforeunload', (e) => { if (state.dirty && state.setupPath) saveDraft(); });

// Drag and drop a FIT file anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').style.display = 'flex'; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) $('drop').style.display = 'none'; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; $('drop').style.display = 'none';
    const f = e.dataTransfer.files[0];
    if (f) await loadFitBuffer(await f.arrayBuffer(), f.name);
});

function showError(msg) {
    const el = $('error');
    el.style.display = msg ? 'block' : 'none';
    el.textContent = msg || '';
}
function showWarnings(list) {
    const el = $('warnings');
    el.style.display = list.length ? 'block' : 'none';
    el.innerHTML = list.map(w => `<div>⚠ ${esc(w)}</div>`).join('');
}
function setStatus(s) { $('status').textContent = s; }

// ---------------------------------------------------------------- start

async function init() {
    // Folders added in the page before: register them again with this server run
    for (const root of store.get('roots', [])) {
        try { await api(`/api/roots?path=${encodeURIComponent(root)}`, { method: 'POST' }); } catch { /* moved or deleted */ }
    }
    for (const d of store.get('setupFolders', [])) {
        try { await api(`/api/setup-folders?path=${encodeURIComponent(d)}`, { method: 'POST' }); } catch { /* moved or deleted */ }
    }
    [state.env, state.devices] = await Promise.all([api('/api/env'), api('/api/devices')]);
    $('version').textContent = state.env.version || '';
    await refreshLists();
    const params = new URLSearchParams(location.search);
    const draft = store.get('draft', null);
    const want = params.get('setup');
    const appParam = params.get('project') || params.get('app');
    if (want) await openSetupFile(want);
    else if (appParam) {
        // Old-style link: one app in a 1-field screen
        const p = state.projects.find(x => x.id === appParam || x.name === appParam || x.name.endsWith('/' + appParam));
        state.setup = defaultSetup(null, params.get('device'), p?.id);
        if (p && params.get('jungle')) state.setup.fields[0].jungle = params.get('jungle');
        state.setupPath = null; state.dirty = false;
        await applySetup();
    } else if (draft && draft.setup && (draft.dirty || !draft.path)) {
        state.setup = draft.setup; state.setupPath = draft.path || null; state.dirty = !!draft.dirty;
        await applySetup();
    } else if (store.get('setupPath', null) && state.setups.some(s => s.path === store.get('setupPath'))) {
        await openSetupFile(store.get('setupPath'));
    } else {
        state.setup = defaultSetup();
        state.setupPath = null; state.dirty = false;
        if (!state.projects.some(isField)) state.startWarnings = ([state.projects.length
            ? 'None of the projects found is a data field. MVL Sim runs data fields only (stage 1); the screen shows device data.'
            : 'No Connect IQ project found. Paste a project folder (or a folder with projects below it) into "Add folder".']);
        await applySetup();
    }
    const fitPath = params.get('fit') || store.get('fitPath', '');
    $('fitPath').value = fitPath;
    if (fitPath) await loadFitPath(fitPath);
    if (params.get('t') && state.ride) seek(+params.get('t'));
}

init().catch(fail);

// Keeps the server running while this page is open (a server started by start.cmd stops shortly
// after its last page closes). Tells the user when the server has gone.
const alive = new EventSource('/api/alive');
let serverLost = false;
alive.onopen = () => { if (serverLost) { serverLost = false; setStatus('server back'); } };
alive.onerror = () => { if (!serverLost) { serverLost = true; setStatus('The MVL Sim server has stopped: start it again (start.cmd), then reload this page'); } };

// ---------------------------------------------------------------- resizable layout

// The device screen fills its column (keeping the device's aspect ratio) unless "actual pixels" is on.
// The dividers between screen, map and side panel can be dragged; double-click resets one.
const mainEl = document.querySelector('main');
const wrapEl = $('screenWrap');
const SCREEN_PAD = 2 * 10 + 2 * 6; // #screenWrap padding + #screen border

function fitScreen() {
    if (screen.classList.contains('actual')) { screen.style.width = screen.style.height = ''; return; }
    const W = wrapEl.clientWidth - SCREEN_PAD, H = wrapEl.clientHeight - SCREEN_PAD;
    const s = Math.min(W / screen.width, H / screen.height);
    if (!(s > 0)) return;
    screen.style.width = `${Math.floor(screen.width * s)}px`;
    screen.style.height = `${Math.floor(screen.height * s)}px`;
}

// Without a dragged width, the screen column is as wide as the screen at full column height
function autoColumns() {
    const sw = store.get('screenW', null);
    if (sw) mainEl.style.setProperty('--screenW', `${sw}px`);
    else {
        const h = mainEl.clientHeight - SCREEN_PAD;
        const w = Math.round(h * screen.width / screen.height) + SCREEN_PAD;
        mainEl.style.setProperty('--screenW', `${Math.max(140, Math.min(w, Math.round(innerWidth * 0.5)))}px`);
    }
    const aw = store.get('asideW', null);
    mainEl.style.setProperty('--asideW', `${aw || 320}px`);
}

for (const sp of document.querySelectorAll('.split')) {
    const col = sp.dataset.col;
    sp.addEventListener('pointerdown', (e) => {
        sp.setPointerCapture(e.pointerId);
        sp.classList.add('drag'); document.body.classList.add('dragging');
        const move = (ev) => {
            const r = mainEl.getBoundingClientRect();
            const w = col === 'screenW' ? ev.clientX - r.left : r.right - ev.clientX;
            const px = Math.round(Math.max(140, Math.min(w, r.width - 260)));
            mainEl.style.setProperty('--' + col, `${px}px`);
            store.set(col, px);
        };
        const up = () => {
            sp.classList.remove('drag'); document.body.classList.remove('dragging');
            sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up);
        };
        sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => { store.set(col, null); autoColumns(); });
}

new ResizeObserver(fitScreen).observe(wrapEl);
new ResizeObserver(() => map.invalidateSize({ animate: false })).observe($('map'));
window.addEventListener('resize', autoColumns);
autoColumns();
