// Fonts: the app's own bitmap fonts (.fnt + .png, BMFont text format) and the device's built-in
// TTF fonts (from the user's Connect IQ Fonts folder, sizes from the device's simulator.json).
// Garmin .cft fonts (most older devices) are not rendered: those get a fallback TTF with an
// estimated size, and the page shows a warning.

export class BitmapFont {
    // fnt: text of the .fnt file; img: loaded HTMLImageElement / ImageBitmap of the page
    constructor(id, fnt, img) {
        this.id = id;
        this.img = img;
        this.chars = new Map();
        this.tinted = new Map();
        for (const line of fnt.split(/\r?\n/)) {
            const kv = {};
            for (const m of line.matchAll(/(\w+)=("[^"]*"|\S+)/g)) kv[m[1]] = m[2].replace(/"/g, '');
            if (line.startsWith('common ')) { this.lineHeight = +kv.lineHeight; this.base = +kv.base; }
            if (line.startsWith('char ')) {
                this.chars.set(+kv.id, { x: +kv.x, y: +kv.y, w: +kv.width, h: +kv.height, xo: +kv.xoffset, yo: +kv.yoffset, adv: +kv.xadvance });
            }
        }
        this.height = this.lineHeight;
        this.ascent = this.base;
    }
    // A character the font lacks still takes half the line height (measured in Garmin's simulator)
    width(text) {
        let w = 0;
        for (const ch of text) { const c = this.chars.get(ch.codePointAt(0)); w += c ? c.adv : Math.round(this.lineHeight / 2); }
        return w;
    }
    atlas(color) {
        let a = this.tinted.get(color);
        if (!a) {
            a = document.createElement('canvas');
            a.width = this.img.width; a.height = this.img.height;
            const c = a.getContext('2d');
            c.drawImage(this.img, 0, 0);
            c.globalCompositeOperation = 'source-in';
            c.fillStyle = color;
            c.fillRect(0, 0, a.width, a.height);
            this.tinted.set(color, a);
        }
        return a;
    }
    draw(ctx, x, y, text, color) {
        const a = this.atlas(color);
        let pen = x;
        for (const ch of text) {
            const c = this.chars.get(ch.codePointAt(0));
            if (!c) { pen += Math.round(this.lineHeight / 2); continue; }
            if (c.w > 0 && c.h > 0) ctx.drawImage(a, c.x, c.y, c.w, c.h, pen + c.xo, y + c.yo, c.w, c.h);
            pen += c.adv;
        }
    }
}

// Built-in fonts. Calibrated against Garmin's simulator (SDK 9.3.0, edge1050 and edgemtb):
// font size in px = size (pt) * ppi / 72; text widths then match within 1-2 px;
// "narrow" fonts are squeezed to 87.5 % width; getFontHeight() = floor(px * k + 0.4) with k per face.
const HEIGHT_K = { DejaVuSans_Cd_SemiBold_WGL4: 1.055, Garmin_Roboto_Bold: 1.173 };

export class TtfFont {
    // fit (stand-in for a .cft font): { height, sx, sy } measured in Garmin's simulator
    constructor(family, filename, px, narrow, fallback = false, fit = null) {
        this.family = family;
        this.filename = filename;
        this.px = px;
        this.sx = fit ? fit.sx : narrow ? 0.875 : 1;
        this.sy = fit?.sy ?? 1; // glyphs scaled up from the baseline
        this.fallback = fallback;
        this.css = cssFont(px, family);
        const c = document.createElement('canvas').getContext('2d');
        c.font = this.css;
        const m = c.measureText('0Ay');
        const box = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
        this.height = fit ? fit.height : Math.floor(px * (HEIGHT_K[filename] ?? box / px) + 0.4);
        // Baseline placed so the font's box is centred in that height
        this.ascent = fit?.base ?? m.fontBoundingBoxAscent - (box - this.height) / 2;
        this.measure = c;
    }
    width(text) { return Math.round(this.measure.measureText(text).width * this.sx); }
    draw(ctx, x, y, text, color) {
        ctx.save();
        ctx.font = this.css;
        ctx.fillStyle = color;
        ctx.textBaseline = 'alphabetic';
        ctx.translate(x, y + this.ascent);
        ctx.scale(this.sx, this.sy);
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }
}

// Graphics.FONT_* index -> simulator.json font name (FONT_SYSTEM_* 9..17 map onto the same faces)
const BUILTIN_NAMES = ['xtiny', 'tiny', 'small', 'medium', 'large', 'numberMild', 'numberMedium', 'numberHot', 'numberThaiHot'];
const EXTRA_NAMES = { 18: 'glanceFont', 19: 'glanceNumberFont', 20: 'auxiliaryFont1', 21: 'auxiliaryFont2' };
// Fallback size of a built-in font as a fraction of the shorter screen side
// (median over the installed devices that have TTF fonts, SDK 9.3.0 device files)
const FALLBACK_RATIO = { xtiny: 0.0684, tiny: 0.0874, small: 0.0995, medium: 0.1152, large: 0.1327,
    numberMild: 0.1735, numberMedium: 0.2322, numberHot: 0.2904, numberThaiHot: 0.3534,
    glanceFont: 0.0874, glanceNumberFont: 0.0995, auxiliaryFont1: 0.0874, auxiliaryFont2: 0.0684 };

// Garmin .cft fonts of the Edge models, measured in Garmin's simulator (SDK 9.3.0, edge830, edge1030,
// edge_520, edge820, edge130): [getFontHeight, width of "0123456789", width of "current pos.: [0/0]"].
// MVL Sim does not read .cft files; it draws these with a stand-in TTF scaled to the measured height
// and text width, so line heights and text widths match (within a few px), glyph shapes do not.
const CFT_MEASURED = {
    FNT_ROBOTO_CONDENSED_13: [13, 60, 76], FNT_ROBOTO_CONDENSED_16: [16, 70, 95],
    FNT_ROBOTO_CONDENSED_20: [20, 90, 118], FNT_ROBOTO_CONDENSED_22: [22, 90, 128],
    FNT_ROBOTO_CONDENSED_26: [26, 110, 154], FNT_ROBOTO_CONDENSED_29: [29, 120, 169],
    FNT_ROBOTO_CONDENSED_41: [41, 180, 242], FNT_ROBOTO_CONDENSED_48: [48, 210, 283],
    FNT_DEJAVU_SANS_9: [12, 50, 73], FNT_DEJAVU_SANS_12: [17, 70, 106], FNT_DEJAVU_SANS_14: [19, 80, 115],
    FNT_DEJAVU_SANS_16: [22, 90, 134], FNT_DEJAVU_SANS_26: [36, 150, 221],
    FNT_DEJAVU_FITNESS_24: [34, 170], FNT_DEJAVU_FITNESS_26: [36, 180], FNT_DEJAVU_FITNESS_28: [39, 190],
    FNT_DEJAVU_FITNESS_30: [42, 210], FNT_DEJAVU_FITNESS_35: [49, 240], FNT_DEJAVU_FITNESS_36: [50, 250],
    FNT_DEJAVU_FITNESS_40: [56, 280], FNT_DEJAVU_FITNESS_47: [66, 330], FNT_DEJAVU_FITNESS_50: [70, 350],
    FNT_DEJAVU_FITNESS_58: [81, 400],
    FNT_EDGE130_ROBOTO_CONDENSED_17: [27, 110, 159], FNT_EDGE130_ROBOTO_CONDENSED_BOLD_17: [27, 110, 160],
    FNT_EDGE130_ROBOTO_CONDENSED_18: [30, 120, 177], FNT_EDGE130_ROBOTO_CONDENSED_BOLD_18: [30, 130, 180],
    FNT_EDGE130_ROBOTO_CONDENSED_BOLD_21: [35, 150, 212],
    FNT_EDGE130_BEBAS_NEUE_BOLD_32: [52, 170], FNT_EDGE130_BEBAS_NEUE_BOLD_35: [58, 190],
    FNT_EDGE130_BEBAS_NEUE_BOLD_51: [84, 280], FNT_EDGE130_BEBAS_NEUE_BOLD_64: [106, 350],
};
const cftStandIn = filename => /DEJAVU/.test(filename) ? 'DejaVuSans_Cd_SemiBold_WGL4'
    : /BOLD/.test(filename) ? 'RobotoCondensed-Bold' : 'RobotoCondensed-Regular';
const cssFont = (px, family) => `${px}px ${family.includes(' ') || family.startsWith('dev_') ? `"${family}"` : family}`;

// A stand-in TtfFont for a measured .cft font: px so the face's box is the measured height,
// horizontal scale so the reference text has the measured width
function measuredFont(family, filename, [height, wDigits, wText]) {
    const c = document.createElement('canvas').getContext('2d');
    c.font = cssFont(100, family);
    const m = c.measureText('0Ay');
    const px = Math.round(height * 100 / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) * 10) / 10;
    c.font = cssFont(px, family);
    const [ref, w] = wText ? ['current pos.: [0/0]', wText] : ['0123456789', wDigits];
    // DEJAVU_FITNESS_<n>: digits n px tall with their baseline about 1.09 n below the top
    // (measured on edge830 and edge1030, all four number fonts: within 1 px)
    const n = /DEJAVU_FITNESS_(\d+)$/.exec(filename);
    const sy = n ? +n[1] / c.measureText('0').actualBoundingBoxAscent : 1;
    const base = n ? Math.round(+n[1] * 1.09) : undefined;
    return new TtfFont(family, filename, px, false, true, { height, sx: w / c.measureText(ref).width, sy, base });
}

const loaded = new Map(); // filename -> Promise<family | null>
function loadFace(filename) {
    if (!loaded.has(filename)) {
        const family = 'dev_' + filename;
        loaded.set(filename, new FontFace(family, `url(/sdkfonts/${encodeURIComponent(filename)}.ttf)`).load()
            .then(face => { document.fonts.add(face); return family; })
            .catch(() => null));
    }
    return loaded.get(filename);
}

// device: from /api/device. Returns { fonts: Map name -> TtfFont, warnings: [] }
export async function loadDeviceFonts(device) {
    const byName = new Map();
    const warnings = [];
    const side = Math.min(device.width, device.height);
    // Fallback faces: the installed Roboto if there is one, else the browser's sans-serif
    const textFallback = (await loadFace('Roboto-Regular')) || 'sans-serif';
    const numFallback = (await loadFace('RobotoCondensed-Bold')) || textFallback;
    const fellBack = [], measured = [];
    for (const f of device.fonts) {
        let family = null;
        if (f.available) family = await loadFace(f.filename);
        if (family && f.size != null) {
            byName.set(f.name, new TtfFont(family, f.filename, f.size * device.ppi / 72, f.scale === 'narrow'));
            continue;
        }
        const cft = !f.available && CFT_MEASURED[f.filename];
        if (cft) {
            const fam = (await loadFace(cftStandIn(f.filename))) || textFallback;
            byName.set(f.name, measuredFont(fam, f.filename, cft));
            if (BUILTIN_NAMES.includes(f.name)) measured.push(f.name);
            continue;
        }
        const ratio = FALLBACK_RATIO[f.name] ?? (/[Nn]umber/.test(f.name) ? 0.2322 : 0.0995);
        const fam = /[Nn]umber/.test(f.name) ? numFallback : textFallback;
        byName.set(f.name, new TtfFont(fam, null, Math.round(ratio * side), false, true));
        if (BUILTIN_NAMES.includes(f.name)) fellBack.push(f.name);
    }
    for (const n of BUILTIN_NAMES) {
        if (byName.has(n)) continue;
        byName.set(n, new TtfFont(/^number/.test(n) ? numFallback : textFallback, null, Math.round(FALLBACK_RATIO[n] * side), false, true));
        fellBack.push(n);
    }
    if (measured.length) warnings.push(`Font heights and text widths measured in Garmin's simulator for: ${measured.join(', ')}.`);
    if (fellBack.length) warnings.push(`Fallback font (estimated size) for: ${fellBack.join(', ')}.`);
    const vector = new Map(); // simulator.json system_ttf name -> filename (Graphics.getVectorFont)
    for (const [name, filename] of Object.entries(device.systemFonts || {})) vector.set(name, filename);
    return { fonts: byName, warnings, vector };
}

export class FontSet {
    // device: { fonts, vector } from loadDeviceFonts; bitmaps: Map id -> BitmapFont
    constructor(device, bitmaps) {
        this.builtins = device.fonts ?? device; // Map name -> TtfFont
        this.vectorFaces = device.vector ?? new Map();
        this.vectorCache = new Map();
        this.bitmaps = bitmaps;
    }
    get(font) {
        if (font instanceof BitmapFont || font instanceof TtfFont) return font;
        if (typeof font === 'number') {
            const name = font < 18 ? BUILTIN_NAMES[font % 9] : EXTRA_NAMES[font];
            const f = this.builtins.get(name) || (font >= 18 ? this.builtins.get('small') : null);
            if (f) return f;
        }
        if (font && font.v !== undefined) return this.get(Math.trunc(font.v));
        throw new Error('unknown font ' + font);
    }
    bitmap(id) {
        const f = this.bitmaps.get(id);
        if (!f) throw new Error('font resource not loaded: ' + id);
        return f;
    }
    // Graphics.getVectorFont: face names from simulator.json (system_ttf), loaded on first use.
    // Fonts load asynchronously, so the very first frame may use the browser's fallback face.
    vector(face, size) {
        const file = this.vectorFaces.get(face);
        if (!file) return null;
        const key = file + '@' + size;
        if (!this.vectorCache.has(key)) {
            loadFace(file);
            this.vectorCache.set(key, new TtfFont('dev_' + file, file, size, false));
        }
        return this.vectorCache.get(key);
    }
}
