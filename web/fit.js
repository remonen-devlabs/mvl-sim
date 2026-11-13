// Minimal FIT decoder: all messages, with developer fields resolved by field_name.
// Returns { messages: [{num, fields: {fieldNum: value}, dev: {name: value}}] } in file order.
// Values are raw (no scale/offset); invalid values become null. Arrays stay arrays.

const BASE = {
    0x00: { size: 1, get: (v, o) => v.getUint8(o), invalid: 0xFF },          // enum
    0x01: { size: 1, get: (v, o) => v.getInt8(o), invalid: 0x7F },           // sint8
    0x02: { size: 1, get: (v, o) => v.getUint8(o), invalid: 0xFF },          // uint8
    0x83: { size: 2, get: (v, o, le) => v.getInt16(o, le), invalid: 0x7FFF },
    0x84: { size: 2, get: (v, o, le) => v.getUint16(o, le), invalid: 0xFFFF },
    0x85: { size: 4, get: (v, o, le) => v.getInt32(o, le), invalid: 0x7FFFFFFF },
    0x86: { size: 4, get: (v, o, le) => v.getUint32(o, le), invalid: 0xFFFFFFFF },
    0x07: { size: 1, string: true },
    0x88: { size: 4, get: (v, o, le) => v.getFloat32(o, le), invalid: null },
    0x89: { size: 8, get: (v, o, le) => v.getFloat64(o, le), invalid: null },
    0x0A: { size: 1, get: (v, o) => v.getUint8(o), invalid: 0x00 },          // uint8z
    0x8B: { size: 2, get: (v, o, le) => v.getUint16(o, le), invalid: 0x0000 },
    0x8C: { size: 4, get: (v, o, le) => v.getUint32(o, le), invalid: 0x00000000 },
    0x0D: { size: 1, get: (v, o) => v.getUint8(o), invalid: null },          // byte
    0x8E: { size: 8, get: (v, o, le) => Number(v.getBigInt64(o, le)), invalid: null },
    0x8F: { size: 8, get: (v, o, le) => Number(v.getBigUint64(o, le)), invalid: null },
    0x90: { size: 8, get: (v, o, le) => Number(v.getBigUint64(o, le)), invalid: null },
};

function readValue(view, off, size, baseType, le) {
    const bt = BASE[baseType] || BASE[baseType & 0x9F] || BASE[0x0D];
    if (bt.string) {
        let s = '';
        for (let i = 0; i < size; i++) {
            const c = view.getUint8(off + i);
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        try { s = decodeURIComponent(escape(s)); } catch (e) { /* keep latin-1 */ }
        return s.length ? s : null;
    }
    const n = Math.floor(size / bt.size);
    if (n <= 0) return null;
    const vals = [];
    for (let i = 0; i < n; i++) {
        const x = bt.get(view, off + i * bt.size, le);
        vals.push(bt.invalid !== null && x === bt.invalid ? null : x);
    }
    if (n === 1) return vals[0];
    return vals;
}

export function decodeFit(buffer) {
    const view = new DataView(buffer);
    const headerSize = view.getUint8(0);
    const sig = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (sig !== '.FIT') throw new Error('Not a FIT file');
    const dataSize = view.getUint32(4, true);
    const end = headerSize + dataSize;
    let off = headerSize;
    const defs = {};
    const devFieldDefs = {}; // `${devIndex}:${fieldNum}` -> {name, baseType}
    const messages = [];
    let lastTimestamp = 0;

    while (off < end) {
        const header = view.getUint8(off++);
        if (header & 0x80) {
            // Compressed timestamp header
            const local = (header >> 5) & 0x03;
            const tOff = header & 0x1F;
            let ts = (lastTimestamp & ~0x1F) + tOff;
            if (tOff < (lastTimestamp & 0x1F)) ts += 0x20;
            lastTimestamp = ts;
            const msg = readData(defs[local]);
            msg.fields[253] = ts;
            messages.push(msg);
            continue;
        }
        const local = header & 0x0F;
        if (header & 0x40) {
            // Definition
            off++; // reserved
            const le = view.getUint8(off++) === 0;
            const num = view.getUint16(off, le); off += 2;
            const nFields = view.getUint8(off++);
            const fields = [];
            for (let i = 0; i < nFields; i++) {
                fields.push({ num: view.getUint8(off), size: view.getUint8(off + 1), type: view.getUint8(off + 2) });
                off += 3;
            }
            const devFields = [];
            if (header & 0x20) {
                const nDev = view.getUint8(off++);
                for (let i = 0; i < nDev; i++) {
                    devFields.push({ num: view.getUint8(off), size: view.getUint8(off + 1), dev: view.getUint8(off + 2) });
                    off += 3;
                }
            }
            defs[local] = { le, num, fields, devFields };
        } else {
            const msg = readData(defs[local]);
            if (msg.fields[253] != null) lastTimestamp = msg.fields[253];
            messages.push(msg);
            if (msg.num === 206) {
                // field_description: dev index 0, field num 1, base type 2, name 3
                const f = msg.fields;
                devFieldDefs[`${f[0]}:${f[1]}`] = { name: f[3], baseType: f[2] };
            }
        }
    }
    return { messages };

    function readData(def) {
        if (!def) throw new Error('FIT data message without definition at byte ' + off);
        const msg = { num: def.num, fields: {}, dev: {} };
        for (const f of def.fields) {
            msg.fields[f.num] = readValue(view, off, f.size, f.type, def.le);
            off += f.size;
        }
        for (const d of def.devFields) {
            const dd = devFieldDefs[`${d.dev}:${d.num}`];
            if (dd) {
                let v = readValue(view, off, d.size, dd.baseType, def.le);
                if (v !== null && !Array.isArray(v) && d.size > (BASE[dd.baseType] || BASE[0x0D]).size) v = [v];
                msg.dev[dd.name] = v;
            }
            off += d.size;
        }
        return msg;
    }
}
