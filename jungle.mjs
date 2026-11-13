// Jungle files, evaluated the way monkeyc does it: the SDK's default.jungle first, then the
// project's jungle(s). Values are lazy: `edge1050 = $(rectangle-480x800)` makes edge1050 inherit
// every property of rectangle-480x800, and `$(key)` inside key's own assignment means the value
// before that assignment. So a project's `base.sourcePath = src` reaches every device.

export class Jungle {
    constructor() {
        this.assigns = new Map(); // key -> [expression text, ...] in order
        this.parents = new Map(); // qualifier -> [parent qualifier, ...] (later wins)
    }

    add(text) {
        for (const raw of text.split(/\r?\n/)) {
            const line = stripComment(raw).trim();
            if (!line) continue;
            const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
            if (!m) continue;
            const [, key, value] = m;
            const v = value.trim();
            // A bare qualifier set to another qualifier: inheritance
            const alias = /^\$\(([\w-]+)\)$/.exec(v);
            if (!key.includes('.') && alias) {
                (this.parents.get(key) || this.parents.set(key, []).get(key)).push(alias[1]);
                continue;
            }
            (this.assigns.get(key) || this.assigns.set(key, []).get(key)).push(v);
        }
        return this;
    }

    // Final value of key (string) or undefined
    get(key) { return this.valueAt(key, Infinity, new Set()); }

    valueAt(key, upto, stack) {
        const list = this.assigns.get(key);
        const n = list ? Math.min(list.length, upto) : 0;
        if (n > 0) {
            const tag = key + '#' + n;
            if (stack.has(tag)) throw new Error(`jungle: circular reference at ${key}`);
            stack.add(tag);
            const expr = list[n - 1];
            const out = expr.replace(/\$\(([\w.-]+)\)/g, (_, ref) => {
                const v = ref === key ? this.valueAt(key, n - 1, stack) : this.valueAt(ref, Infinity, stack);
                return v ?? '';
            });
            stack.delete(tag);
            return out;
        }
        // Inherited through the qualifier chain
        const dot = key.indexOf('.');
        if (dot < 0) return undefined;
        const q = key.slice(0, dot), prop = key.slice(dot + 1);
        const ps = this.parents.get(q);
        if (!ps) return undefined;
        return this.valueAt(ps[ps.length - 1] + '.' + prop, Infinity, stack);
    }

    // ';'-separated list, quotes stripped, empty entries dropped
    list(key) {
        const v = this.get(key);
        if (v == null) return [];
        return v.split(';').map(s => s.trim().replace(/^"(.*)"$/, '$1').trim()).filter(Boolean);
    }

    hasQualifier(q) { return this.parents.has(q); }
}

function stripComment(line) {
    // '#' starts a comment outside quotes
    let q = false;
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') q = !q;
        else if (line[i] === '#' && !q) return line.slice(0, i);
    }
    return line;
}

// For a device the SDK's default.jungle does not know yet (newer device files than the SDK),
// add the chain from its compiler.json: device -> family (e.g. round-454x454) -> shape -> base.
export function ensureDeviceChain(jungle, device, family) {
    if (jungle.hasQualifier(device)) return;
    let text = '';
    if (family) {
        const shape = family.split('-')[0];
        if (!jungle.hasQualifier(shape)) text += `${shape} = $(base)\n${shape}.resourcePath = $(${shape}.resourcePath);resources-${shape}\n`;
        if (!jungle.hasQualifier(family)) text += `${family} = $(${shape})\n${family}.resourcePath = $(${family}.resourcePath);resources-${family}\n`;
        text += `${device} = $(${family})\n`;
    } else text += `${device} = $(base)\n`;
    text += `${device}.resourcePath = $(${device}.resourcePath);resources-${device}\n`;
    jungle.add(text);
}
