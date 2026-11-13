// One data screen: a device layout whose fields each show either the device's own data (a metric)
// or a Connect IQ data field. Every app runs in its own Sim (own classes, storage, properties), so
// a crash in one field does not touch the others, as on the device.

import { Sim } from './sim.js';
import { TranslateError } from './monkeyc.js';
import { drawMetricField, drawSeparators, drawRadarBar } from './builtin.js';

export class Screen {
    // fields: per layout field, { metric: id } or { app: { name, bundle, fonts, images, props } }
    // common: { night, weatherMode ('fit'|'manual'|'none'), wind, userFtp, radarBar, units ('metric'|'statute'), clock12 }
    constructor({ device, layoutIndex, fields, ride, ctx, common, deviceFonts }) {
        this.device = device;
        this.layoutIndex = layoutIndex;
        this.layout = device.layouts[layoutIndex];
        this.ride = ride;
        this.ctx = ctx;
        this.common = common;
        this.deviceFonts = deviceFonts; // Map name -> font (built-in fonts)
        this.k = -1;
        this.fields = this.layout.fields.map((loc, i) => {
            const f = fields[i] || { metric: 'none' };
            if (!f.app) return { loc, metric: f.metric || 'none' };
            const a = f.app;
            if (a.loadError) return { loc, app: a, translateError: a.loadError };
            try {
                const sim = new Sim({ bundle: a.bundle, device, fonts: a.fonts, ride, ctx, images: a.images,
                    settings: { ...common, props: a.props || {}, layout: layoutIndex, field: i, others: [] } });
                return { loc, app: a, sim };
            } catch (e) {
                if (!(e instanceof TranslateError)) console.error(e);
                return { loc, app: a, translateError: e instanceof TranslateError ? e.message : `${e.name}: ${e.message}` };
            }
        });
    }

    get sims() { return this.fields.filter(f => f.sim).map(f => f.sim); }

    // Change shared display settings (night) without replaying
    setCommon(common) {
        this.common = common;
        for (const f of this.fields) if (f.sim) f.sim.settings = { ...f.sim.settings, ...common };
    }

    // Replay every app from the start (after a setting change)
    reset() {
        for (const s of this.sims) s.reset();
        this.k = -1;
    }

    // Move every app to second k. Returns ms taken.
    seek(k) {
        const t0 = performance.now();
        k = Math.max(0, Math.min(this.ride.secs.length - 1, k));
        for (const s of this.sims) s.seek(k);
        this.k = k;
        return performance.now() - t0;
    }

    render() {
        const c = this.ctx, night = !!this.common.night;
        c.fillStyle = night ? '#000' : '#fff';
        c.fillRect(0, 0, this.device.width, this.device.height);
        const opts = { sec: this.k >= 0 ? this.ride.secs[this.k] : null, k: this.k, ride: this.ride, fonts: this.deviceFonts, night, units: this.common.units, clock12: this.common.clock12 };
        for (const f of this.fields) {
            if (f.sim) f.sim.renderApp();
            else if (f.app) drawTranslateError(c, f.loc);
            else drawMetricField(c, f.loc, f.metric, opts);
        }
        if (this.layout.fields.length > 1) drawSeparators(c, this.layout, this.device.width, this.device.height, night);
        // The side strip is not needed while a radar view field is on the screen
        if (this.common.radarBar && !this.fields.some(f => f.metric === 'radar' || f.metric === 'radarFull')) drawRadarBar(c, this.device.width, this.device.height, this.ride, this.k);
    }
}

function drawTranslateError(c, { x, y, w, h }) {
    c.fillStyle = '#000'; c.fillRect(x, y, w, h);
    c.fillStyle = '#ff3030'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `bold ${Math.max(12, Math.round(Math.min(w, h * 1.5) / 7))}px sans-serif`;
    c.fillText('IQ!', x + w / 2, y + h / 2);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
}
