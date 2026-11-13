// Turns decoded FIT messages into a per-second timeline of what the Edge would hand a data field.

const SEMI = 180 / 2147483648;
const FIT_EPOCH = 631065600; // FIT time 0 = 1989-12-31T00:00:00Z

export const TIMER_OFF = 0, TIMER_STOPPED = 1, TIMER_PAUSED = 2, TIMER_ON = 3;

export function buildRide(fit) {
    const msgs = fit.messages;
    const records = [];
    const timerEvents = [];
    const gearEvents = [];
    const laps = [], lapStarts = [];
    const weather = [];
    const battery = [];
    let localOffset = null;
    let sessionAscent = null, sessionDescent = null;
    let ftp = null, thr = null, maxHr = null;
    let sport = null, subSport = null;
    const profile = { gender: null, age: null, height: null, weight: null, restingHr: null };

    for (const m of msgs) {
        const f = m.fields;
        switch (m.num) {
            case 20: if (f[253] != null) records.push(m); break;
            case 21:
                if (f[0] === 0 && f[253] != null) timerEvents.push({ t: f[253], type: f[1] });
                if ((f[0] === 42 || f[0] === 43) && f[253] != null && f[3] != null) gearEvents.push({ t: f[253], data: f[3] });
                break;
            // lap: 2 start_time. A new lap starts at each lap's start (its timestamp can be the ride's start)
            case 19: if (f[2] != null) lapStarts.push(f[2]); else if (f[253] != null) laps.push(f[253]); break;
            case 34: if (f[5] != null && f[253] != null) localOffset = f[5] - f[253]; break;
            case 18:
                if (f[22] != null) sessionAscent = f[22];
                if (f[23] != null) sessionDescent = f[23];
                if (f[5] != null) sport = f[5];
                if (f[6] != null) subSport = f[6];
                break;
            case 12: if (f[0] != null && sport == null) sport = f[0]; if (f[1] != null && subSport == null) subSport = f[1]; break;
            // zones_target: 1 max_heart_rate, 2 threshold_heart_rate, 3 functional_threshold_power
            case 7: if (f[3] != null) ftp = f[3]; if (f[2] != null) thr = f[2]; if (f[1] != null) maxHr = f[1]; break;
            // user_profile: 1 gender, 2 age, 3 height (cm), 4 weight (0.1 kg), 8 resting_heart_rate
            case 3:
                if (f[1] != null) profile.gender = f[1];
                if (f[2] != null) profile.age = f[2];
                if (f[3] != null) profile.height = f[3];
                if (f[4] != null) profile.weight = f[4] / 10;
                if (f[8] != null) profile.restingHr = f[8];
                break;
            // Battery %: Garmin's undocumented message 104 (field 2, about once a minute on Edge files),
            // or device_info battery_level (32) of the recording device (device_index 0)
            case 104: if (f[253] != null && f[2] != null && f[2] <= 100) battery.push({ t: f[253], pct: f[2] }); break;
            case 23: if (f[253] != null && f[0] === 0 && f[32] != null && f[32] <= 100) battery.push({ t: f[253], pct: f[32] }); break;
            case 128:
                // weather_conditions: 0 report (0 = current), 3 wind_direction (deg), 4 wind_speed (mm/s)
                if (f[253] != null && f[0] === 0 && f[3] != null && f[4] != null) weather.push({ t: f[253], bearing: f[3], speed: f[4] / 1000, temp: f[1] });
                break;
        }
    }
    if (records.length === 0) throw new Error('No record messages in the FIT file');
    // Lap boundaries: the start of every lap after the first, else (no start_time) each lap's end
    if (lapStarts.length) { laps.length = 0; laps.push(...lapStarts.sort((a, b) => a - b).slice(1)); }
    else laps.sort((a, b) => a - b);

    const recByT = new Map();
    for (const r of records) recByT.set(r.fields[253], r);
    const tStart = Math.min(records[0].fields[253], timerEvents.length ? timerEvents[0].t : Infinity);
    const tEnd = records[records.length - 1].fields[253];
    const n = tEnd - tStart + 1;

    // Gear counts: the largest index seen
    let frontMax = null, rearMax = null;
    for (const g of gearEvents) {
        const ri = g.data & 0xFF, fi = (g.data >>> 16) & 0xFF;
        if (ri !== 255 && ri > 0) rearMax = Math.max(rearMax ?? 0, ri);
        if (fi !== 255 && fi > 0) frontMax = Math.max(frontMax ?? 0, fi);
    }

    // Raw ascent with hysteresis, scaled at the end to the session total
    const thrAscent = 2.0;

    const secs = new Array(n);
    let timer = TIMER_OFF, ev = 0, gi = 0, li = 0;
    let last = null;
    let gear = { fIdx: null, fSize: null, rIdx: null, rSize: null };
    let ascentRaw = 0, ref = null, timerMs = 0, distance = 0;
    let descentRaw = 0, dref = null;
    const st = { pSum: 0, pN: 0, pMax: null, cSum: 0, cN: 0, cMax: null, hSum: 0, hN: 0, hMax: null, sMax: null };
    let startLat = null, startLon = null, startT = null;
    let lat = null, lon = null;
    const track = [];
    let radar = null; // {ranges, speeds} or null = off
    let radarPassed = null; // radar_current: vehicles passed so far
    let hasRadar = false;
    for (let i = 0; i < n; i++) {
        const t = tStart + i;
        const events = [];
        while (ev < timerEvents.length && timerEvents[ev].t <= t) {
            const e = timerEvents[ev++];
            const before = timer;
            if (e.type === 0) timer = TIMER_ON;
            else if (e.type === 1 || e.type === 4) timer = TIMER_PAUSED;
            if (before !== TIMER_ON && timer === TIMER_ON) events.push(before === TIMER_OFF ? 'start' : 'resume');
            if (before === TIMER_ON && timer !== TIMER_ON) events.push('pause');
        }
        if (timer === TIMER_OFF && recByT.has(t)) { timer = TIMER_ON; events.push('start'); }
        while (gi < gearEvents.length && gearEvents[gi].t <= t) {
            const d = gearEvents[gi++].data;
            gear = { rIdx: d & 0xFF, rSize: (d >>> 8) & 0xFF, fIdx: (d >>> 16) & 0xFF, fSize: (d >>> 24) & 0xFF };
        }
        while (li < laps.length && laps[li] <= t) { li++; if (laps[li - 1] < tEnd) events.push('lap'); }

        const rec = recByT.get(t);
        if (rec) {
            const f = rec.fields;
            // A record without altitude (e.g. the last one) keeps the previous value, as the Edge would
            const alt = f[78] != null ? f[78] / 5 - 500 : (f[2] != null ? f[2] / 5 - 500 : (last ? last.altitude : null));
            const spd = f[73] != null ? f[73] / 1000 : (f[6] != null ? f[6] / 1000 : null);
            if (f[0] != null && f[1] != null) { lat = f[0] * SEMI; lon = f[1] * SEMI; }
            if (f[5] != null) distance = f[5] / 100;
            last = { power: f[7] ?? null, hr: f[3] ?? null, cadence: f[4] ?? null, speed: spd, altitude: alt, temp: f[13] ?? null,
                calories: f[33] ?? (last ? last.calories : null), pressure: f[91] ?? null };
            const rr = rec.dev.radar_ranges, rs = rec.dev.radar_speeds;
            if (Array.isArray(rr)) {
                hasRadar = true;
                radar = rr.some(v => v === -1) ? null : { ranges: rr, speeds: Array.isArray(rs) ? rs : [] };
            }
            if (typeof rec.dev.radar_current === 'number' && rec.dev.radar_current !== 0xFFFF) radarPassed = rec.dev.radar_current;
        }
        const cur = last ? { ...last } : { power: null, hr: null, cadence: null, speed: null, altitude: null, temp: null, calories: null, pressure: null };
        if (timer !== TIMER_ON && last) {
            cur.speed = 0;
            if (cur.power != null) cur.power = 0;
            if (cur.cadence != null) cur.cadence = 0;
        }
        if (timer === TIMER_ON) {
            if (i > 0) timerMs += 1000;
            if (cur.altitude != null) {
                if (ref === null) ref = cur.altitude;
                else if (cur.altitude - ref >= thrAscent) { ascentRaw += cur.altitude - ref; ref = cur.altitude; }
                else if (ref - cur.altitude >= thrAscent) ref = cur.altitude;
                if (dref === null) dref = cur.altitude;
                else if (dref - cur.altitude >= thrAscent) { descentRaw += dref - cur.altitude; dref = cur.altitude; }
                else if (cur.altitude - dref >= thrAscent) dref = cur.altitude;
            }
            // Running statistics over timer time: power averaged with zeros, cadence without zeros
            if (cur.power != null) { st.pSum += cur.power; st.pN++; st.pMax = Math.max(st.pMax ?? 0, cur.power); }
            if (cur.cadence != null) { if (cur.cadence > 0) { st.cSum += cur.cadence; st.cN++; } st.cMax = Math.max(st.cMax ?? 0, cur.cadence); }
            if (cur.hr != null) { st.hSum += cur.hr; st.hN++; st.hMax = Math.max(st.hMax ?? 0, cur.hr); }
            if (cur.speed != null) st.sMax = Math.max(st.sMax ?? 0, cur.speed);
            if (startLat === null && lat !== null) { startLat = lat; startLon = lon; }
            if (startT === null) startT = t;
        }
        if (lat !== null) track.push([lat, lon]);
        secs[i] = {
            t, timer, events, ...cur, gear: { ...gear }, frontMax, rearMax,
            ascentRaw, descentRaw, timerMs, distance, lat, lon, trackIndex: track.length - 1, radar, radarPassed,
            stats: {
                avgPower: st.pN ? st.pSum / st.pN : null, maxPower: st.pMax, avgCadence: st.cN ? st.cSum / st.cN : null, maxCadence: st.cMax,
                avgHr: st.hN ? st.hSum / st.hN : null, maxHr: st.hMax, maxSpeed: st.sMax,
                avgSpeed: timerMs > 0 ? distance / (timerMs / 1000) : null,
            },
            startLat, startLon, startT,
        };
    }

    // Scale ascent so the end matches the session's total ascent (the Edge's own figure)
    const scale = sessionAscent != null && ascentRaw > 0 ? sessionAscent / ascentRaw : 1;
    for (const s of secs) s.totalAscent = Math.round(s.ascentRaw * scale);
    const dscale = sessionDescent != null && descentRaw > 0 ? sessionDescent / descentRaw : 1;
    for (const s of secs) s.totalDescent = Math.round(s.descentRaw * dscale);

    // Heading from the GPS track: bearing from the position a few seconds back
    for (let i = 0; i < n; i++) {
        const s = secs[i];
        s.heading = null;
        if (s.lat === null || !(s.speed >= 1.0)) continue;
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
            const p = secs[j];
            if (p.lat === null) break;
            const dist = haversine(p.lat, p.lon, s.lat, s.lon);
            if (dist >= 8) { s.heading = bearing(p.lat, p.lon, s.lat, s.lon); break; }
        }
    }

    // Weather: the Edge keeps the latest report
    weather.sort((a, b) => a.t - b.t);
    let wi = -1;
    for (const s of secs) {
        while (wi + 1 < weather.length && weather[wi + 1].t <= s.t) wi++;
        s.weather = wi >= 0 ? weather[wi] : null;
    }
    // Battery: the latest reading; before the first one, the first one
    battery.sort((a, b) => a.t - b.t);
    let bi = 0;
    for (const s of secs) {
        while (bi + 1 < battery.length && battery[bi + 1].t <= s.t) bi++;
        s.battery = battery.length ? battery[bi].pct : null;
    }

    return {
        secs, track, tStart, tEnd,
        localOffset: localOffset ?? 0,
        epoch: FIT_EPOCH,
        sessionAscent, sessionDescent, ftp, thr, maxHr, sport, subSport, profile,
        hasGears: gearEvents.length > 0, hasRadar, hasWeather: weather.length > 0, hasBattery: battery.length > 0,
        firstWeather: weather[0] || null,
    };
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Radians clockwise from north, -PI..PI like Activity.Info.currentHeading
function bearing(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
    const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
    return Math.atan2(y, x);
}

// Before a FIT file is open: one second of an Edge that is on but not recording (timer off, no
// sensors, no GPS), at the current local time. Lets the screen and its fields be set up first.
export function idleRide(now = new Date()) {
    const t = Math.floor(now.getTime() / 1000) - FIT_EPOCH;
    const nulls = { power: null, hr: null, cadence: null, speed: null, altitude: null, temp: null, calories: null, pressure: null };
    const sec = {
        t, timer: TIMER_OFF, events: [], ...nulls,
        gear: { fIdx: null, fSize: null, rIdx: null, rSize: null }, frontMax: null, rearMax: null,
        ascentRaw: 0, descentRaw: 0, totalAscent: 0, totalDescent: 0, timerMs: 0, distance: 0,
        lat: null, lon: null, trackIndex: -1, radar: null, heading: null, weather: null,
        stats: { avgPower: null, maxPower: null, avgCadence: null, maxCadence: null, avgHr: null, maxHr: null, maxSpeed: null, avgSpeed: null },
        startLat: null, startLon: null, startT: null,
    };
    return {
        idle: true, secs: [sec], track: [], tStart: t, tEnd: t,
        localOffset: -now.getTimezoneOffset() * 60, epoch: FIT_EPOCH,
        sessionAscent: null, sessionDescent: null, ftp: null, thr: null, maxHr: null, sport: null, subSport: null,
        profile: { gender: null, age: null, height: null, weight: null, restingHr: null },
        hasGears: false, hasRadar: false, hasWeather: false, firstWeather: null,
    };
}
