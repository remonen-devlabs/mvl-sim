// The device's own data fields (speed, heart rate, ...) for the other fields of a data screen.
// Values come from the same ride data the app gets; they are drawn with the device's built-in fonts
// at the label/value positions of the device's simulator.json. Metric units.

const num = (v, d = 0) => v == null || !isFinite(v) ? null : v.toFixed(d);
const clock = (sec) => {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const started = (s) => s.timer !== 0;

// Average of a value over the last n seconds (nulls skipped), like 3s power
function avgBack(ride, k, n, key) {
    let sum = 0, c = 0;
    for (let i = Math.max(0, k - n + 1); i <= k; i++) { const v = ride.secs[i][key]; if (v != null) { sum += v; c++; } }
    return c ? sum / c : null;
}

// Values that need the ride so far, computed once per ride for every second:
// - Normalized Power: 30 s rolling average over timer seconds with a power reading (the window runs on
//   across laps), averaged to the 4th power. Matches the NP the Edge wrote for 2 rides and 19 of 20 laps.
// - Lap: a lap starts at each lap mark of the FIT file; lap time counts timer time.
// - Grade: altitude change over the last 50 m or more of distance (altitude averaged over 5 s), held while
//   standing. Garmin's own smoothing is not published, so this is an approximation.
const derivedCache = new WeakMap();
function derived(ride) {
    let d = derivedCache.get(ride);
    if (d) return d;
    const n = ride.secs.length;
    d = { np: new Array(n).fill(null), lapNp: new Array(n).fill(null), lapStartMs: new Array(n).fill(0), grade: new Array(n).fill(null) };
    const win = [];
    let winSum = 0, s4 = 0, c4 = 0, lap4 = 0, lapC = 0, lapStart = 0, grade = null;
    const alt5 = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const s = ride.secs[i];
        if (s.events.includes('lap')) { lapStart = s.timerMs; lap4 = 0; lapC = 0; }
        if (s.timer === 3 && s.power != null) {
            win.push(s.power); winSum += s.power;
            if (win.length > 30) winSum -= win.shift();
            if (win.length === 30) { const a4 = (winSum / 30) ** 4; s4 += a4; c4++; lap4 += a4; lapC++; }
        }
        d.np[i] = c4 ? (s4 / c4) ** 0.25 : null;
        d.lapNp[i] = lapC ? (lap4 / lapC) ** 0.25 : null;
        d.lapStartMs[i] = lapStart;
        // 5 s average altitude
        let as = 0, ac = 0;
        for (let j = Math.max(0, i - 4); j <= i; j++) { const v = ride.secs[j].altitude; if (v != null) { as += v; ac++; } }
        alt5[i] = ac ? as / ac : null;
        if (s.speed != null && s.speed >= 1 && alt5[i] != null) {
            for (let j = i - 1; j >= Math.max(0, i - 120); j--) {
                const p = ride.secs[j], dist = s.distance - p.distance;
                if (dist >= 50) { if (alt5[j] != null) grade = (alt5[i] - alt5[j]) / dist * 100; break; }
            }
        }
        d.grade[i] = s.timer === 0 ? null : grade;
    }
    derivedCache.set(ride, d);
    return d;
}

// id -> { label, value(s, k, ride) -> string | null }
export const METRICS = {
    none:        { label: '', value: () => '' },
    speed:       { label: 'Speed', value: (s) => num(s.speed == null ? null : s.speed * 3.6, 1) },
    avgSpeed:    { label: 'Avg Speed', value: (s) => num(s.stats.avgSpeed == null ? null : s.stats.avgSpeed * 3.6, 1) },
    maxSpeed:    { label: 'Max Speed', value: (s) => num(s.stats.maxSpeed == null ? null : s.stats.maxSpeed * 3.6, 1) },
    power:       { label: 'Power', value: (s) => num(s.power) },
    power3s:     { label: '3s Power', value: (s, k, r) => num(avgBack(r, k, 3, 'power')) },
    power10s:    { label: '10s Power', value: (s, k, r) => num(avgBack(r, k, 10, 'power')) },
    avgPower:    { label: 'Avg Power', value: (s) => num(s.stats.avgPower) },
    maxPower:    { label: 'Max Power', value: (s) => num(s.stats.maxPower) },
    np:          { label: 'Normalized Pwr', value: (s, k, r) => num(derived(r).np[k]) },
    lapNp:       { label: 'Lap NP', value: (s, k, r) => num(derived(r).lapNp[k]) },
    lapTime:     { label: 'Lap Time', value: (s, k, r) => clock((s.timerMs - derived(r).lapStartMs[k]) / 1000) },
    grade:       { label: 'Grade', value: (s, k, r) => { const g = derived(r).grade[k]; return g == null ? null : `${Math.round(g) || 0}%`; } },
    hr:          { label: 'Heart Rate', value: (s) => num(s.hr) },
    avgHr:       { label: 'Avg HR', value: (s) => num(s.stats.avgHr) },
    maxHr:       { label: 'Max HR', value: (s) => num(s.stats.maxHr) },
    cadence:     { label: 'Cadence', value: (s) => num(s.cadence) },
    avgCadence:  { label: 'Avg Cadence', value: (s) => num(s.stats.avgCadence) },
    distance:    { label: 'Distance', value: (s) => started(s) ? num(s.distance / 1000, s.distance < 100000 ? 2 : 1) : null },
    timer:       { label: 'Timer', value: (s) => clock(s.timerMs / 1000) },
    elapsed:     { label: 'Elapsed Time', value: (s, k, r) => started(s) && s.startT != null ? clock(s.t - s.startT) : clock(0) },
    timeOfDay:   { label: 'Time of Day', value: (s, k, r) => {
        const d = new Date((s.t + r.epoch + (r.localOffset || 0)) * 1000);
        return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    } },
    altitude:    { label: 'Elevation', value: (s) => num(s.altitude) },
    ascent:      { label: 'Total Ascent', value: (s) => started(s) ? num(s.totalAscent) : null },
    descent:     { label: 'Total Descent', value: (s) => started(s) ? num(s.totalDescent) : null },
    calories:    { label: 'Calories', value: (s) => started(s) ? num(s.calories) : null },
    temperature: { label: 'Temperature', value: (s) => num(s.temp) },
    radar:       { label: 'Radar view', draw: (ctx, f, o) => drawRadarView(ctx, f, o) },
    radarFull:   { label: 'Radar (full screen)', draw: (ctx, f, o) => drawRadarView(ctx, f, o, true) },
    gears:       { label: 'Gears', value: (s) => s.gear && s.gear.fSize != null && s.gear.rSize != null ? `${s.gear.fSize}/${s.gear.rSize}` : null },
};

// What the other fields show when the user has not picked anything
export const DEFAULT_METRICS = ['speed', 'hr', 'power3s', 'cadence', 'distance', 'timer', 'ascent', 'timeOfDay', 'altitude', 'avgSpeed'];

// The metric of every field of a layout: the user's picks, else the defaults in order (skipping the app's field)
export function metricsFor(layout, appField, picks) {
    const out = [];
    let d = 0;
    layout.fields.forEach((f, i) => {
        if (i === appField) { out.push(null); return; }
        const p = picks && picks[i];
        out.push(p && METRICS[p] ? p : DEFAULT_METRICS[d % DEFAULT_METRICS.length]);
        d++;
    });
    return out;
}

// simulator.json gives label/value positions as text baselines: the font's top is this far above
export const top = (font) => font.ascent ?? font.height * 0.8;

// Draw one field. fonts: FontSet.builtins (Map name -> font with width/height/draw)
export function drawMetricField(ctx, f, id, { sec, k, ride, fonts, night }) {
    const m = METRICS[id] || METRICS.none;
    const fg = night ? '#ffffff' : '#000000';
    ctx.fillStyle = night ? '#000000' : '#ffffff';
    ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
    try {
        if (m.draw) { m.draw(ctx, f, { sec, k, ride, fonts, night }); return; }
        if (m.label && !f.labelDisabled) {
            const lf = (f.label && fonts.get(f.label.font)) || fonts.get('small');
            if (lf) {
                const lx = f.label ? f.label.x : f.w / 2, ly = f.label ? f.label.y : f.h * 0.25;
                const tw = lf.width(m.label);
                lf.draw(ctx, f.x + lx - tw / 2, f.y + (f.label ? ly - top(lf) : ly - lf.height / 2), m.label, night ? '#bbbbbb' : '#444444');
            }
        }
        const text = sec ? (m.value(sec, k, ride) ?? '--') : '--';
        if (!text) return;
        const dx = f.data ? f.data.x : f.w / 2, dy = f.data ? f.data.y : f.h * 0.6;
        // The device's value font; while the text is too wide, the next smaller built-in font (as the Edge does)
        const maxW = (f.data && f.data.width) || f.w - 6;
        let df = (f.data && fonts.get(f.data.font)) || fonts.get('numberHot') || fonts.get('large');
        if (!df) return;
        if (df.width(text) > maxW) {
            const smaller = [...new Set(fonts.values())].filter(x => x.height < df.height).sort((p, q) => q.height - p.height);
            df = smaller.find(x => x.width(text) <= maxW) || smaller[smaller.length - 1] || df;
        }
        const vw = df.width(text);
        df.draw(ctx, f.x + dx - vw / 2, f.y + (f.data ? dy - top(df) : dy - df.height / 2), text, fg);
    } finally {
        ctx.restore();
    }
}

// Grey separator lines between the fields of a layout
export function drawSeparators(ctx, layout, W, H, night) {
    ctx.fillStyle = night ? '#4a4a4a' : '#b4b4b4';
    for (const f of layout.fields) {
        if (f.x + f.w < W - 1) ctx.fillRect(f.x + f.w - 1, f.y, 1, f.h);
        if (f.y + f.h < H - 1) ctx.fillRect(f.x, f.y + f.h - 1, f.w, 1);
    }
}

// The device's radar bar: a vertical track along the right edge standing for the road behind, shown
// while a vehicle is behind. The rider is at the top; each vehicle is a dot that starts at the bottom
// (140 m back) and moves up as it closes in. Each dot has its own colour: amber for approaching, red
// for approaching fast (closing at 9 m/s or more, as MVL Sim's AntPlus.BikeRadar reports it). The
// track's edge shows the highest threat; it turns green for 3 s once nothing is behind. Garmin also
// sizes the icon by vehicle size, which the FIT file does not record, so all dots are the same size.
const RADAR_RANGE = 140;
const AMBER = '#ffa400', RED = '#e3262d', GREEN = '#2fb54a';
export function drawRadarBar(ctx, W, H, ride, k) {
    if (k < 0 || !ride.hasRadar) return;
    const s = ride.secs[k];
    const targets = s.radar ? s.radar.ranges.map((r, i) => ({ r, v: s.radar.speeds[i] || 0 })).filter(t => t.r > 0 && t.v > 0) : [];
    let clear = false;
    if (!targets.length) {
        for (let j = k - 1; j >= Math.max(0, k - 3); j--) {
            const p = ride.secs[j].radar;
            if (p && p.ranges.some((r, i) => r > 0 && (p.speeds[i] || 0) > 0)) { clear = true; break; }
        }
        if (!clear) return;
    }
    const bw = Math.max(10, Math.round(W * 0.06)), x = W - bw;
    const edge = Math.max(2, Math.round(bw * 0.14));
    if (clear) { ctx.fillStyle = GREEN; ctx.fillRect(x, 0, bw, H); return; }
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(x, 0, bw, H);
    ctx.fillStyle = targets.some(t => t.v >= 9) ? RED : AMBER;
    ctx.fillRect(x, 0, edge, H);
    // the rider at the top
    const cx = x + edge / 2 + bw / 2, rad = Math.max(3, (bw - edge) * 0.32), pad = Math.round(bw * 0.6);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(cx, pad); ctx.lineTo(cx + rad, pad + rad * 1.6); ctx.lineTo(cx - rad, pad + rad * 1.6); ctx.closePath(); ctx.fill();
    const top = pad + rad * 3, bottom = H - pad;
    for (const t of targets) {
        const y = top + Math.min(1, t.r / RADAR_RANGE) * (bottom - top);
        ctx.beginPath(); ctx.arc(cx, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = t.v >= 9 ? RED : AMBER; ctx.fill();
        ctx.lineWidth = Math.max(1, rad * 0.3); ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
}

// Targets behind at second k: [{ r: metres, v: closing m/s }], or null when the radar is off / not in the ride
function radarTargets(ride, k) {
    if (k < 0 || !ride.hasRadar) return null;
    const s = ride.secs[k];
    if (!s.radar) return null;
    return s.radar.ranges.map((r, i) => ({ r, v: s.radar.speeds[i] || 0 })).filter(t => t.r > 0 && t.v > 0);
}

// The radar view as a data field (the Edge's half-screen radar, in whatever field it is put): the road
// behind the rider as a vertical lane, the rider at the top, each vehicle a car shape that comes up from
// the bottom (140 m back) as it closes in, amber or red by its closing speed. The lane's edges show the
// highest threat, green when nothing is behind. Off or no radar data: a grey lane and a note.
function drawRadarView(ctx, f, { k, ride, fonts, night }, full = false) {
    const targets = radarTargets(ride, k);
    const bg = night ? '#000' : '#fff', fg = night ? '#fff' : '#000';
    // full screen: the lane left of centre, distance marks left of it and the numbers right of it
    const laneW = full ? Math.max(24, f.w * 0.3) : Math.max(24, Math.min(f.w * 0.42, f.h * 0.42));
    const lx = full ? f.x + f.w * 0.24 : f.x + (f.w - laneW) / 2;
    const edge = Math.max(3, Math.round(laneW * 0.07));
    const pad = Math.max(4, Math.round(f.h * 0.04));
    ctx.fillStyle = bg; ctx.fillRect(f.x, f.y, f.w, f.h);
    ctx.fillStyle = night ? '#2e2e2e' : '#3a3a3a';
    ctx.fillRect(lx, f.y, laneW, f.h);
    const threat = targets == null ? '#8a8a8a' : !targets.length ? GREEN : targets.some(t => t.v >= 9) ? RED : AMBER;
    ctx.fillStyle = threat;
    ctx.fillRect(lx - edge, f.y, edge, f.h);
    ctx.fillRect(lx + laneW, f.y, edge, f.h);
    // dashed centre line
    ctx.fillStyle = night ? '#777' : '#bdbdbd';
    const dash = Math.max(6, Math.round(f.h * 0.05));
    for (let y = f.y + dash / 2; y < f.y + f.h; y += dash * 2) ctx.fillRect(lx + laneW / 2 - 1, y, 2, dash);
    // the rider at the top
    const cx = lx + laneW / 2, rs = laneW * 0.16, ry = f.y + pad;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, rs * 0.15);
    ctx.beginPath(); ctx.moveTo(cx, ry); ctx.lineTo(cx + rs, ry + rs * 1.9); ctx.lineTo(cx, ry + rs * 1.4); ctx.lineTo(cx - rs, ry + rs * 1.9); ctx.closePath();
    ctx.fill(); ctx.stroke();
    // car size: fits the lane, and short enough that vehicles a few metres apart stay apart
    const carH = Math.min(laneW * 0.46 * 1.5, f.h * 0.11), carW = carH / 1.5;
    const top = ry + rs * 2.2 + carH / 2, bottom = f.y + f.h - pad - carH / 2;
    if (full) drawRadarDetails(ctx, f, { k, ride, fonts, night, targets, lx, laneW, edge, top, bottom });
    if (targets == null) {
        const sf = fonts.get('small') || fonts.get('tiny');
        const text = ride.hasRadar ? 'Radar off' : 'No radar data';
        if (sf) { const tw = sf.width(text); ctx.fillStyle = bg; ctx.fillRect(cx - tw / 2 - 4, f.y + f.h / 2 - sf.height / 2 - 2, tw + 8, sf.height + 4); sf.draw(ctx, cx - tw / 2, f.y + f.h / 2 - sf.height / 2, text, fg); }
        return;
    }
    for (const t of targets.slice().sort((a, b) => b.r - a.r)) {
        const y = top + Math.min(1, t.r / RADAR_RANGE) * (bottom - top);
        roundRect(ctx, cx - carW / 2, y - carH / 2, carW, carH, carW * 0.28);
        ctx.fillStyle = t.v >= 9 ? RED : AMBER; ctx.fill();
        ctx.lineWidth = Math.max(1.5, carW * 0.08); ctx.strokeStyle = '#fff'; ctx.stroke();
        // windscreen
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(cx - carW * 0.3, y - carH * 0.32, carW * 0.6, carH * 0.18);
    }
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

// Full-screen radar: distance marks beside the lane, and right of it the nearest vehicle's distance and
// closing speed and the vehicles passed so far (the FIT file's radar_current, when the ride has it)
function drawRadarDetails(ctx, f, { k, ride, fonts, night, targets, lx, laneW, edge, top, bottom }) {
    const fg = night ? '#fff' : '#000', muted = night ? '#aaa' : '#555';
    const tf = fonts.get('tiny') || fonts.get('small');
    // distance marks every 25 m
    ctx.fillStyle = muted;
    for (let d = 25; d < RADAR_RANGE; d += 25) {
        const y = top + d / RADAR_RANGE * (bottom - top);
        ctx.fillRect(lx - edge - 10, Math.round(y), 8, 2);
        if (tf) { const t = `${d} m`, w = tf.width(t); tf.draw(ctx, lx - edge - 14 - w, y - tf.height / 2, t, muted); }
    }
    // numbers in the right column
    const x0 = lx + laneW + edge, colW = f.x + f.w - x0;
    const lf = fonts.get('small') || tf;
    const near = targets && targets.length ? targets.slice().sort((a, b) => a.r - b.r)[0] : null;
    const s = k >= 0 ? ride.secs[k] : null;
    const rows = [
        ['Nearest m', near ? String(near.r) : '--'],
        ['Closing km/h', near ? String(Math.round(near.v * 3.6)) : '--'],
        ['Passed', s && s.radarPassed != null ? String(s.radarPassed) : '--'],
    ];
    const rowH = Math.min((f.h - 20) / rows.length, f.h * 0.3);
    const vfonts = ['numberMedium', 'numberMild', 'large', 'medium', 'small'].map(n => fonts.get(n)).filter(Boolean);
    rows.forEach(([label, value], i) => {
        const y0 = f.y + 10 + i * rowH;
        if (lf) { const w = lf.width(label); lf.draw(ctx, x0 + (colW - w) / 2, y0, label, muted); }
        const room = rowH - (lf ? lf.height : 0) - 6;
        const vf = vfonts.find(v => v.width(value) <= colW - 10 && v.height <= room) || vfonts[vfonts.length - 1];
        if (vf) { const w = vf.width(value); vf.draw(ctx, x0 + (colW - w) / 2, y0 + (lf ? lf.height : 0) + 2, value, fg); }
    });
}
