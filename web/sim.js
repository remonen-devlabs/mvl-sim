// The engine: runs a translated data field against a ride, one compute() per second,
// and seeks by replaying from the start (so the app's own running state is exact at any point).

import { translate } from './monkeyc.js';
import { createRuntime, MonkeyError, fromJson } from './runtime.js';
import { metricsFor, drawMetricField, drawSeparators, top } from './builtin.js';

const OBSCURE = { left: 1, top: 2, right: 4, bottom: 8 };

export class Sim {
    // bundle: from /api/app; device: from /api/device; fonts: FontSet; ride: from buildRide();
    // ctx: 2d context of the screen canvas; images: Map url -> loaded Image (bitmap resources)
    constructor({ bundle, device, fonts, ride, ctx, settings, images }) {
        this.bundle = bundle;
        this.device = device;
        this.fonts = fonts;
        this.ride = ride;
        this.ctx = ctx;
        this.images = images || new Map();
        this.settings = settings; // { props, night, weatherMode, wind, userFtp, layout, field, others }
        this.pickField();

        // Translate once; a factory gives fresh classes for every reset
        const probe = createRuntime(this.makeEnv());
        const { code, classes } = translate(bundle.sources, { exclude: bundle.exclude, toybox: probe.T });
        this.code = code;
        this.classes = classes;
        this.factory = new Function('T', 'G', '$', code);
        this.reset();
    }

    // The field the app runs in: one field of one of the device's data screen layouts
    pickField() {
        const layouts = this.device.layouts;
        const li = Math.min(Math.max(0, this.settings.layout | 0), layouts.length - 1);
        const layout = layouts[li];
        const fi = Math.min(Math.max(0, this.settings.field | 0), layout.fields.length - 1);
        this.layout = layout;
        this.fieldIndex = fi;
        this.loc = layout.fields[fi];
        this.obscurity = this.loc.obscurity.reduce((m, s) => m | (OBSCURE[s] || 0), 0);
    }

    makeEnv() {
        const sim = this;
        return {
            device: this.device,
            get fonts() { return sim.fonts; },
            images: this.images,
            storage: new Map(),
            properties: new Map(),
            timers: new Set(),
            listeners: { sensor: null, position: null },
            log: (s) => sim.onLog(s),
            fitWrite: (meta, v) => sim.onFitWrite(meta, v),
            now: () => sim.sec ? sim.sec.t + sim.ride.epoch : sim.ride.tStart + sim.ride.epoch,
            clockOffset: () => sim.ride.localOffset,
            info: () => sim.info,
            sensor: () => sim.sensorInfo(),
            position: () => sim.positionInfo(),
            field: () => ({ obscurity: sim.obscurity }),
            night: () => !!sim.settings.night,
            userFtp: () => sim.settings.userFtp != null ? sim.settings.userFtp : sim.ride.ftp,
            profile: () => sim.profile(),
            sport: () => ({ sport: sim.ride.sport ?? 2, subSport: sim.ride.subSport ?? 0 }),
            radar: () => sim.sec ? sim.sec.radar : null,
            battery: () => sim.sec?.battery ?? 80,
            weather: () => {
                const m = sim.settings.weatherMode;
                if (m === 'none') return null;
                if (m === 'fit') return sim.sec ? sim.sec.weather : null;
                return sim.settings.wind;
            },
        };
    }

    // UserProfile values: the FIT file's user_profile / zones_target, else plain defaults
    profile() {
        const p = this.ride.profile || {};
        const year = new Date((this.ride.tStart + this.ride.epoch) * 1000).getUTCFullYear();
        const maxHr = this.ride.maxHr ?? (p.age ? 220 - p.age : 185);
        const rest = p.restingHr ?? 50;
        return {
            weight: p.weight != null ? Math.round(p.weight * 1000) : 75000,
            height: p.height ?? 180,
            gender: p.gender ?? 1,
            birthYear: p.age ? year - p.age : 1980,
            restingHeartRate: rest,
            // Garmin's default %-of-max zones: [z1 low, z1 high, z2 high, z3 high, z4 high, z5 high]
            hrZones: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map(f => Math.round(maxHr * f)),
        };
    }

    reset() {
        this.env = this.makeEnv();
        this.rt = createRuntime(this.env);
        this.G = {};
        this.error = null;
        this.logLines = [];
        this.fitFields = new Map();
        this.k = -1;
        this.sec = null;
        this.info = null;
        this.simpleValue = null;
        for (const p of this.bundle.properties) {
            const v = p.id in this.settings.props ? this.settings.props[p.id] : p.value;
            this.env.properties.set(p.id, this.propValue(p.type, v));
        }
        this.G.Rez = this.makeRez();
        const { T, $ } = this.rt;
        this.guard(() => {
            this.factory(T, this.G, $);
            const App = this.classByName(this.bundle.entry);
            if (!App) throw new Error(`entry class ${this.bundle.entry} not found`);
            this.app = $.new_(App, []);
            this.app.onStart(null);
            const views = this.app.getInitialView();
            this.view = views[0];
            if (!(this.view instanceof T.WatchUi.DataField)) {
                throw new MonkeyError('Unsupported', `getInitialView() returned ${this.view?.$className || typeof this.view}; MVL Sim runs data fields only`);
            }
            this.dc = this.rt.newDc(this.ctx, this.loc.x, this.loc.y, this.loc.w, this.loc.h);
            this.view.onLayout(this.dc);
            this.view.onShow();
        });
    }

    classByName(name) {
        const js = this.classes[name];
        if (!js) return null;
        let o = { G: this.G };
        for (const p of js.split('.')) o = o?.[p];
        return o || null;
    }

    propValue(type, v) {
        const { F } = this.rt;
        if (type === 'number') return Math.trunc(+v) | 0;
        if (type === 'float') return new F(+v);
        if (type === 'boolean') return v === true || v === 'true';
        return String(v);
    }

    makeRez() {
        const Fonts = {}, Strings = {}, Drawables = {}, JsonData = {}, Layouts = {};
        for (const f of this.bundle.fonts) Fonts[f.id] = { kind: 'font', id: f.id };
        for (const [id, value] of Object.entries(this.bundle.strings)) Strings[id] = { kind: 'string', id, value };
        for (const b of this.bundle.bitmaps) Drawables[b.id] = { kind: 'bitmap', id: b.id, url: b.url };
        for (const id of this.bundle.drawableLists) Drawables[id] = { kind: 'drawable-list', id };
        for (const [id, value] of Object.entries(this.bundle.json)) JsonData[id] = { kind: 'json', id, value };
        for (const [id, items] of Object.entries(this.bundle.layouts)) Layouts[id] = (dc) => this.buildLayout(id, items, dc);
        return { Fonts, Strings, Drawables, JsonData, Layouts, Styles: {}, Menus: {} };
    }

    // Rez.Layouts.X(dc): the layout's drawables, built the way the resource compiler would
    buildLayout(id, items, dc) {
        const { T, $ } = this.rt;
        const W = T.WatchUi, Gr = T.Graphics;
        const w = dc ? dc.getWidth() : this.loc.w, h = dc ? dc.getHeight() : this.loc.h;
        const val = (s, what) => {
            if (s == null) return null;
            s = String(s).trim();
            let m;
            if ((m = /^@Strings\.(\w+)$/.exec(s))) return this.bundle.strings[m[1]] ?? null;
            if ((m = /^@Fonts\.(\w+)$/.exec(s))) return this.fonts.bitmap(m[1]);
            if (/^(Graphics\.|Toybox\.Graphics\.)?\w+(\s*\|\s*(Graphics\.|Toybox\.Graphics\.)?\w+)*$/.test(s) && /[A-Z_]{3,}/.test(s)) {
                return s.split('|').reduce((acc, part) => {
                    const name = part.trim().replace(/^(Toybox\.)?Graphics\./, '');
                    if (!(name in Gr)) throw new MonkeyError('Layout', `${id}: unknown ${what} ${part.trim()}`);
                    return acc | Gr[name];
                }, 0);
            }
            if (/^-?(0x[0-9a-f]+|\d+)$/i.test(s)) return Number(s) | 0;
            if (/^#[0-9a-f]{6}$/i.test(s)) return parseInt(s.slice(1), 16);
            return s;
        };
        const pos = (s, total, horizontal) => {
            if (s == null) return { v: 0 };
            s = String(s).trim();
            if (s === 'center') return { v: Math.trunc(total / 2), center: true };
            if (s === (horizontal ? 'left' : 'top') || s === 'start') return { v: 0 };
            if (s === (horizontal ? 'right' : 'bottom') || s === 'end') return { v: total, end: true };
            if (/%$/.test(s)) return { v: Math.trunc(total * parseFloat(s) / 100) };
            return { v: parseInt(s, 10) | 0 };
        };
        const opts = (o) => $.dict(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [$.sym(k), v]));
        const out = [];
        for (const it of items) {
            const a = it.attrs;
            if (it.tag === 'label') {
                const x = pos(a.x, w, true), y = pos(a.y, h, false);
                let just = a.justification != null ? val(a.justification, 'justification') : Gr.TEXT_JUSTIFY_LEFT;
                if (y.center) just |= Gr.TEXT_JUSTIFY_VCENTER;
                const font = a.font != null ? val(a.font, 'font') : Gr.FONT_MEDIUM;
                const text = a.text != null ? val(a.text) : it.text ? val(it.text) : '';
                out.push($.new_(W.Text, [opts({ identifier: a.id, locX: x.v, locY: y.v, color: a.color != null ? val(a.color, 'color') : Gr.COLOR_WHITE,
                    backgroundColor: a.background != null ? val(a.background, 'color') : undefined, font, justification: just, text })]));
            } else if (it.tag === 'drawable' && a.class) {
                const cls = this.classByName(a.class) || (W[a.class] ?? null);
                if (!cls) throw new MonkeyError('Layout', `${id}: drawable class ${a.class} not found`);
                const params = {};
                if (a.id) params.identifier = a.id;
                out.push($.new_(cls, [opts(params)]));
            } else if (it.tag === 'drawable' && a.id) {
                const r = this.G.Rez.Drawables[a.id];
                if (!r) throw new MonkeyError('Layout', `${id}: drawable ${a.id} not found`);
                out.push($.new_(W.Bitmap, [opts({ identifier: a.id, rezId: r, locX: pos(a.x, w, true).v, locY: pos(a.y, h, false).v })]));
            } else if (it.tag === 'bitmap') {
                const img = this.images.get(a.url);
                if (!img) throw new MonkeyError('Layout', `${id}: bitmap ${a.filename} not loaded`);
                const b = $.new_(W.Bitmap, [opts({ identifier: a.id })]);
                b.$bitmap = W.loadResource({ kind: 'bitmap', id: a.id, url: a.url });
                b.width = img.width; b.height = img.height;
                const x = pos(a.x, w, true), y = pos(a.y, h, false);
                b.locX = x.center ? Math.trunc((w - img.width) / 2) : x.end ? w - img.width : x.v;
                b.locY = y.center ? Math.trunc((h - img.height) / 2) : y.end ? h - img.height : y.v;
                out.push(b);
            } else {
                throw new MonkeyError('Layout', `${id}: <${it.tag}> in layouts is not supported by MVL Sim yet`);
            }
        }
        return out;
    }

    onLog(s) {
        this.logLines.push(`${this.timeLabel()} ${s}`);
        if (this.logLines.length > 500) this.logLines.splice(0, this.logLines.length - 500);
    }
    onFitWrite(meta, v) {
        this.fitFields.set(meta.name, { meta, v, k: this.k });
    }
    timeLabel() {
        if (!this.sec) return '--:--:--';
        return hms(this.sec.t - this.ride.tStart);
    }

    // Runs f; Monkey C errors stop the field like an "IQ!" crash on the device
    guard(f) {
        if (this.error) return false;
        try { f(); return true; }
        catch (e) {
            const where = this.rt.$.L || '?';
            const mc = e instanceof MonkeyError;
            const exc = !mc && e instanceof this.rt.$.Exception;
            const message = mc ? e.message : exc ? `Unhandled Exception: ${e.$className || 'Exception'}${e.mMessage ? ': ' + e.mMessage : ''}` : `${e.name}: ${e.message}`;
            this.error = { message, where, k: this.k, js: !mc && !exc };
            if (!mc && !exc) console.error(e);
            return false;
        }
    }

    location(lat, lon) { return lat == null ? null : this.rt.T.Position.newLocation(lat, lon); }

    makeInfo(s) {
        const { F } = this.rt;
        const f = (v) => v == null ? null : new F(v);
        const r = this.ride;
        const g = s.gear;
        const started = s.timer !== 0;
        const st = s.stats;
        const T = this.rt.T;
        return this.rt.newInfo({
            currentPower: s.power, currentHeartRate: s.hr, currentCadence: s.cadence,
            currentSpeed: f(s.speed), altitude: f(s.altitude),
            totalAscent: started ? s.totalAscent : null, totalDescent: started ? s.totalDescent : null,
            timerState: s.timer, timerTime: s.timerMs, elapsedTime: started ? (s.t - r.tStart) * 1000 : 0,
            elapsedDistance: started ? f(s.distance) : null,
            currentHeading: f(s.heading), track: f(s.heading), currentLocation: this.location(s.lat, s.lon),
            currentLocationAccuracy: s.lat == null ? T.Position.QUALITY_NOT_AVAILABLE : T.Position.QUALITY_GOOD,
            startLocation: this.location(s.startLat, s.startLon),
            startTime: s.startT == null ? null : this.rt.$.new_(T.Time.Moment, [s.startT + r.epoch]),
            averagePower: st.avgPower == null ? null : Math.round(st.avgPower), maxPower: st.maxPower,
            averageHeartRate: st.avgHr == null ? null : Math.round(st.avgHr), maxHeartRate: st.maxHr,
            averageCadence: st.avgCadence == null ? null : Math.round(st.avgCadence), maxCadence: st.maxCadence,
            averageSpeed: f(st.avgSpeed), maxSpeed: f(st.maxSpeed),
            calories: started ? s.calories : null,
            ambientPressure: f(s.pressure), rawAmbientPressure: f(s.pressure),
            frontDerailleurIndex: g.fIdx, frontDerailleurSize: g.fSize, frontDerailleurMax: s.frontMax,
            rearDerailleurIndex: g.rIdx, rearDerailleurSize: g.rSize, rearDerailleurMax: s.rearMax,
        });
    }

    sensorInfo() {
        const s = this.sec;
        if (!s) return this.rt.T.Sensor.newInfo({});
        const f = (v) => v == null ? null : new this.rt.F(v);
        return this.rt.T.Sensor.newInfo({ heartRate: s.hr, cadence: s.cadence, power: s.power, speed: f(s.speed), altitude: f(s.altitude),
            temperature: f(s.temp), heading: f(s.heading), pressure: f(s.pressure) });
    }

    positionInfo() {
        const s = this.sec, T = this.rt.T;
        if (!s || s.lat == null) return T.Position.newInfo({ accuracy: T.Position.QUALITY_NOT_AVAILABLE });
        const f = (v) => v == null ? null : new this.rt.F(v);
        return T.Position.newInfo({ accuracy: T.Position.QUALITY_GOOD, altitude: f(s.altitude), heading: f(s.heading),
            position: this.location(s.lat, s.lon), speed: f(s.speed), when: this.rt.$.new_(T.Time.Moment, [s.t + this.ride.epoch]) });
    }

    computeSecond(k) {
        this.k = k;
        const s = this.ride.secs[k];
        this.sec = s;
        this.info = this.makeInfo(s);
        return this.guard(() => {
            for (const ev of s.events) {
                if (ev === 'start') this.view.onTimerStart();
                else if (ev === 'pause') this.view.onTimerPause();
                else if (ev === 'resume') this.view.onTimerResume();
                else if (ev === 'lap') this.view.onTimerLap();
            }
            const nowMs = (s.t + this.ride.epoch) * 1000;
            for (const t of [...this.env.timers]) {
                while (this.env.timers.has(t) && t.due <= nowMs) {
                    if (t.repeat) t.due += Math.max(t.ms, 50); else this.env.timers.delete(t);
                    this.rt.$.callv(t.cb, []);
                }
            }
            const L = this.env.listeners;
            if (L.sensor) this.rt.$.callv(L.sensor, [this.sensorInfo()]);
            if (L.position && s.lat != null) {
                const p = L.position;
                if (p.once) L.position = null;
                this.rt.$.callv(p.cb, [this.positionInfo()]);
            }
            const v = this.view.compute(this.info);
            if (this.view instanceof this.rt.T.WatchUi.SimpleDataField) this.simpleValue = v;
        });
    }

    // Move to second k (replaying from the start when going back). Returns ms taken.
    seek(k) {
        const t0 = performance.now();
        k = Math.max(0, Math.min(this.ride.secs.length - 1, k));
        if (k < this.k) this.reset();
        while (this.k < k && !this.error) this.computeSecond(this.k + 1);
        return performance.now() - t0;
    }

    render() {
        this.renderOtherFields();
        this.renderApp();
        this.renderSeparators();
    }
    renderApp() {
        if (this.error) return this.renderCrash();
        const ok = this.guard(() => {
            const c = this.ctx;
            c.save();
            c.beginPath(); c.rect(this.loc.x, this.loc.y, this.loc.w, this.loc.h); c.clip();
            try {
                if (this.view instanceof this.rt.T.WatchUi.SimpleDataField) this.renderSimple();
                else this.view.onUpdate(this.dc);
            } finally {
                this.dc.clearClip();
                c.restore();
            }
        });
        if (!ok) this.renderCrash();
    }

    // In a multi-field layout, the other fields show the device's own data (settings.others: metric id per field)
    renderOtherFields() {
        const c = this.ctx;
        if (!c || this.layout.fields.length < 2) return;
        const night = !!this.settings.night;
        c.fillStyle = night ? '#000' : '#fff';
        c.fillRect(0, 0, this.device.width, this.device.height);
        const ids = metricsFor(this.layout, this.fieldIndex, this.settings.others);
        const opts = { sec: this.sec, k: this.k, ride: this.ride, fonts: this.fonts.builtins, night };
        this.layout.fields.forEach((f, i) => { if (i !== this.fieldIndex) drawMetricField(c, f, ids[i], opts); });
    }
    renderSeparators() {
        if (this.ctx && this.layout.fields.length > 1) drawSeparators(this.ctx, this.layout, this.device.width, this.device.height, !!this.settings.night);
    }

    renderSimple() {
        const dc = this.dc, G = this.rt.T.Graphics, f = this.loc;
        const bg = this.view.getBackgroundColor();
        const fg = bg === G.COLOR_BLACK ? G.COLOR_WHITE : G.COLOR_BLACK;
        dc.setColor(fg, bg);
        dc.clear();
        dc.setColor(fg, G.COLOR_TRANSPARENT);
        const fonts = this.fonts.builtins;
        const lf = (f.label && fonts.get(f.label.font)) || fonts.get('small');
        const df = (f.data && fonts.get(f.data.font)) || fonts.get('numberHot');
        const lx = f.label ? f.label.x : f.w / 2, ly = f.label ? f.label.y : f.h * 0.25;
        const dx = f.data ? f.data.x : f.w / 2, dy = f.data ? f.data.y : f.h * 0.6;
        const label = this.view.label;
        if (label != null && !f.labelDisabled) {
            const text = this.rt.$.str(label);
            const tw = lf.width(text);
            lf.draw(this.ctx, f.x + lx - tw / 2, f.y + (f.label ? ly - top(lf) : ly - lf.height / 2), text, dc.css(fg));
        }
        const v = this.simpleText(this.simpleValue);
        const vw = df.width(v);
        df.draw(this.ctx, f.x + dx - vw / 2, f.y + (f.data ? dy - top(df) : dy - df.height / 2), v, dc.css(fg));
    }

    // How a SimpleDataField's compute() result is shown
    simpleText(v) {
        const T = this.rt.T;
        if (v == null) return '--';
        if (v instanceof T.Time.Duration) {
            const s = Math.abs(v.value()), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
            return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`;
        }
        return this.rt.$.str(v);
    }

    renderCrash() {
        const c = this.ctx, { x, y, w, h } = this.loc;
        if (!c) return;
        c.fillStyle = '#000'; c.fillRect(x, y, w, h);
        c.fillStyle = '#ff3030'; c.textAlign = 'center';
        c.font = `bold ${Math.round(Math.min(w, h * 1.5) / 6)}px sans-serif`;
        c.fillText('IQ!', x + w / 2, y + h / 2);
        c.textAlign = 'left';
    }
}

export function hms(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export { fromJson };
