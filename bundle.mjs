// Reads a Connect IQ project into what the browser needs for one device, jungle and language:
// the sources, annotations to exclude, and the resources (fonts, strings, properties, settings,
// bitmaps, JSON data, layouts). Also finds projects under a folder and reads device files.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, basename, sep } from 'node:path';
import { Jungle, ensureDeviceChain } from './jungle.mjs';

// ---------------------------------------------------------------- minimal XML

export function parseXml(text) {
    const root = { tag: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) top.text += m[1];
        else if (m[2]) { if (stack.length > 1) stack.pop(); }
        else if (m[3]) {
            const attrs = {};
            for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unxml(a[2] ?? a[3]);
            const el = { tag: m[3], attrs, children: [], text: '' };
            top.children.push(el);
            if (!m[5]) stack.push(el);
        } else if (m[6] !== undefined) top.text += unxml(m[6]);
    }
    return root;
}
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
function* elements(node) { for (const c of node.children) { yield c; yield* elements(c); } }

// ---------------------------------------------------------------- projects

const SKIP_DIRS = new Set(['node_modules', 'bin', 'out', 'build', 'gen', 'mir', 'external']);

// All Connect IQ projects (folders with a manifest.xml) at or below root, up to 3 levels deep
export function findProjects(root) {
    root = resolve(root);
    const out = [];
    const visit = (dir, depth) => {
        if (existsSync(join(dir, 'manifest.xml'))) { out.push(dir); return; }
        if (depth >= 3) return;
        let names;
        try { names = readdirSync(dir); } catch { return; }
        for (const n of names.sort()) {
            if (n.startsWith('.') || SKIP_DIRS.has(n)) continue;
            const p = join(dir, n);
            try { if (statSync(p).isDirectory()) visit(p, depth + 1); } catch { /* unreadable */ }
        }
    };
    visit(root, 0);
    return out;
}

// Setup files (*.mvlsim.json) at or below root, up to 3 levels deep
export const SETUP_EXT = '.mvlsim.json';
export function findSetups(root) {
    root = resolve(root);
    const out = [];
    const visit = (dir, depth) => {
        let names;
        try { names = readdirSync(dir); } catch { return; }
        for (const n of names.sort()) {
            const p = join(dir, n);
            if (n.toLowerCase().endsWith(SETUP_EXT)) { out.push(p); continue; }
            if (depth >= 3 || n.startsWith('.') || SKIP_DIRS.has(n)) continue;
            try { if (statSync(p).isDirectory()) visit(p, depth + 1); } catch { /* unreadable */ }
        }
    };
    visit(root, 0);
    return out;
}

export function describeProject(dir, root) {
    const jungles = readdirSync(dir).filter(f => f.endsWith('.jungle')).sort((a, b) => (b === 'monkey.jungle') - (a === 'monkey.jungle') || a.localeCompare(b));
    const m = readManifest(dir, 'manifest.xml');
    let name = relative(root, dir).split(sep).join('/') || basename(dir);
    return { id: dir, name, root, type: m.type, products: m.products, languages: m.languages, jungles, entry: m.entry, appName: m.name };
}

function readManifest(dir, file) {
    const p = join(dir, file);
    if (!existsSync(p)) throw new Error(`no manifest ${p}`);
    const x = parseXml(readFileSync(p, 'utf8'));
    let app = null;
    const products = [], languages = [], barrels = [];
    let minApi = null;
    for (const e of elements(x)) {
        if (e.tag === 'iq:application' || e.tag === 'iq:watchface' || e.tag === 'iq:widget') app = app || e;
        if (e.tag === 'iq:product' && e.attrs.id) products.push(e.attrs.id);
        if (e.tag === 'iq:language') languages.push(e.text.trim());
        if (e.tag === 'iq:depends' && e.attrs.name) barrels.push(e.attrs.name);
    }
    if (!app) throw new Error(`${p}: no <iq:application>`);
    minApi = app.attrs.minApiLevel || null;
    return { id: app.attrs.id, type: app.attrs.type, entry: app.attrs.entry, name: app.attrs.name, minApi, products, languages: languages.filter(Boolean), barrels };
}

// ---------------------------------------------------------------- bundle

/**
 * dir: project folder; device: product id; jungleFile: a .jungle in dir; lang: 3-letter code
 * ciq: Ciq instance (for default.jungle and device files)
 */
export function readBundle(dir, device, jungleFile, lang, ciq) {
    const warnings = [];
    jungleFile = jungleFile || 'monkey.jungle';
    if (!/^[\w.-]+\.jungle$/.test(jungleFile)) throw new Error('bad jungle name');
    const jpath = join(dir, jungleFile);
    if (!existsSync(jpath)) throw new Error(`no jungle ${jpath}`);

    const J = new Jungle();
    J.add('base.sourcePath = .\\**.mc\nbase.resourcePath = resources\n');
    J.add(ciq.defaultJungle());
    let family = null;
    try { family = ciq.deviceFiles(device).compiler.deviceFamily || null; } catch { /* reported by /api/device */ }
    ensureDeviceChain(J, device, family);
    J.add(readFileSync(jpath, 'utf8'));

    const manifestFile = J.get('project.manifest') || 'manifest.xml';
    const manifest = readManifest(dir, manifestFile.replace(/^"|"$/g, ''));
    if (manifest.barrels.length || J.list(`${device}.barrelPath`).length) {
        warnings.push(`Barrels (${manifest.barrels.join(', ') || 'barrelPath'}) are not supported: their code is not loaded.`);
    }
    lang = lang || manifest.languages[0] || 'eng';

    // Debug build, as in the simulator: (:release) and (:test) code is left out
    const exclude = [...new Set([...J.list(`${device}.excludeAnnotations`), 'release', 'test'])];
    const sourcePaths = J.list(`${device}.sourcePath`);
    const resourcePaths = J.list(`${device}.resourcePath`);
    const langPaths = J.list(`${device}.lang.${lang}`);

    const sources = [];
    const seen = new Set();
    for (const f of resolvePaths(dir, sourcePaths, '.mc')) {
        if (seen.has(f)) continue;
        seen.add(f);
        sources.push({ file: rel(dir, f), text: readFileSync(f, 'utf8') });
    }
    if (!sources.length) warnings.push(`No .mc sources found (sourcePath: ${sourcePaths.join(';') || '-'})`);

    const res = { fonts: new Map(), strings: {}, properties: new Map(), settings: [], bitmaps: new Map(), json: new Map(), layouts: new Map(), drawableLists: new Set() };
    const resDirs = [];
    for (const f of resolvePaths(dir, resourcePaths, '.xml')) readResourceXml(f, dir, res, warnings, resDirs);
    for (const f of resolvePaths(dir, langPaths, '.xml')) readResourceXml(f, dir, res, warnings, resDirs);

    return {
        project: dir, name: basename(dir), entry: manifest.entry, type: manifest.type, appName: manifest.name, minApi: manifest.minApi,
        products: manifest.products, languages: manifest.languages, lang, jungle: jungleFile, exclude,
        sourcePaths, resourcePaths: resourcePaths.concat(langPaths),
        sources, fonts: [...res.fonts.values()], strings: res.strings, properties: [...res.properties.values()],
        settings: res.settings, bitmaps: [...res.bitmaps.values()], json: Object.fromEntries(res.json),
        layouts: Object.fromEntries(res.layouts), drawableLists: [...res.drawableLists], warnings,
    };
}

const rel = (dir, f) => relative(dir, f).split(sep).join('/');
const fileUrl = (dir, f) => `/appres?project=${encodeURIComponent(dir)}&file=${encodeURIComponent(rel(dir, f))}`;

// Jungle path entries: folders (recursive), files, or globs with * and ** (e.g. .\**.mc)
function resolvePaths(dir, entries, ext) {
    const out = [];
    for (let e of entries) {
        e = e.replace(/\\/g, '/');
        if (e.includes('*')) {
            const parts = e.split('/');
            const i = parts.findIndex(p => p.includes('*'));
            const base = resolve(dir, parts.slice(0, i).join('/') || '.');
            const pat = parts.slice(i).join('/');
            const re = new RegExp('^' + pat.split('**').map(s => s.split('*').map(escapeRe).join('[^/]*')).join('.*') + '$');
            for (const f of walk(base)) if (re.test(rel(base, f)) && f.endsWith(ext)) out.push(f);
            continue;
        }
        const p = resolve(dir, e);
        if (!existsSync(p)) continue;
        if (statSync(p).isDirectory()) { for (const f of walk(p)) if (f.endsWith(ext)) out.push(f); }
        else if (p.endsWith(ext)) out.push(p);
    }
    return out;
}
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function walk(d) {
    if (!existsSync(d)) return [];
    const out = [];
    for (const n of readdirSync(d).sort()) {
        if (n.startsWith('.')) continue;
        const p = join(d, n);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) out.push(...walk(p)); else out.push(p);
    }
    return out;
}

function readResourceXml(f, dir, res, warnings, seenFiles) {
    if (seenFiles.includes(f)) return;
    seenFiles.push(f);
    let x;
    try { x = parseXml(readFileSync(f, 'utf8')); } catch (e) { warnings.push(`${rel(dir, f)}: ${e.message}`); return; }
    const here = dirname(f);
    for (const e of elements(x)) {
        const a = e.attrs;
        switch (e.tag) {
            case 'font': {
                if (!a.id || !a.filename) break;
                const fnt = resolve(here, a.filename);
                if (!existsSync(fnt)) { warnings.push(`Font ${a.id}: ${rel(dir, fnt)} not found`); break; }
                if (!/\.fnt$/i.test(fnt)) { warnings.push(`Font ${a.id}: only BMFont .fnt files are supported (${basename(fnt)})`); break; }
                const fntText = readFileSync(fnt, 'utf8');
                const page = /page id=0 file="([^"]+)"/.exec(fntText);
                const png = join(dirname(fnt), page ? page[1] : basename(fnt).replace(/\.fnt$/i, '.png'));
                res.fonts.set(a.id, { id: a.id, fnt: fntText, png: fileUrl(dir, png) });
                break;
            }
            case 'string': if (a.id) res.strings[a.id] = e.text.trim(); break;
            case 'property': if (a.id) res.properties.set(a.id, { id: a.id, type: a.type || 'string', value: e.text.trim() }); break;
            case 'setting': {
                const key = (a.propertyKey || '').replace(/^@Properties\./, '');
                const cfg = e.children.find(c => c.tag === 'settingConfig');
                const opts = cfg ? cfg.children.filter(c => c.tag === 'listEntry').map(c => ({ value: c.attrs.value, label: c.text.trim() })) : [];
                res.settings.push({ key, title: a.title || null, type: cfg ? cfg.attrs.type : null, min: cfg?.attrs.min ?? null, max: cfg?.attrs.max ?? null, options: opts });
                break;
            }
            case 'bitmap': {
                if (!a.id || !a.filename) break; // layout bitmaps have no id in some files; handled with the layout
                const p = resolve(here, a.filename);
                if (existsSync(p)) res.bitmaps.set(a.id, { id: a.id, url: fileUrl(dir, p), file: rel(dir, p) });
                else warnings.push(`Bitmap ${a.id}: ${rel(dir, p)} not found`);
                break;
            }
            case 'drawable-list': if (a.id) res.drawableLists.add(a.id); break;
            case 'jsonData': {
                if (!a.id) break;
                try {
                    const text = a.filename ? readFileSync(resolve(here, a.filename), 'utf8') : e.text;
                    res.json.set(a.id, JSON.parse(text));
                } catch (err) { warnings.push(`jsonData ${a.id}: ${err.message}`); }
                break;
            }
            case 'layout': if (a.id) res.layouts.set(a.id, layoutOf(e, here, dir)); break;
        }
    }
}

// Layout children in order: {tag, attrs, text}; bitmap filenames become URLs
function layoutOf(e, here, dir) {
    return e.children.filter(c => !c.tag.startsWith('#')).map(c => {
        const attrs = { ...c.attrs };
        if (c.tag === 'bitmap' && attrs.filename) attrs.url = fileUrl(dir, resolve(here, attrs.filename));
        return { tag: c.tag, attrs, text: c.text.trim() };
    });
}

// ---------------------------------------------------------------- device

const SHAPES = { round: 1, semiround: 2, rectangle: 3, 'semi-octagon': 4, semioctagon: 4 };
export const BUILTIN_FONTS = ['xtiny', 'tiny', 'small', 'medium', 'large', 'numberMild', 'numberMedium', 'numberHot', 'numberThaiHot'];

export function readDevice(id, ciq) {
    const { sim, compiler } = ciq.deviceFiles(id);
    const disp = sim.display.location;
    const set = sim.fonts.find(f => f.fontSet === 'ww') || sim.fonts[0];
    const warnings = [];
    const fonts = [], systemFonts = {};
    for (const f of set.fonts) {
        if (f.type === 'system_ttf') { if (ciq.fontFile(f.filename)) systemFonts[f.name] = f.filename; continue; }
        const isTtf = f.type === 'ttf';
        const available = isTtf && !!ciq.fontFile(f.filename);
        fonts.push({ name: f.name, filename: f.filename, size: f.size ?? null, scale: f.scale || null, type: f.type || 'cft', available });
    }
    const missing = fonts.filter(f => BUILTIN_FONTS.includes(f.name) && !f.available);
    if (missing.length) {
        const cft = missing.some(f => f.type !== 'ttf');
        warnings.push(cft
            ? `This device's built-in fonts are Garmin .cft files, which MVL Sim does not read: ${missing.map(f => f.name).join(', ')} are drawn with a stand-in TTF. Letter shapes will not match the device.`
            : `Built-in font files missing from ${ciq.fonts}: ${missing.map(f => f.filename).join(', ')} (fallback used). Install them with the SDK Manager.`);
    }

    const layouts = ((sim.layouts?.[0]?.datafields?.datafields) || []).map(l => ({
        name: l.name || `${l.fields.length} Fields`,
        fields: l.fields.map(f => ({
            x: f.location.x, y: f.location.y, w: f.location.width, h: f.location.height,
            obscurity: f.obscurity || [],
            // label/data positions in simulator.json are already relative to the field
            label: f.label ? { font: f.label.font, x: f.label.x, y: f.label.y } : null,
            data: f.data ? { font: f.data.font, x: f.data.x, y: f.data.y, width: f.data.width ?? null } : null,
            labelDisabled: !!f.labelDisabled,
        })),
    }));
    if (!layouts.length) {
        warnings.push('simulator.json has no data field layouts; using the whole screen as one field.');
        layouts.push({ name: '1 Field', fields: [{ x: 0, y: 0, w: disp.width, h: disp.height, obscurity: [], label: null, data: null }] });
    }
    const df = (compiler.appTypes || []).find(a => a.type === 'datafield');
    if (!df) warnings.push('This device does not list data fields among its app types.');
    const shapeName = String(sim.display.shape || compiler.deviceFamily?.split('-')[0] || 'rectangle').toLowerCase();
    return {
        id, name: compiler.displayName || id, family: compiler.deviceFamily || null,
        width: disp.width, height: disp.height, ppi: sim.ppi, shape: shapeName, screenShape: SHAPES[shapeName] ?? 3,
        isTouch: !!sim.display.isTouch, bitsPerPixel: compiler.bitsPerPixel ?? null,
        memoryLimit: df ? df.memoryLimit : null, partNumber: compiler.worldWidePartNumber || compiler.partNumbers?.[0]?.number || '',
        layouts, fonts, systemFonts, warnings,
    };
}
