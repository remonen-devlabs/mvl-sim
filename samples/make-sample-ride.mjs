#!/usr/bin/env node
// Writes sample-ride.fit: a made-up 40-minute road ride for trying MVL Sim without a ride of your own.
// Nothing in it comes from a real ride. Two laps of a 10 km circle (it does not follow roads) with a
// hill, power, heart rate, cadence, gear changes (2x11), a 1-minute pause, cars on the radar (and the radar
// off for a while),
// FTP 250 W and the battery level. Deterministic: the same file every run.
//
//   node make-sample-ride.mjs [output.fit]

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'sample-ride.fit');

// ------------------------------------------------------------- FIT writer

const T = { enum: 0x00, sint8: 0x01, uint8: 0x02, sint16: 0x83, uint16: 0x84, sint32: 0x85, uint32: 0x86,
    string: 0x07, byte: 0x0D };
const SIZE = { 0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1, 0x0D: 1 };
const INVALID = { 0x00: 0xFF, 0x01: 0x7F, 0x02: 0xFF, 0x83: 0x7FFF, 0x84: 0xFFFF, 0x85: 0x7FFFFFFF, 0x86: 0xFFFFFFFF, 0x0D: 0xFF };

const chunks = [];
const defs = {};
function bytes(n, fill) { const b = Buffer.alloc(n); fill(b); chunks.push(b); }

// fields: [[num, type, count?]]; devFields: [[num, size, devIndex]]
function define(local, mesgNum, fields, devFields = []) {
    defs[local] = { fields, devFields };
    bytes(6 + fields.length * 3 + (devFields.length ? 1 + devFields.length * 3 : 0), (b) => {
        let o = 0;
        b[o++] = 0x40 | (devFields.length ? 0x20 : 0) | local;
        b[o++] = 0; b[o++] = 0; // reserved, little endian
        b.writeUInt16LE(mesgNum, o); o += 2;
        b[o++] = fields.length;
        for (const [num, type, count = 1] of fields) { b[o++] = num; b[o++] = SIZE[type] * count; b[o++] = type; }
        if (devFields.length) {
            b[o++] = devFields.length;
            for (const [num, size, dev] of devFields) { b[o++] = num; b[o++] = size; b[o++] = dev; }
        }
    });
}

// values in field order; null = invalid; devValues: [[type, value]]
function data(local, values, devValues = []) {
    const { fields } = defs[local];
    const size = 1 + fields.reduce((n, [, t, c = 1]) => n + SIZE[t] * c, 0)
        + devValues.reduce((n, [t, v]) => n + SIZE[t] * (Array.isArray(v) ? v.length : 1), 0);
    bytes(size, (b) => {
        let o = 0;
        b[o++] = local;
        const put = (type, v, count) => {
            if (type === T.string || type === T.byte && count > 1) {
                const src = typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v);
                src.copy(b, o, 0, Math.min(src.length, count - (type === T.string ? 1 : 0)));
                o += count;
                return;
            }
            const vals = Array.isArray(v) ? v : [v];
            for (let i = 0; i < count; i++) {
                const x = vals[i] ?? INVALID[type];
                switch (type) {
                    case 0x00: case 0x02: case 0x0D: b.writeUInt8(x, o); break;
                    case 0x01: b.writeInt8(x, o); break;
                    case 0x83: b.writeInt16LE(x, o); break;
                    case 0x84: b.writeUInt16LE(x, o); break;
                    case 0x85: b.writeInt32LE(x, o); break;
                    case 0x86: b.writeUInt32LE(x >>> 0, o); break;
                }
                o += SIZE[type];
            }
        };
        fields.forEach(([, type, count = 1], i) => put(type, values[i], count));
        for (const [type, v] of devValues) put(type, v, Array.isArray(v) ? v.length : 1);
    });
}

function crc16(buf, crc = 0) {
    const tab = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
    for (const byte of buf) {
        let t = tab[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ tab[byte & 0xF];
        t = tab[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ tab[(byte >> 4) & 0xF];
    }
    return crc;
}

// ------------------------------------------------------------- the ride

const FIT_EPOCH = 631065600;
const START = Date.UTC(2026, 5, 20, 7, 0, 0) / 1000 - FIT_EPOCH; // 20 June 2026, 09:00 local
const LOCAL_OFFSET = 2 * 3600;
const RIDE_S = 40 * 60;
const PAUSE_AT = 1300, PAUSE_S = 60;
const LOOP_M = 10000;
const R = LOOP_M / (2 * Math.PI);
const CENTER = [52.03, 5.30]; // made-up circle in the countryside
const MASS = 80, CRR = 0.004, CDA = 0.32, RHO = 1.2, G = 9.81;

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x7FFFFFFF; };
const noise = (a) => (rnd() * 2 - 1) * a;

const altAt = (d) => { const th = (d / LOOP_M) * 2 * Math.PI; return 30 + 22 * Math.sin(th) + 6 * Math.sin(3 * th); };
const posAt = (d) => {
    const th = (d / LOOP_M) * 2 * Math.PI;
    const north = R * Math.sin(th), east = R * (1 - Math.cos(th)); // starts at the circle's west point, heading north
    return [CENTER[0] + north / 111320, CENTER[1] - R / (111320 * Math.cos(CENTER[0] * Math.PI / 180))
        + east / (111320 * Math.cos(CENTER[0] * Math.PI / 180))];
};
const SEMI = 2147483648 / 180;

// Cars: start time (s), start distance behind (m), closing speed (m/s)
// (speeds in 3 m/s steps, as an ANT+ radar reports them); the radar is off from RADAR_OFF for a while
const CARS = [[300, 140, 9], [312, 140, 6], [900, 140, 12], [1700, 140, 6], [2100, 140, 9], [2130, 140, 9]];
const RADAR_OFF = [1450, 1600];
const CHAINRINGS = [50, 34], COGS = [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30];

// file_id, developer data, zones target
define(0, 0, [[0, T.enum], [1, T.uint16], [2, T.uint16], [4, T.uint32]]);
data(0, [4, 255, 1, START]); // activity file, manufacturer "development"
define(1, 207, [[1, T.byte, 16], [3, T.uint8]]);
data(1, [Array.from({ length: 16 }, (_, i) => i + 1), 0]);
define(2, 206, [[0, T.uint8], [1, T.uint8], [2, T.uint8], [3, T.string, 16], [8, T.string, 8], [14, T.uint16]]);
data(2, [0, 0, T.sint16, 'radar_ranges', 'm', 20]);
data(2, [0, 1, T.uint8, 'radar_speeds', 'm/s', 20]);
data(2, [0, 2, T.uint16, 'radar_current', '', 20]);
define(3, 7, [[1, T.uint8], [2, T.uint8], [3, T.uint16]]);
data(3, [185, 165, 250]);

define(4, 21, [[253, T.uint32], [0, T.enum], [1, T.enum], [3, T.uint32]]); // event
define(5, 20, [[253, T.uint32], [0, T.sint32], [1, T.sint32], [5, T.uint32], [73, T.uint32], [78, T.uint32],
    [7, T.uint16], [3, T.uint8], [4, T.uint8]], [[0, 16, 0], [1, 8, 0], [2, 2, 0]]); // record
define(6, 104, [[253, T.uint32], [2, T.uint8]]); // battery (Garmin, undocumented)
define(7, 19, [[253, T.uint32], [2, T.uint32], [7, T.uint32], [9, T.uint32]]); // lap

data(4, [START, 0, 0, null]); // timer start

let d = 0, hr = 95, timerS = 0, lapStart = START, lapStartTimer = 0, lapStartD = 0, lap = 1;
let ascent = 0, descent = 0, lastAlt = altAt(0);
let front = 0, rear = 5, passed = 0, lastShift = -10;
for (let s = 0; s < RIDE_S + PAUSE_S; s++) {
    const t = START + s;
    if (s === PAUSE_AT) data(4, [t, 0, 4, null]); // stop all
    if (s >= PAUSE_AT && s < PAUSE_AT + PAUSE_S) { hr = Math.max(90, hr - 1); continue; }
    if (s === PAUSE_AT + PAUSE_S) data(4, [t, 0, 0, null]); // start again

    // Speed from the grade, power from the speed
    const grade = (altAt(d + 5) - altAt(d - 5)) / 10;
    const ramp = Math.min(1, timerS / 20);
    let v = ramp * Math.max(4, Math.min(14, 9.2 - grade * 70 + noise(0.3)));
    let p = (CRR * MASS * G + MASS * G * grade) * v + 0.5 * RHO * CDA * v ** 3 + noise(15);
    p = Math.max(0, Math.round(p));
    if (grade < -0.025) p = rnd() < 0.7 ? 0 : Math.round(p * 0.3);
    const cadence = p === 0 ? 0 : Math.round(86 + noise(4) - grade * 150);
    hr += ((90 + p * 0.33) - hr) / 25;

    // Gears: front by grade, rear for about 90 rpm
    if (grade > 0.02 && front === 0) { front = 1; data(4, [t, 43, 3, gearData()]); }
    if (grade < 0 && front === 1) { front = 0; data(4, [t, 43, 3, gearData()]); }
    if (cadence > 0 && s - lastShift >= 5) {
        const want = CHAINRINGS[front] / (v * 60 / (2.1 * 90));
        let best = 0;
        COGS.forEach((c, i) => { if (Math.abs(c - want) < Math.abs(COGS[best] - want)) best = i; });
        if (best !== rear && Math.abs(COGS[rear] - want) > 1.5) { rear += Math.sign(best - rear); lastShift = s; data(4, [t, 42, 3, gearData()]); }
    }

    // Radar: cars behind, closest first
    const cars = [];
    for (const [t0, back, closing] of CARS) {
        const r = back - (s - t0) * closing;
        if (s >= t0 && r > 0) cars.push([Math.round(r), closing]);
        if (s >= t0 && r <= 0 && r > -closing) passed++;
    }
    cars.sort((a, b) => a[0] - b[0]);
    const off = s >= RADAR_OFF[0] && s < RADAR_OFF[1];
    const ranges = Array.from({ length: 8 }, (_, i) => off ? -1 : cars[i] ? cars[i][0] : 0);
    const speeds = Array.from({ length: 8 }, (_, i) => off ? null : cars[i] ? cars[i][1] : 0);

    const alt = altAt(d);
    if (alt > lastAlt) ascent += alt - lastAlt; else descent += lastAlt - alt;
    lastAlt = alt;
    const [lat, lon] = posAt(d);
    data(5, [t, Math.round(lat * SEMI), Math.round(lon * SEMI), Math.round(d * 100), Math.round(v * 1000),
        Math.round((alt + 500) * 5), p, Math.round(hr), cadence],
    [[T.sint16, ranges], [T.uint8, speeds], [T.uint16, passed]]);
    if (s % 60 === 0) data(6, [t, 87 - Math.floor(s / 300)]);

    d += v;
    timerS++;
    if (d >= lap * LOOP_M && lap === 1) {
        data(7, [t, lapStart, (timerS - lapStartTimer) * 1000, Math.round((d - lapStartD) * 100)]);
        lapStart = t + 1; lapStartTimer = timerS; lapStartD = d; lap++;
    }
}
const END = START + RIDE_S + PAUSE_S - 1;
data(4, [END, 0, 4, null]);
data(7, [END, lapStart, (timerS - lapStartTimer) * 1000, Math.round((d - lapStartD) * 100)]);
define(8, 18, [[253, T.uint32], [2, T.uint32], [5, T.enum], [6, T.enum], [7, T.uint32], [8, T.uint32],
    [9, T.uint32], [22, T.uint16], [23, T.uint16]]); // session
data(8, [END, START, 2, 7, (RIDE_S + PAUSE_S) * 1000, timerS * 1000, Math.round(d * 100), Math.round(ascent), Math.round(descent)]);
define(9, 34, [[253, T.uint32], [5, T.uint32], [1, T.uint16]]); // activity
data(9, [END, END + LOCAL_OFFSET, 1]);

function gearData() {
    // Garmin numbers the gears from the easiest: rear 1 = largest cog, front 1 = small ring
    return (COGS.length - rear) | (COGS[rear] << 8) | ((front === 0 ? 2 : 1) << 16) | (CHAINRINGS[front] << 24);
}

// ------------------------------------------------------------- header + CRC

const body = Buffer.concat(chunks);
const header = Buffer.alloc(14);
header[0] = 14; header[1] = 0x20; header.writeUInt16LE(2132, 2); header.writeUInt32LE(body.length, 4);
header.write('.FIT', 8, 'ascii');
header.writeUInt16LE(crc16(header.subarray(0, 12)), 12);
const file = Buffer.concat([header, body]);
const crc = Buffer.alloc(2); crc.writeUInt16LE(crc16(file));
writeFileSync(OUT, Buffer.concat([file, crc]));
console.log(`Wrote ${OUT}: ${(d / 1000).toFixed(1)} km, ${Math.round(ascent)} m up, ${passed} cars passed`);
