// Runtime for translated Monkey C: value helpers ($) and a Toybox stand-in (T).
// Number = JS integer (wrapped to 32 bits), Long = L (BigInt wrapped to 64 bits),
// Float = F (rounded to 32-bit), Double = D, Char = Char, ByteArray = Bytes.
// createRuntime(env) gives a fresh, isolated set per session.

export class MonkeyError extends Error {
    constructor(kind, msg) { super(`${kind}: ${msg}`); this.kind = kind; }
}

export class F { constructor(v) { this.v = Math.fround(v); } }
export class D extends F { constructor(v) { super(0); this.v = v; } }
export class L { constructor(v) { this.v = BigInt.asIntN(64, BigInt(v)); } }
class Sym { constructor(name) { this.name = name; } toString() { return 'symbol:' + this.name; } }
export class Char { constructor(c) { this.c = c; } get code() { return this.c.codePointAt(0); } }
export class Bytes {
    constructor(arr) { this.a = arr; } // plain array of 0..255
}

const symbols = new Map();
function sym(name) {
    let s = symbols.get(name);
    if (!s) { s = new Sym(name); symbols.set(name, s); }
    return s;
}

const isInt = (x) => typeof x === 'number';
const isNum = (x) => typeof x === 'number' || x instanceof F || x instanceof L;
function num(x, op) {
    if (typeof x === 'number') return x;
    if (x instanceof F) return x.v;
    if (x instanceof L) return Number(x.v);
    throw new MonkeyError('Unexpected Type Error', `${op}: expected a number, got ${typeName(x)}`);
}
const big = (x) => x instanceof L ? x.v : BigInt(Math.trunc(num(x)));
function typeName(x) {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'number') return 'Number';
    if (x instanceof L) return 'Long';
    if (x instanceof D) return 'Double';
    if (x instanceof F) return 'Float';
    if (typeof x === 'string') return 'String';
    if (typeof x === 'boolean') return 'Boolean';
    if (Array.isArray(x)) return 'Array';
    if (x instanceof Bytes) return 'ByteArray';
    if (x instanceof Char) return 'Char';
    if (x instanceof MDict) return 'Dictionary';
    if (x instanceof Sym) return 'Symbol';
    return x.$className || x.constructor?.name || 'Object';
}
// Type promotion: Number < Long < Float < Double. (Long with Float gives Float here; not verified on a device.)
function mkFloat(a, b, v) { return (a instanceof D || b instanceof D) ? new D(v) : new F(v); }
const anyFloat = (a, b) => a instanceof F || b instanceof F;
const anyLong = (a, b) => a instanceof L || b instanceof L;

export class MDict {
    constructor(entries) { this.map = new Map(); if (entries) for (const [k, v] of entries) this.put(k, v); }
    static key(k) {
        if (typeof k === 'number') return 'n' + k;
        if (k instanceof L) return 'n' + k.v;
        if (k instanceof F) return 'n' + k.v;
        if (typeof k === 'string') return 's' + k;
        if (k instanceof Char) return 'c' + k.c;
        return k;
    }
    put(k, v) { this.map.set(MDict.key(k), [k, v]); return null; }
    get(k) { const e = this.map.get(MDict.key(k)); return e ? e[1] : null; }
    hasKey(k) { return this.map.has(MDict.key(k)); }
    remove(k) { this.map.delete(MDict.key(k)); return null; }
    keys() { return [...this.map.values()].map(e => e[0]); }
    values() { return [...this.map.values()].map(e => e[1]); }
    size() { return this.map.size; }
    isEmpty() { return this.map.size === 0; }
    toString() { return str(this); }
    equals(o) { return this === o; }
}

function str(x) {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'string') return x;
    if (typeof x === 'number') return String(x);
    if (x instanceof L) return String(x.v);
    if (x instanceof F) return x.v.toFixed(6);
    if (typeof x === 'boolean') return String(x);
    if (Array.isArray(x)) return '[' + x.map(str).join(', ') + ']';
    if (x instanceof Bytes) return '[' + x.a.join(', ') + ']';
    if (x instanceof MDict) return '{' + [...x.map.values()].map(([k, v]) => str(k) + '=>' + str(v)).join(', ') + '}';
    if (x instanceof Sym) return 'symbol';
    if (x instanceof Char) return x.c;
    if (typeof x.toString === 'function' && x.toString !== Object.prototype.toString) return x.toString();
    return 'Obj: ' + typeName(x);
}

// C-style format: %[-0+ ]*[width][.prec](d|i|u|f|e|x|X|s|c|%)
function format(fmt, ...args) {
    let ai = 0;
    return fmt.replace(/%([-0+ ]*)(\d*)(?:\.(\d+))?(l?)([diufeExXsc%])/g, (m, flags, width, prec, lmod, conv) => {
        if (conv === '%') return '%';
        const a = args[ai++];
        let s;
        switch (conv) {
            case 'd': case 'i': case 'u': {
                let v = a instanceof L ? a.v : a instanceof F ? BigInt(Math.trunc(a.v)) : BigInt(num(a, 'format'));
                if (!(a instanceof L) && !lmod) v = BigInt.asIntN(32, v);
                if (conv === 'u' && v < 0n) v = BigInt.asUintN(a instanceof L || lmod ? 64 : 32, v);
                s = String(v < 0n ? -v : v);
                if (v < 0n) s = '-' + s; else if (flags.includes('+')) s = '+' + s;
                break;
            }
            case 'f': {
                const v = num(a, 'format');
                const p = prec === undefined ? 6 : +prec;
                s = v.toFixed(p);
                // An exact tie rounds to even, as on the device: (2.5).format("%.0f") = "2", (0.25) "%.1f" = "0.2"
                const scaled = Math.abs(v) * 10 ** p;
                if (!Number.isInteger(scaled) && Number.isInteger(scaled * 2)) {
                    const down = Math.floor(scaled);
                    const r = (down % 2 === 0 ? down : down + 1) / 10 ** p;
                    s = (v < 0 ? '-' : '') + r.toFixed(p);
                }
                if (flags.includes('+') && v >= 0) s = '+' + s;
                break;
            }
            case 'e': case 'E': {
                s = num(a, 'format').toExponential(prec === undefined ? 6 : +prec).replace(/e([+-])(\d)$/, 'e$10$2');
                if (conv === 'E') s = s.toUpperCase();
                break;
            }
            case 'x': case 'X': {
                const v = a instanceof L ? BigInt.asUintN(64, a.v) : BigInt(a instanceof F ? Math.trunc(a.v) : num(a, 'format') >>> 0);
                s = v.toString(16);
                if (conv === 'X') s = s.toUpperCase();
                break;
            }
            case 's': s = str(a); break;
            case 'c': s = typeof a === 'number' ? String.fromCodePoint(a) : str(a); break;
        }
        if (prec !== undefined && (conv === 'd' || conv === 'i' || conv === 'u' || conv === 'x' || conv === 'X')) {
            const neg = s.startsWith('-');
            let digits = neg ? s.slice(1) : s;
            while (digits.length < +prec) digits = '0' + digits;
            s = (neg ? '-' : '') + digits;
        }
        const w = width ? +width : 0;
        if (s.length < w) {
            if (flags.includes('-')) s = s.padEnd(w);
            else if (flags.includes('0') && conv !== 's') {
                const neg = s.startsWith('-') || s.startsWith('+');
                s = neg ? s[0] + s.slice(1).padStart(w - 1, '0') : s.padStart(w, '0');
            } else s = s.padStart(w);
        }
        return s;
    });
}

// Lang.format("$1$ km", [x])
function langFormat(fmt, args) {
    return str(fmt).replace(/\$(\d+)\$/g, (m, n) => { const i = +n - 1; return args && i < args.length ? str(args[i]) : m; });
}

// ------------------------------------------------------------- value helpers ($)

function intOp(a, b, op, opName) {
    // Number op Number -> Number (32-bit wrap); with a Long -> Long (64-bit wrap); with a Float -> Float
    if (typeof a === 'number' && typeof b === 'number') return op.n(a, b);
    if (isNum(a) && isNum(b)) {
        if (anyFloat(a, b)) return mkFloat(a, b, op.f(num(a), num(b)));
        return new L(op.l(big(a), big(b)));
    }
    throw new MonkeyError('Unexpected Type Error', `${typeName(a)} ${opName} ${typeName(b)}`);
}
const OPS = {
    add: { n: (a, b) => (a + b) | 0, l: (a, b) => a + b, f: (a, b) => a + b },
    sub: { n: (a, b) => (a - b) | 0, l: (a, b) => a - b, f: (a, b) => a - b },
    mul: { n: (a, b) => Math.imul(a, b), l: (a, b) => a * b, f: (a, b) => a * b },
};
function bitOp(a, b, n, l, name) {
    if (typeof a === 'number' && typeof b === 'number') return n(a, b);
    if ((a instanceof L || isInt(a)) && (b instanceof L || isInt(b))) return new L(l(big(a), big(b)));
    throw new MonkeyError('Unexpected Type Error', `${typeName(a)} ${name} ${typeName(b)}`);
}

function makeHelpers() {
    const $ = {
        L: '', // current source line, for error messages
        F, D, MDict, Long: L, Char, Bytes,
        f: (v) => new F(v),
        d: (v) => new D(v),
        long: (v) => new L(v),
        sym,
        ch: (c) => new Char(c),
        str,
        b(x) {
            if (x === true || x === false) return x;
            if (x === null || x === undefined) return false;
            if (typeof x === 'number') return x !== 0;
            if (x instanceof L) return x.v !== 0n;
            if (x instanceof F) return x.v !== 0;
            return true;
        },
        nn(x) { if (x === null || x === undefined) throw new MonkeyError('Unexpected Type Error', 'member access on null'); return x; },
        add(a, b) {
            if (typeof a === 'number' && typeof b === 'number') return (a + b) | 0;
            if (typeof a === 'string' || typeof b === 'string') {
                if (a === undefined || b === undefined) throw new MonkeyError('Unexpected Type Error', '+ with undefined');
                return str(a) + str(b);
            }
            if (a instanceof Char && isInt(b)) return new Char(String.fromCodePoint(a.code + b));
            if (a instanceof Bytes) {
                if (b instanceof Bytes) return new Bytes(a.a.concat(b.a));
                if (isInt(b)) return new Bytes(a.a.concat([b & 0xFF]));
            }
            if (Array.isArray(a)) throw new MonkeyError('Unexpected Type Error', 'Array + ...: use add() or addAll()');
            return intOp(a, b, OPS.add, '+');
        },
        sub(a, b) {
            if (typeof a === 'number' && typeof b === 'number') return (a - b) | 0;
            if (a instanceof Char && isInt(b)) return new Char(String.fromCodePoint(a.code - b));
            if (a instanceof Char && b instanceof Char) return a.code - b.code;
            return intOp(a, b, OPS.sub, '-');
        },
        mul(a, b) { return intOp(a, b, OPS.mul, '*'); },
        div(a, b) {
            if (typeof a === 'number' && typeof b === 'number') {
                if (b === 0) throw new MonkeyError('Unhandled Exception', 'Division by zero');
                return (a / b) | 0;
            }
            if (isNum(a) && isNum(b) && !anyFloat(a, b)) {
                if (big(b) === 0n) throw new MonkeyError('Unhandled Exception', 'Division by zero');
                return new L(big(a) / big(b));
            }
            return mkFloat(a, b, num(a, '/') / num(b, '/'));
        },
        mod(a, b) {
            if (typeof a === 'number' && typeof b === 'number') {
                if (b === 0) throw new MonkeyError('Unhandled Exception', 'Modulo by zero');
                return (a % b) | 0;
            }
            if (isNum(a) && isNum(b) && !anyFloat(a, b)) {
                if (big(b) === 0n) throw new MonkeyError('Unhandled Exception', 'Modulo by zero');
                return new L(big(a) % big(b));
            }
            return mkFloat(a, b, num(a, '%') % num(b, '%'));
        },
        neg(a) {
            if (typeof a === 'number') return (-a) | 0;
            if (a instanceof L) return new L(-a.v);
            return a instanceof D ? new D(-a.v) : new F(-num(a, '-'));
        },
        not(a) {
            if (a === true || a === false) return !a;
            if (typeof a === 'number') return ~a;
            if (a instanceof L) return new L(~a.v);
            throw new MonkeyError('Unexpected Type Error', `!${typeName(a)}`);
        },
        bnot(a) { return a instanceof L ? new L(~a.v) : ~num(a, '~'); },
        band(a, b) { if (typeof a === 'boolean') return a && b; return bitOp(a, b, (x, y) => x & y, (x, y) => x & y, '&'); },
        bor(a, b) { if (typeof a === 'boolean') return a || b; return bitOp(a, b, (x, y) => x | y, (x, y) => x | y, '|'); },
        bxor(a, b) { if (typeof a === 'boolean') return a !== b; return bitOp(a, b, (x, y) => x ^ y, (x, y) => x ^ y, '^'); },
        shl(a, b) {
            if (a instanceof L) return new L(a.v << (big(b) & 63n));
            return num(a, '<<') << num(b, '<<');
        },
        shr(a, b) {
            if (a instanceof L) return new L(a.v >> (big(b) & 63n));
            return num(a, '>>') >> num(b, '>>');
        },
        eq(a, b) {
            if (a === b) return true;
            if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
            if (isNum(a) && isNum(b)) {
                if (a instanceof L && b instanceof L) return a.v === b.v;
                if ((a instanceof L || isInt(a)) && (b instanceof L || isInt(b))) return big(a) === big(b);
                return num(a) === num(b);
            }
            if (a instanceof Char && b instanceof Char) return a.c === b.c;
            return false;
        },
        ne(a, b) { return !$.eq(a, b); },
        lt(a, b) { return cmp(a, b, '<') < 0; },
        gt(a, b) { return cmp(a, b, '>') > 0; },
        le(a, b) { return cmp(a, b, '<=') <= 0; },
        ge(a, b) { return cmp(a, b, '>=') >= 0; },
        io(x, type) {
            if (x === null || x === undefined) return false;
            if (typeof type === 'string') {
                switch (type) {
                    case 'Number': return typeof x === 'number';
                    case 'Long': return x instanceof L;
                    case 'Float': return x instanceof F && !(x instanceof D);
                    case 'Double': return x instanceof D;
                    case 'String': return typeof x === 'string';
                    case 'Boolean': return typeof x === 'boolean';
                    case 'Array': return Array.isArray(x);
                    case 'ByteArray': return x instanceof Bytes;
                    case 'Dictionary': return x instanceof MDict;
                    case 'Symbol': return x instanceof Sym;
                    case 'Char': return x instanceof Char;
                    case 'Object': return true;
                    case 'Method': return x instanceof MethodRef;
                    case 'Exception': return !!$.Exception && x instanceof $.Exception;
                    default: return false;
                }
            }
            return x instanceof type;
        },
        has(o, name) {
            if (o === null || o === undefined) return false;
            if (typeof o === 'object' || typeof o === 'function') return name in o && o[name] !== undefined;
            return false;
        },
        g(o, name) {
            if (o === null || o === undefined) throw new MonkeyError('Unexpected Type Error', `reading .${name} of null`);
            let v = o[name];
            // Class constants read through an instance
            if (v === undefined && typeof o === 'object' && o.constructor && name in o.constructor) v = o.constructor[name];
            if (v === undefined) throw new MonkeyError('Symbol Not Found Error', `.${name} on ${typeName(o)}`);
            return v;
        },
        idx(o, i) {
            if (Array.isArray(o) || o instanceof Bytes) {
                const a = Array.isArray(o) ? o : o.a;
                const k = num(i, '[]');
                if (k < 0 || k >= a.length || !Number.isInteger(k)) throw new MonkeyError('Array Out Of Bounds Error', `index ${k}, size ${a.length}`);
                return a[k];
            }
            if (o instanceof MDict) return o.get(i);
            throw new MonkeyError('Unexpected Type Error', `indexing ${typeName(o)}`);
        },
        setidx(o, i, v) {
            if (Array.isArray(o) || o instanceof Bytes) {
                const a = Array.isArray(o) ? o : o.a;
                const k = num(i, '[]');
                if (k < 0 || k >= a.length || !Number.isInteger(k)) throw new MonkeyError('Array Out Of Bounds Error', `index ${k}, size ${a.length}`);
                if (o instanceof Bytes) {
                    if (!isInt(v) && !(v instanceof L)) throw new MonkeyError('Unexpected Type Error', `ByteArray value ${typeName(v)}`);
                    a[k] = Number(big(v) & 0xFFn); return v;
                }
                a[k] = v; return v;
            }
            if (o instanceof MDict) { o.put(i, v); return v; }
            throw new MonkeyError('Unexpected Type Error', `indexing ${typeName(o)}`);
        },
        newarr(n) { return new Array(num(n, 'new []')).fill(null); },
        newbytes(n) { return new Bytes(new Array(num(n, 'new []b')).fill(0)); },
        bytes(items) { return new Bytes(items.map(x => Number(big(x) & 0xFFn))); },
        dict(entries) { return new MDict(entries); },
        new_(cls, args) {
            if (typeof cls !== 'function') throw new MonkeyError('Unexpected Type Error', 'new on a non-class');
            if (cls.$native) return cls.$native(...args);
            const o = Object.create(cls.prototype);
            o.$initFields();
            o.initialize(...args);
            return o;
        },
        callv(f, args) {
            if (f instanceof MethodRef) return f.invoke(...args);
            if (typeof f === 'function') return f(...args);
            throw new MonkeyError('Unexpected Type Error', 'calling a non-function');
        },
        // A JS-side exception reaching a Monkey C catch: only Monkey C exception objects are catchable
        caught(ex) {
            if ($.Exception && ex instanceof $.Exception) return ex;
            throw ex;
        },
        m(o, name, args) {
            if (o === null || o === undefined) throw new MonkeyError('Unexpected Type Error', `calling .${name}() on null`);
            if (typeof o === 'number') return intMethod(o, name, args);
            if (o instanceof L) return longMethod(o, name, args);
            if (o instanceof F) return floatMethod(o, name, args);
            if (typeof o === 'string') return stringMethod(o, name, args);
            if (Array.isArray(o)) return arrayMethod(o, name, args);
            if (o instanceof Bytes) return bytesMethod(o, name, args);
            if (o instanceof Char) return charMethod(o, name, args);
            if (typeof o === 'boolean') {
                if (name === 'toString') return String(o);
                if (name === 'equals') return o === args[0];
                if (name === 'hashCode') return o ? 1 : 0;
            }
            if (o instanceof Sym) {
                if (name === 'toString') return 'symbol';
                if (name === 'equals') return o === args[0];
            }
            const fn = o[name];
            if (typeof fn !== 'function') throw new MonkeyError('Symbol Not Found Error', `.${name}() on ${typeName(o)}`);
            return fn.apply(o, args);
        },
    };
    function cmp(a, b, op) {
        if ((a instanceof L || isInt(a)) && (b instanceof L || isInt(b)) && (a instanceof L || b instanceof L)) {
            const x = big(a), y = big(b); return x < y ? -1 : x > y ? 1 : 0;
        }
        if (a instanceof Char && b instanceof Char) return a.code - b.code;
        const x = num(a, op), y = num(b, op);
        return x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN;
    }
    return $;
}

function intMethod(o, name, args) {
    switch (name) {
        case 'format': return format(args[0], o);
        case 'toNumber': return o;
        case 'toLong': return new L(o);
        case 'toFloat': return new F(o);
        case 'toDouble': return new D(o);
        case 'toString': return String(o);
        case 'abs': return Math.abs(o) | 0;
        case 'toChar': return new Char(String.fromCodePoint(o));
        case 'equals': return isNum(args[0]) && num(args[0]) === o;
        case 'hashCode': return o;
        case 'compareTo': return Math.sign(o - num(args[0]));
    }
    throw new MonkeyError('Symbol Not Found Error', `Number.${name}()`);
}
function longMethod(o, name, args) {
    switch (name) {
        case 'format': return format(args[0], o);
        case 'toNumber': return Number(BigInt.asIntN(32, o.v));
        case 'toLong': return o;
        case 'toFloat': return new F(Number(o.v));
        case 'toDouble': return new D(Number(o.v));
        case 'toString': return String(o.v);
        case 'abs': return new L(o.v < 0n ? -o.v : o.v);
        case 'toChar': return new Char(String.fromCodePoint(Number(o.v)));
        case 'equals': return isNum(args[0]) && !(args[0] instanceof F) && big(args[0]) === o.v;
        case 'hashCode': return Number(BigInt.asIntN(32, o.v ^ (o.v >> 32n)));
        case 'compareTo': { const y = big(args[0]); return o.v < y ? -1 : o.v > y ? 1 : 0; }
    }
    throw new MonkeyError('Symbol Not Found Error', `Long.${name}()`);
}
function floatMethod(o, name, args) {
    switch (name) {
        case 'format': return format(args[0], o);
        case 'toNumber': return Math.trunc(o.v) | 0;
        case 'toLong': return new L(Number.isFinite(o.v) ? Math.trunc(o.v) : 0);
        case 'toFloat': return new F(o.v);
        case 'toDouble': return new D(o.v);
        case 'toString': return o.v.toFixed(6);
        case 'abs': return o instanceof D ? new D(Math.abs(o.v)) : new F(Math.abs(o.v));
        case 'equals': return isNum(args[0]) && num(args[0]) === o.v;
        case 'compareTo': return Math.sign(o.v - num(args[0]));
        case 'hashCode': return Math.trunc(o.v) | 0;
    }
    throw new MonkeyError('Symbol Not Found Error', `${typeName(o)}.${name}()`);
}
function charMethod(o, name, args) {
    switch (name) {
        case 'toNumber': return o.code;
        case 'toLong': return new L(o.code);
        case 'toString': return o.c;
        case 'toUpper': return new Char(o.c.toUpperCase());
        case 'toLower': return new Char(o.c.toLowerCase());
        case 'equals': return args[0] instanceof Char && args[0].c === o.c;
        case 'hashCode': return o.code;
        case 'compareTo': return o.code - (args[0] instanceof Char ? args[0].code : num(args[0]));
    }
    throw new MonkeyError('Symbol Not Found Error', `Char.${name}()`);
}
function stringMethod(o, name, args) {
    switch (name) {
        case 'length': return o.length;
        case 'substring': {
            const a = args[0] == null ? 0 : num(args[0]), b = args[1] == null ? o.length : num(args[1]);
            if (a < 0 || b > o.length || a > b) return null;
            return o.substring(a, b);
        }
        case 'find': { const i = o.indexOf(str(args[0])); return i < 0 ? null : i; }
        case 'toUpper': return o.toUpperCase();
        case 'toLower': return o.toLowerCase();
        case 'toNumber': { const m = /^\s*[-+]?\d+/.exec(o); return m ? parseInt(m[0], 10) | 0 : null; }
        case 'toLong': { const m = /^\s*[-+]?\d+/.exec(o); return m ? new L(BigInt(m[0].trim())) : null; }
        case 'toFloat': { const v = parseFloat(o); return isNaN(v) ? null : new F(v); }
        case 'toDouble': { const v = parseFloat(o); return isNaN(v) ? null : new D(v); }
        case 'toNumberWithBase': { const v = parseInt(o, num(args[0])); return isNaN(v) ? null : v | 0; }
        case 'toCharArray': return [...o].map(c => new Char(c));
        case 'toUtf8Array': return [...new TextEncoder().encode(o)];
        case 'equals': return o === args[0];
        case 'toString': return o;
        case 'hashCode': { let h = 0; for (const c of o) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0; return h; }
        case 'compareTo': return o < str(args[0]) ? -1 : o > str(args[0]) ? 1 : 0;
    }
    throw new MonkeyError('Symbol Not Found Error', `String.${name}()`);
}
const $eqLoose = (a, b) => a === b || (isNum(a) && isNum(b) && num(a) === num(b)) || (a instanceof Char && b instanceof Char && a.c === b.c);
function arrayMethod(o, name, args) {
    switch (name) {
        case 'size': return o.length;
        case 'add': o.push(args[0]); return o;
        case 'addAll': o.push(...(args[0] instanceof Bytes ? args[0].a : args[0])); return o;
        case 'remove': { const i = o.findIndex(x => $eqLoose(x, args[0])); if (i < 0) return false; o.splice(i, 1); return true; }
        case 'removeAll': { let r = false; for (let i = o.length - 1; i >= 0; i--) if ($eqLoose(o[i], args[0])) { o.splice(i, 1); r = true; } return r; }
        case 'indexOf': return o.findIndex(x => $eqLoose(x, args[0]));
        case 'slice': {
            let a = args[0] == null ? 0 : num(args[0]), b = args[1] == null ? o.length : num(args[1]);
            return o.slice(a, b);
        }
        case 'reverse': return [...o].reverse();
        case 'toString': return str(o);
        case 'equals': return o === args[0];
        case 'hashCode': return 0;
    }
    throw new MonkeyError('Symbol Not Found Error', `Array.${name}()`);
}
// Lang.NUMBER_FORMAT_* and ENDIAN_* values used by ByteArray.encodeNumber / decodeNumber
const NUMBER_FORMATS = { 1: [1, 'Int8'], 2: [1, 'Uint8'], 3: [2, 'Int16'], 4: [2, 'Uint16'], 5: [4, 'Int32'], 6: [4, 'Uint32'], 7: [4, 'Float32'], 8: [8, 'Float64'] };
function bytesMethod(o, name, args) {
    const a = o.a;
    switch (name) {
        case 'size': return a.length;
        case 'add': if (args[0] instanceof Bytes) a.push(...args[0].a); else a.push(Number(big(args[0]) & 0xFFn)); return o;
        case 'addAll': a.push(...(args[0] instanceof Bytes ? args[0].a : args[0].map(x => Number(big(x) & 0xFFn)))); return o;
        case 'indexOf': return a.indexOf(num(args[0]));
        case 'remove': { const i = a.indexOf(num(args[0])); if (i < 0) return false; a.splice(i, 1); return true; }
        case 'removeAll': { let r = false; for (let i = a.length - 1; i >= 0; i--) if (a[i] === num(args[0])) { a.splice(i, 1); r = true; } return r; }
        case 'slice': {
            const s = args[0] == null ? 0 : num(args[0]), e = args[1] == null ? a.length : num(args[1]);
            return new Bytes(a.slice(s, e));
        }
        case 'reverse': return new Bytes([...a].reverse());
        case 'toString': return str(o);
        case 'equals': return o === args[0];
        case 'hashCode': return 0;
        case 'encodeNumber': case 'decodeNumber': {
            const enc = name === 'encodeNumber';
            const value = enc ? args[0] : null, fmt = num(enc ? args[1] : args[0]), opts = enc ? args[2] : args[1];
            const nf = NUMBER_FORMATS[fmt];
            if (!nf) throw new MonkeyError('Invalid Value', `number format ${fmt}`);
            const off = opts ? num(opts.get(sym('offset')) ?? 0) : 0;
            const little = opts ? num(opts.get(sym('endianness')) ?? 1) === 0 : false; // ENDIAN_LITTLE = 0, ENDIAN_BIG = 1 (default)
            if (off < 0 || off + nf[0] > a.length) throw new MonkeyError('Value Out Of Bounds Error', `offset ${off}`);
            const dv = new DataView(new ArrayBuffer(8));
            if (enc) {
                const set = 'set' + nf[1];
                if (nf[1].startsWith('Float')) dv[set](0, num(value), little); else dv[set](0, Number(BigInt.asIntN(32, big(value))), little);
                for (let i = 0; i < nf[0]; i++) a[off + i] = dv.getUint8(i);
                return o;
            }
            for (let i = 0; i < nf[0]; i++) dv.setUint8(i, a[off + i]);
            const v = dv['get' + nf[1]](0, little);
            if (nf[1] === 'Float32') return new F(v);
            if (nf[1] === 'Float64') return new D(v);
            if (nf[1] === 'Uint32' && v > 0x7FFFFFFF) return new L(v);
            return v;
        }
    }
    throw new MonkeyError('Symbol Not Found Error', `ByteArray.${name}()`);
}

export class MethodRef {
    constructor(obj, name) { this.obj = obj; this.name = name; }
    invoke(...args) {
        const fn = this.obj[this.name];
        if (typeof fn !== 'function') throw new MonkeyError('Symbol Not Found Error', `method :${this.name}`);
        return fn.apply(this.obj, args);
    }
    equals(o) { return o instanceof MethodRef && o.obj === this.obj && o.name === this.name; }
}

// JSON resource / Storage values -> Monkey C values
export function fromJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : Number.isInteger(v) ? new L(v) : new F(v);
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map(fromJson);
    return new MDict(Object.entries(v).map(([k, x]) => [k, fromJson(x)]));
}

// ------------------------------------------------------------- Toybox

// env: { device, fonts (FontSet), now(), info(), sensor(), storage, properties, log(), fitWrite(), weather(), radar(),
//        userFtp(), profile(), clockOffset(), night(), field (current field location), images (Map url -> Image) }
export function createRuntime(env) {
    const $ = makeHelpers();

    class LangObject {
        $initFields() {}
        initialize() { return null; }
        method(s) { return new MethodRef(this, s.name); }
        equals(o) { return this === o; }
        hashCode() { return 0; }
        toString() { return 'Obj: ' + (this.$className || this.constructor.name || 'Object'); }
    }
    class Exception extends LangObject {
        initialize(msg) { this.mMessage = msg ?? null; return null; }
        getErrorMessage() { return this.mMessage; }
        printStackTrace() { env.log(`Exception: ${this.mMessage}`); return null; }
    }
    const exc = (name) => { const c = class extends Exception {}; Object.defineProperty(c, 'name', { value: name }); c.prototype.$className = name; return c; };
    const InvalidKeyException = exc('InvalidKeyException');
    $.Exception = Exception;
    $.LangObject = LangObject;

    const Lang = {
        Object: LangObject, Exception, InvalidKeyException,
        InvalidValueException: exc('InvalidValueException'), InvalidOptionsException: exc('InvalidOptionsException'),
        UnexpectedTypeException: exc('UnexpectedTypeException'), ValueOutOfBoundsException: exc('ValueOutOfBoundsException'),
        OperationNotAllowedException: exc('OperationNotAllowedException'), SerializationException: exc('SerializationException'),
        StorageFullException: exc('StorageFullException'), UnhandledException: exc('UnhandledException'),
        format: (fmt, args) => langFormat(fmt, args),
        NUMBER_FORMAT_SINT8: 1, NUMBER_FORMAT_UINT8: 2, NUMBER_FORMAT_SINT16: 3, NUMBER_FORMAT_UINT16: 4,
        NUMBER_FORMAT_SINT32: 5, NUMBER_FORMAT_UINT32: 6, NUMBER_FORMAT_FLOAT: 7, NUMBER_FORMAT_DOUBLE: 8,
        ENDIAN_LITTLE: 0, ENDIAN_BIG: 1,
        Method: MethodRef,
    };

    // ---------------- Graphics
    const Graphics = {
        COLOR_WHITE: 0xFFFFFF, COLOR_LT_GRAY: 0xAAAAAA, COLOR_DK_GRAY: 0x555555, COLOR_BLACK: 0x000000,
        COLOR_RED: 0xFF0000, COLOR_DK_RED: 0xAA0000, COLOR_ORANGE: 0xFF5500, COLOR_YELLOW: 0xFFAA00,
        COLOR_GREEN: 0x00FF00, COLOR_DK_GREEN: 0x00AA00, COLOR_BLUE: 0x00AAFF, COLOR_DK_BLUE: 0x0000FF,
        COLOR_PURPLE: 0xAA00FF, COLOR_PINK: 0xFF00FF, COLOR_TRANSPARENT: -1,
        FONT_XTINY: 0, FONT_TINY: 1, FONT_SMALL: 2, FONT_MEDIUM: 3, FONT_LARGE: 4, FONT_NUMBER_MILD: 5,
        FONT_NUMBER_MEDIUM: 6, FONT_NUMBER_HOT: 7, FONT_NUMBER_THAI_HOT: 8, FONT_SYSTEM_XTINY: 9,
        FONT_SYSTEM_TINY: 10, FONT_SYSTEM_SMALL: 11, FONT_SYSTEM_MEDIUM: 12, FONT_SYSTEM_LARGE: 13,
        FONT_SYSTEM_NUMBER_MILD: 14, FONT_SYSTEM_NUMBER_MEDIUM: 15, FONT_SYSTEM_NUMBER_HOT: 16, FONT_SYSTEM_NUMBER_THAI_HOT: 17,
        FONT_GLANCE: 18, FONT_GLANCE_NUMBER: 19, FONT_AUX1: 20, FONT_AUX2: 21,
        TEXT_JUSTIFY_RIGHT: 0, TEXT_JUSTIFY_CENTER: 1, TEXT_JUSTIFY_LEFT: 2, TEXT_JUSTIFY_VCENTER: 4,
        ARC_COUNTER_CLOCKWISE: 0, ARC_CLOCKWISE: 1,
        // Module-level font metrics (same values as the Dc methods)
        getFontHeight(font) { return env.fonts.get(font).height; },
        getFontAscent(font) { const f = env.fonts.get(font); return Math.round(f.ascent ?? f.base ?? f.height * 0.8); },
        getFontDescent(font) { const f = env.fonts.get(font); return f.height - Graphics.getFontAscent(font); },
        createColor: (a, r, g, b) => ((num(a) & 0xFF) === 0xFF ? 0 : ((num(a) & 0xFF) << 24)) | ((num(r) & 0xFF) << 16) | ((num(g) & 0xFF) << 8) | (num(b) & 0xFF),
        getVectorFont(opts) {
            const faces = opts.get(sym('face')), size = num(opts.get(sym('size')));
            const list = Array.isArray(faces) ? faces : [faces];
            for (const f of list) { const font = env.fonts.vector(str(f), size); if (font) return font; }
            return null;
        },
        fitTextToArea(text, font, w, h, truncate) {
            const f = env.fonts.get(font);
            const words = str(text).split(/\s+/);
            const lines = [];
            let cur = '';
            for (const wd of words) {
                const t = cur ? cur + ' ' + wd : wd;
                if (f.width(t) <= num(w) || !cur) cur = t; else { lines.push(cur); cur = wd; }
            }
            if (cur) lines.push(cur);
            const maxLines = Math.max(1, Math.floor(num(h) / f.height));
            if (lines.length > maxLines) { if (!truncate) return null; lines.length = maxLines; }
            return lines.join('\n');
        },
    };

    class Dc extends LangObject {
        // ctx: CanvasRenderingContext2D (or null to measure only); x0/y0: field location on the canvas
        constructor(ctx, x0, y0, w, h) {
            super();
            this.ctx = ctx; this.x0 = x0; this.y0 = y0; this.w = w; this.h = h;
            this.fg = 0xFFFFFF; this.bg = 0x000000; this.pen = 1;
            this.fieldBg = 0xFFFFFF;
            this.clipped = false;
        }
        getWidth() { return this.w; }
        getHeight() { return this.h; }
        setColor(fg, bg) { this.fg = num(fg); this.bg = bg == null ? this.bg : num(bg); return null; }
        setPenWidth(w) { this.pen = Math.max(1, num(w) | 0); return null; }
        setAntiAlias() { return null; }
        setFill() { return null; }
        setStroke() { return null; }
        setBlendMode() { return null; }
        setClip(x, y, w, h) {
            const c = this.ctx; if (!c) return null;
            this.clearClip();
            c.save(); this.clipped = true;
            c.beginPath(); c.rect(this.x0 + num(x), this.y0 + num(y), num(w), num(h)); c.clip();
            return null;
        }
        clearClip() { const c = this.ctx; if (c && this.clipped) { c.restore(); this.clipped = false; } return null; }
        css(color) { return '#' + (color >>> 0 & 0xFFFFFF).toString(16).padStart(6, '0'); }
        clear() {
            const c = this.ctx; if (!c) return null;
            const col = this.bg === -1 ? this.fieldBg : this.bg;
            c.fillStyle = this.css(col);
            c.fillRect(this.x0, this.y0, this.w, this.h);
            return null;
        }
        fillRectangle(x, y, w, h) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.fillStyle = this.css(this.fg);
            c.fillRect(this.x0 + ip(x), this.y0 + ip(y), ip(w), ip(h));
            return null;
        }
        drawRectangle(x, y, w, h) {
            x = ip(x); y = ip(y); w = ip(w); h = ip(h);
            const p = this.pen;
            this.fillRectangle(x, y, w, p); this.fillRectangle(x, y + h - p, w, p);
            this.fillRectangle(x, y, p, h); this.fillRectangle(x + w - p, y, p, h);
            return null;
        }
        drawLine(x1, y1, x2, y2) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            x1 = ip(x1); y1 = ip(y1); x2 = ip(x2); y2 = ip(y2);
            c.fillStyle = this.css(this.fg);
            const p = this.pen, o = Math.floor((p - 1) / 2);
            if (y1 === y2) { c.fillRect(this.x0 + Math.min(x1, x2), this.y0 + y1 - o, Math.abs(x2 - x1) + 1, p); return null; }
            if (x1 === x2) { c.fillRect(this.x0 + x1 - o, this.y0 + Math.min(y1, y2), p, Math.abs(y2 - y1) + 1); return null; }
            // Bresenham
            let dx = Math.abs(x2 - x1), dy = -Math.abs(y2 - y1), sx = x1 < x2 ? 1 : -1, sy = y1 < y2 ? 1 : -1, err = dx + dy;
            for (;;) {
                c.fillRect(this.x0 + x1 - o, this.y0 + y1 - o, p, p);
                if (x1 === x2 && y1 === y2) break;
                const e2 = 2 * err;
                if (e2 >= dy) { err += dy; x1 += sx; }
                if (e2 <= dx) { err += dx; y1 += sy; }
            }
            return null;
        }
        drawPoint(x, y) { return this.fillRectangle(x, y, 1, 1); }
        fillPolygon(points) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.fillStyle = this.css(this.fg);
            c.beginPath();
            points.forEach((p, i) => {
                const x = this.x0 + num($.idx(p, 0)) + 0.5, y = this.y0 + num($.idx(p, 1)) + 0.5;
                if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
            });
            c.closePath(); c.fill();
            return null;
        }
        fillCircle(x, y, r) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.fillStyle = this.css(this.fg);
            c.beginPath(); c.arc(this.x0 + num(x) + 0.5, this.y0 + num(y) + 0.5, num(r), 0, 2 * Math.PI); c.fill();
            return null;
        }
        drawCircle(x, y, r) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.strokeStyle = this.css(this.fg); c.lineWidth = this.pen;
            c.beginPath(); c.arc(this.x0 + num(x) + 0.5, this.y0 + num(y) + 0.5, num(r), 0, 2 * Math.PI); c.stroke();
            return null;
        }
        fillEllipse(x, y, a, b) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.fillStyle = this.css(this.fg);
            c.beginPath(); c.ellipse(this.x0 + num(x) + 0.5, this.y0 + num(y) + 0.5, num(a), num(b), 0, 0, 2 * Math.PI); c.fill();
            return null;
        }
        drawEllipse(x, y, a, b) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.strokeStyle = this.css(this.fg); c.lineWidth = this.pen;
            c.beginPath(); c.ellipse(this.x0 + num(x) + 0.5, this.y0 + num(y) + 0.5, num(a), num(b), 0, 0, 2 * Math.PI); c.stroke();
            return null;
        }
        drawArc(x, y, r, dir, a0, a1) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.strokeStyle = this.css(this.fg); c.lineWidth = this.pen;
            const s = -num(a0) * Math.PI / 180, e = -num(a1) * Math.PI / 180;
            c.beginPath(); c.arc(this.x0 + num(x), this.y0 + num(y), num(r), s, e, num(dir) === 0); c.stroke();
            return null;
        }
        fillRoundedRectangle(x, y, w, h, r) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.fillStyle = this.css(this.fg);
            c.beginPath(); c.roundRect(this.x0 + num(x), this.y0 + num(y), num(w), num(h), num(r)); c.fill();
            return null;
        }
        drawRoundedRectangle(x, y, w, h, r) {
            const c = this.ctx; if (!c || this.fg === -1) return null;
            c.strokeStyle = this.css(this.fg); c.lineWidth = this.pen;
            c.beginPath(); c.roundRect(this.x0 + num(x) + 0.5, this.y0 + num(y) + 0.5, num(w) - 1, num(h) - 1, num(r)); c.stroke();
            return null;
        }
        getFontHeight(font) { return env.fonts.get(font).height; }
        getFontAscent(font) { const f = env.fonts.get(font); return Math.round(f.ascent ?? f.base ?? f.height * 0.8); }
        getFontDescent(font) { const f = env.fonts.get(font); return f.height - this.getFontAscent(font); }
        getTextWidthInPixels(text, font) { return env.fonts.get(font).width(str(text)); }
        getTextDimensions(text, font) {
            const f = env.fonts.get(font), lines = str(text).split('\n');
            return [Math.max(...lines.map(l => f.width(l))), f.height * lines.length];
        }
        drawText(x, y, font, text, just) {
            const f = env.fonts.get(font);
            text = str(text);
            const lines = text.split('\n');
            const w = Math.max(...lines.map(l => f.width(l)));
            const h = f.height * lines.length;
            let left = ip(x), top = ip(y);
            const j = num(just);
            if (j & 1) left -= Math.trunc(w / 2); else if (!(j & 2)) left -= w;
            if (j & 4) top -= Math.trunc(h / 2);
            const c = this.ctx; if (!c) return null;
            if (this.bg !== -1) { c.fillStyle = this.css(this.bg); c.fillRect(this.x0 + left, this.y0 + top, w, h); }
            if (this.fg === -1) return null;
            lines.forEach((l, i) => {
                const lw = f.width(l);
                let lx = left;
                if (j & 1) lx = left + Math.trunc((w - lw) / 2); else if (!(j & 2)) lx = left + (w - lw);
                f.draw(c, this.x0 + lx, this.y0 + top + i * f.height, l, this.css(this.fg));
            });
            return null;
        }
        drawBitmap(x, y, bmp) {
            const c = this.ctx; if (!c) return null;
            const src = bitmapSource(bmp);
            if (src) c.drawImage(src, this.x0 + ip(x), this.y0 + ip(y));
            return null;
        }
        drawScaledBitmap(x, y, w, h, bmp) {
            const c = this.ctx; if (!c) return null;
            const src = bitmapSource(bmp);
            if (src) c.drawImage(src, this.x0 + ip(x), this.y0 + ip(y), ip(w), ip(h));
            return null;
        }
        drawBitmap2(x, y, bmp) { return this.drawBitmap(x, y, bmp); }
        drawAngledText() { throw new MonkeyError('Unsupported', 'Dc.drawAngledText() is not available in MVL Sim yet'); }
        drawRadialText() { throw new MonkeyError('Unsupported', 'Dc.drawRadialText() is not available in MVL Sim yet'); }
        drawOffsetBitmap() { throw new MonkeyError('Unsupported', 'Dc.drawOffsetBitmap() is not available in MVL Sim yet'); }
    }
    function ip(v) { return Math.trunc(num(v, 'coordinate')); }
    Graphics.Dc = Dc;

    // Bitmaps: resources (loaded images) and buffered bitmaps (offscreen canvases)
    class BitmapResource extends LangObject {
        getWidth() { return this.img.width; }
        getHeight() { return this.img.height; }
    }
    class BufferedBitmap extends LangObject {
        initialize(opts) {
            const w = num(opts.get(sym('width'))), h = num(opts.get(sym('height')));
            this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
            this.dc = new Dc(this.canvas.getContext('2d'), 0, 0, w, h);
            this.dc.fieldBg = 0x000000;
            return null;
        }
        getDc() { return this.dc; }
        getWidth() { return this.canvas.width; }
        getHeight() { return this.canvas.height; }
        getPalette() { return null; }
        setPalette() { return null; }
        isCached() { return false; }
    }
    class BufferedBitmapReference extends LangObject {
        get() { return this.bmp; }
        isCached() { return true; }
    }
    function bitmapSource(b) {
        if (b instanceof BufferedBitmap) return b.canvas;
        if (b instanceof BufferedBitmapReference) return b.bmp.canvas;
        if (b instanceof BitmapResource) return b.img;
        if (b && b.$bitmap) return bitmapSource(b.$bitmap);
        throw new MonkeyError('Unexpected Type Error', `drawBitmap: ${typeName(b)}`);
    }
    Graphics.BufferedBitmap = BufferedBitmap;
    Graphics.BufferedBitmapReference = BufferedBitmapReference;
    Graphics.BitmapReference = BitmapResource;
    Graphics.createBufferedBitmap = (opts) => {
        const r = Object.create(BufferedBitmapReference.prototype);
        r.bmp = $.new_(BufferedBitmap, [opts]);
        return r;
    };
    Graphics.FontReference = class FontReference extends LangObject {};
    Graphics.VectorFont = class VectorFont extends LangObject {};

    // ---------------- Activity
    const Activity = {
        TIMER_STATE_OFF: 0, TIMER_STATE_STOPPED: 1, TIMER_STATE_PAUSED: 2, TIMER_STATE_ON: 3,
        SPORT_GENERIC: 0, SPORT_RUNNING: 1, SPORT_CYCLING: 2, SPORT_TRANSITION: 3, SPORT_FITNESS_EQUIPMENT: 4,
        SPORT_SWIMMING: 5, SPORT_WALKING: 11, SPORT_HIKING: 17, SPORT_MOUNTAINEERING: 16, SPORT_E_BIKING: 21,
        SUB_SPORT_GENERIC: 0, SUB_SPORT_ROAD: 7, SUB_SPORT_MOUNTAIN: 8, SUB_SPORT_GRAVEL_CYCLING: 46, SUB_SPORT_INDOOR_CYCLING: 6,
        Info: class Info extends LangObject {},
        getActivityInfo: () => env.info(),
        getCurrentWorkoutStep: () => null,
        getNextWorkoutStep: () => null,
        getProfileInfo: () => {
            const o = new LangObject();
            Object.assign(o, { sport: env.sport().sport, subSport: env.sport().subSport, name: null, uniqueIdentifier: null });
            return o;
        },
    };
    // Activity.Info fields of API level 5.1
    const INFO_FIELDS = ['altitude', 'ambientPressure', 'averageCadence', 'averageDistance', 'averageHeartRate',
        'averagePower', 'averageSpeed', 'bearing', 'bearingFromStart', 'calories', 'currentCadence', 'currentHeading',
        'currentHeartRate', 'currentLocation', 'currentLocationAccuracy', 'currentOxygenSaturation', 'currentPower',
        'currentSpeed', 'distanceToDestination', 'distanceToNextPoint', 'elapsedDistance', 'elapsedTime',
        'elevationAtDestination', 'elevationAtNextPoint', 'energyExpenditure', 'frontDerailleurIndex',
        'frontDerailleurMax', 'frontDerailleurSize', 'maxCadence', 'maxHeartRate', 'maxPower', 'maxSpeed',
        'meanSeaLevelPressure', 'nameOfDestination', 'nameOfNextPoint', 'offCourseDistance', 'rawAmbientPressure',
        'rearDerailleurIndex', 'rearDerailleurMax', 'rearDerailleurSize', 'startLocation', 'startTime',
        'timerState', 'timerTime', 'totalAscent', 'totalDescent', 'track', 'trainingEffect',
        'anaerobicTrainingEffect', 'swimStrokeType', 'swimSwolf', 'currentRespirationRate'];
    Activity.Info.prototype.$fields = INFO_FIELDS;
    Activity.newInfo = (values) => {
        const o = Object.create(Activity.Info.prototype);
        for (const k of INFO_FIELDS) o[k] = null;
        Object.assign(o, values);
        return o;
    };

    // ---------------- Application
    let currentApp = null;
    const Application = {
        AppBase: class AppBase extends LangObject {
            initialize() { currentApp = this; return null; }
            onStart() { return null; }
            onStop() { return null; }
            getInitialView() { return []; }
            onSettingsChanged() { return null; }
            getProperty(k) { return env.properties.has(str(k)) ? env.properties.get(str(k)) : null; }
            setProperty(k, v) { env.properties.set(str(k), v); return null; }
            getSettingsView() { return null; }
            onBackgroundData() { return null; }
            getServiceDelegate() { return []; }
            openWebPage() { return null; }
        },
        getApp: () => currentApp,
        Properties: {
            getValue(k) {
                const key = str(k);
                // An app without any properties: the device fails this way (seen in Garmin's simulator, SDK 9.3.0)
                if (env.properties.size === 0) throw new MonkeyError('Unexpected Type Error', 'Failed invoking <symbol> (the app has no properties)');
                if (!env.properties.has(key)) throw $.new_(InvalidKeyException, [`Properties key '${key}' not found`]);
                return env.properties.get(key);
            },
            setValue(k, v) {
                const key = str(k);
                if (!env.properties.has(key)) throw $.new_(InvalidKeyException, [`Properties key '${key}' not found`]);
                env.properties.set(key, v); return null;
            },
        },
        Storage: {
            getValue(k) { const v = env.storage.get(MDict.key(k)); return v === undefined ? null : deepCopy(v); },
            setValue(k, v) { env.storage.set(MDict.key(k), deepCopy(v)); return null; },
            deleteValue(k) { env.storage.delete(MDict.key(k)); return null; },
            clearValues() { env.storage.clear(); return null; },
        },
        loadResource: (r) => WatchUi.loadResource(r),
    };
    Application.Properties.InvalidKeyException = InvalidKeyException;

    // ---------------- WatchUi
    const WatchUi = {
        View: null, DataField: null, SimpleDataField: null,
        loadResource(r) {
            if (r && r.kind === 'font') return env.fonts.bitmap(r.id);
            if (r && r.kind === 'string') return r.value;
            if (r && r.kind === 'json') return fromJson(r.value);
            if (r && r.kind === 'bitmap') {
                const img = env.images.get(r.url);
                if (!img) throw new MonkeyError('Unhandled Exception', `loadResource: bitmap ${r.id} not loaded`);
                const b = Object.create(BitmapResource.prototype); b.img = img; return b;
            }
            if (r && r.kind === 'drawable-list') throw new MonkeyError('Unsupported', `drawable-list ${r.id} is not available in MVL Sim yet`);
            throw new MonkeyError('Unhandled Exception', 'loadResource: unknown resource');
        },
        requestUpdate() { return null; },
        FontResource: class FontResource extends LangObject {},
        BitmapResource,
        LAYOUT_HALIGN_LEFT: -2, LAYOUT_HALIGN_CENTER: -1, LAYOUT_HALIGN_RIGHT: -3, LAYOUT_HALIGN_START: -2,
        LAYOUT_VALIGN_TOP: -2, LAYOUT_VALIGN_CENTER: -1, LAYOUT_VALIGN_BOTTOM: -3, LAYOUT_VALIGN_START: -2,
        OBSCURE_LEFT: 1, OBSCURE_TOP: 2, OBSCURE_RIGHT: 4, OBSCURE_BOTTOM: 8,
        DATA_FIELD_ALERT_MAX_COUNT: 1,
        showToast() { return null; },
    };
    class Drawable extends LangObject {
        initialize(opts) {
            const g = (k, d) => opts && opts.hasKey(sym(k)) ? opts.get(sym(k)) : d;
            this.identifier = g('identifier', null);
            this.locX = g('locX', 0); this.locY = g('locY', 0);
            this.width = g('width', 0); this.height = g('height', 0);
            this.isVisible = g('visible', true);
            return null;
        }
        draw() { return null; }
        setLocation(x, y) { this.locX = x; this.locY = y; return null; }
        setSize(w, h) { this.width = w; this.height = h; return null; }
        setVisible(v) { this.isVisible = v; return null; }
    }
    class Text extends Drawable {
        initialize(opts) {
            super.initialize(opts);
            const g = (k, d) => opts && opts.hasKey(sym(k)) ? opts.get(sym(k)) : d;
            this.mText = g('text', ''); this.mColor = g('color', Graphics.COLOR_WHITE); this.mBg = g('backgroundColor', Graphics.COLOR_TRANSPARENT);
            this.mFont = g('font', Graphics.FONT_MEDIUM); this.mJust = g('justification', Graphics.TEXT_JUSTIFY_LEFT);
            return null;
        }
        setText(t) { this.mText = t && t.kind === 'string' ? t.value : t; return null; }
        setColor(c) { this.mColor = c; return null; }
        setBackgroundColor(c) { this.mBg = c; return null; }
        setFont(f) { this.mFont = f; return null; }
        setJustification(j) { this.mJust = j; return null; }
        draw(dc) {
            if (!this.isVisible) return null;
            dc.setColor(this.mColor, this.mBg);
            const x = alignPos(this.locX, dc.getWidth(), this.width), y = alignPos(this.locY, dc.getHeight(), this.height);
            dc.drawText(x, y, this.mFont, this.mText, this.mJust);
            return null;
        }
    }
    class WBitmap extends Drawable {
        initialize(opts) {
            super.initialize(opts);
            const r = opts ? opts.get(sym('rezId')) : null;
            this.$bitmap = r ? WatchUi.loadResource(r) : opts ? opts.get(sym('bitmap')) : null;
            if (this.$bitmap) { this.width = this.$bitmap.getWidth(); this.height = this.$bitmap.getHeight(); }
            return null;
        }
        setBitmap(r) { this.$bitmap = WatchUi.loadResource(r); return null; }
        draw(dc) { if (this.isVisible && this.$bitmap) dc.drawBitmap(alignPos(this.locX, dc.getWidth(), this.width), alignPos(this.locY, dc.getHeight(), this.height), this.$bitmap); return null; }
    }
    // LAYOUT_HALIGN_* / LAYOUT_VALIGN_* positions
    function alignPos(v, total, size) {
        const n = num(v);
        if (n === -1) return Math.trunc((total - num(size || 0)) / 2);
        if (n === -2) return 0;
        if (n === -3) return total - num(size || 0);
        return n;
    }
    WatchUi.Drawable = Drawable;
    WatchUi.Text = Text;
    WatchUi.TextArea = Text;
    WatchUi.Bitmap = WBitmap;

    WatchUi.View = class View extends LangObject {
        $initFields() { super.$initFields(); this.$layout = null; }
        onLayout() { return null; }
        onShow() { return null; }
        onHide() { return null; }
        onUpdate(dc) {
            // The default draws the layout set with setLayout()
            if (this.$layout) {
                dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
                for (const d of this.$layout) d.draw(dc);
            }
            return null;
        }
        requestUpdate() { return null; }
        setLayout(l) { this.$layout = l; return null; }
        findDrawableById(id) {
            if (!this.$layout) return null;
            const key = str(id);
            return this.$layout.find(d => d.identifier != null && str(d.identifier) === key) || null;
        }
        setKeyToSelectableInteraction() { return null; }
        setActionMenuIndicator() { return null; }
        setControlBar() { return null; }
        isActionMenuIndicatorVisible() { return false; }
    };
    WatchUi.DataField = class DataField extends WatchUi.View {
        $initFields() { super.$initFields(); }
        compute() { return null; }
        getBackgroundColor() { return env.night() ? Graphics.COLOR_BLACK : Graphics.COLOR_WHITE; }
        getObscurityFlags() { return env.field().obscurity; }
        onTimerStart() { return null; }
        onTimerStop() { return null; }
        onTimerPause() { return null; }
        onTimerResume() { return null; }
        onTimerLap() { return null; }
        onTimerReset() { return null; }
        onNextMultisportLeg() { return null; }
        onWorkoutStarted() { return null; }
        onWorkoutStepComplete() { return null; }
        showAlert() { env.log('[alert]'); return null; }
        createField(name, id, type, opts) {
            const f = $.new_(FitContributor.Field, []);
            f.meta = { name: str(name), id: num(id), type: num(type), mesgType: opts ? opts.get(sym('mesgType')) : null, count: opts ? opts.get(sym('count')) : null, units: opts ? opts.get(sym('units')) : null };
            return f;
        }
    };
    WatchUi.SimpleDataField = class SimpleDataField extends WatchUi.DataField {
        $initFields() { super.$initFields(); this.label = null; }
    };
    WatchUi.SimpleDataField.prototype.label = null;
    WatchUi.DataFieldAlert = class DataFieldAlert extends WatchUi.View {};

    // ---------------- FitContributor
    const FitContributor = {
        DATA_TYPE_SINT8: 1, DATA_TYPE_UINT8: 2, DATA_TYPE_SINT16: 3, DATA_TYPE_UINT16: 4, DATA_TYPE_SINT32: 5,
        DATA_TYPE_UINT32: 6, DATA_TYPE_STRING: 7, DATA_TYPE_FLOAT: 8, DATA_TYPE_DOUBLE: 9,
        DATA_TYPE_UINT8Z: 10, DATA_TYPE_UINT16Z: 11, DATA_TYPE_UINT32Z: 12, DATA_TYPE_SINT64: 14, DATA_TYPE_UINT64: 15,
        MESG_TYPE_SESSION: 18, MESG_TYPE_LAP: 19, MESG_TYPE_RECORD: 20,
        Field: class Field extends LangObject {
            setData(v) { env.fitWrite(this.meta, deepCopy(v)); return null; }
        },
    };

    // ---------------- System
    const System = {
        println(x) { env.log(str(x)); return null; },
        print(x) { env.log(str(x)); return null; },
        getClockTime() {
            const t = env.now() + env.clockOffset();
            const d = new Date(t * 1000);
            const o = Object.create(System.ClockTime.prototype);
            Object.assign(o, { hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds(), timeZoneOffset: env.clockOffset(), dst: 0 });
            return o;
        },
        getTimer() { return (env.now() * 1000) | 0; },
        getDeviceSettings() {
            const o = new LangObject();
            const dev = env.device;
            Object.assign(o, { screenWidth: dev.width, screenHeight: dev.height, screenShape: dev.screenShape ?? 3, is24Hour: true,
                distanceUnits: 0, elevationUnits: 0, paceUnits: 0, heightUnits: 0, temperatureUnits: 0, weightUnits: 0,
                inputButtons: 0, isTouchScreen: !!dev.isTouch, isEnhancedReadabilityModeEnabled: false, vibrateOn: true, tonesOn: true,
                activityTrackingOn: true, phoneConnected: false, connectionAvailable: false, doNotDisturb: false,
                monkeyVersion: [5, 1, 0], partNumber: dev.partNumber || '', firmwareVersion: [0, 0], fontScale: new F(1),
                systemLanguage: 0, uniqueIdentifier: null, requiresBurnInProtection: false, isNightModeEnabled: env.night() });
            return o;
        },
        getSystemStats() {
            const o = new LangObject();
            const total = env.device.memoryLimit || 131072;
            Object.assign(o, { battery: new F(env.battery ? env.battery() : 80), batteryInDays: new F(10), totalMemory: total, usedMemory: 0, freeMemory: total, charging: false, solarIntensity: null });
            return o;
        },
        exit() { throw new MonkeyError('System.exit', 'the app called System.exit()'); },
        error(msg) { throw new MonkeyError('System.error', str(msg)); },
        ClockTime: class ClockTime extends LangObject {},
        SCREEN_SHAPE_ROUND: 1, SCREEN_SHAPE_SEMI_ROUND: 2, SCREEN_SHAPE_RECTANGLE: 3, SCREEN_SHAPE_SEMI_OCTAGON: 4,
        UNIT_METRIC: 0, UNIT_STATUTE: 1,
    };

    // ---------------- Time
    class Moment extends LangObject {
        initialize(v) { this.v = num(v); return null; }
        value() { return this.v; }
        add(d) { return $.new_(Moment, [this.v + d.value()]); }
        subtract(o) { return o instanceof Moment ? $.new_(Duration, [Math.abs(this.v - o.v)]) : $.new_(Moment, [this.v - o.value()]); }
        compare(o) { return this.v - o.value(); }
        greaterThan(o) { return this.v > o.value(); }
        lessThan(o) { return this.v < o.value(); }
        equals(o) { return o instanceof Moment && o.v === this.v; }
    }
    class Duration extends LangObject {
        initialize(v) { this.v = num(v); return null; }
        value() { return this.v; }
        add(d) { return $.new_(Duration, [this.v + d.value()]); }
        subtract(d) { return $.new_(Duration, [this.v - d.value()]); }
        divide(n) { return $.new_(Duration, [Math.trunc(this.v / num(n))]); }
        multiply(n) { return $.new_(Duration, [Math.trunc(this.v * num(n))]); }
        compare(o) { return this.v - o.value(); }
        greaterThan(o) { return this.v > o.value(); }
        lessThan(o) { return this.v < o.value(); }
        equals(o) { return o instanceof Duration && o.v === this.v; }
    }
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const Time = {
        Moment, Duration,
        now: () => $.new_(Moment, [env.now()]),
        today: () => $.new_(Moment, [env.now() - ((env.now() + env.clockOffset()) % 86400)]),
        Gregorian: {
            FORMAT_SHORT: 0, FORMAT_MEDIUM: 1, FORMAT_LONG: 2,
            SECONDS_PER_MINUTE: 60, SECONDS_PER_HOUR: 3600, SECONDS_PER_DAY: 86400,
            info(m, fmt) {
                const d = new Date((m.value() + env.clockOffset()) * 1000);
                const f = num(fmt ?? 0);
                const o = new LangObject();
                Object.assign(o, { year: d.getUTCFullYear(), month: f === 0 ? d.getUTCMonth() + 1 : MONTHS[d.getUTCMonth()], day: d.getUTCDate(), hour: d.getUTCHours(),
                    min: d.getUTCMinutes(), sec: d.getUTCSeconds(), day_of_week: f === 0 ? d.getUTCDay() + 1 : DAYS[d.getUTCDay()] });
                return o;
            },
            utcInfo(m, fmt) { return Time.Gregorian.info($.new_(Moment, [m.value() - env.clockOffset()]), fmt); },
            moment(o) {
                const g = (k, d) => o.hasKey(sym(k)) ? num(o.get(sym(k))) : d;
                const t = Date.UTC(g('year', 1970), g('month', 1) - 1, g('day', 1), g('hour', 0), g('minute', 0), g('second', 0)) / 1000;
                return $.new_(Moment, [t - env.clockOffset()]);
            },
            duration(o) { return $.new_(Duration, [(num(o.get(sym('hours')) ?? 0) * 3600) + (num(o.get(sym('minutes')) ?? 0) * 60) + num(o.get(sym('seconds')) ?? 0)]); },
        },
    };

    // ---------------- Math
    const M = {
        PI: new F(Math.PI), E: new F(Math.E),
        sin: (x) => fl(x, Math.sin), cos: (x) => fl(x, Math.cos), tan: (x) => fl(x, Math.tan),
        asin: (x) => fl(x, Math.asin), acos: (x) => fl(x, Math.acos), atan: (x) => fl(x, Math.atan),
        atan2: (y, x) => mkFloat(y, x, Math.atan2(num(y), num(x))),
        sqrt: (x) => fl(x, Math.sqrt), ln: (x) => fl(x, Math.log), log: (x, b) => new F(Math.log(num(x)) / Math.log(num(b))),
        pow: (x, y) => mkFloat(x, y, Math.pow(num(x), num(y))),
        floor: (x) => fl(x, Math.floor), ceil: (x) => fl(x, Math.ceil), round: (x) => fl(x, Math.round),
        toRadians: (x) => fl(x, v => v * Math.PI / 180), toDegrees: (x) => fl(x, v => v * 180 / Math.PI),
        rand: () => (Math.random() * 0x7FFFFFFF) | 0, srand: () => null,
        mean: (a) => new F(a.reduce((s, x) => s + num(x), 0) / a.length),
        variance: (a, m) => { const mu = m == null ? a.reduce((s, x) => s + num(x), 0) / a.length : num(m); return new F(a.reduce((s, x) => s + (num(x) - mu) ** 2, 0) / (a.length - 1)); },
        stdev: (a, m) => new F(Math.sqrt(M.variance(a, m).v)),
    };
    function fl(x, f) { return x instanceof D ? new D(f(x.v)) : new F(f(num(x))); }

    // ---------------- UserProfile
    const UserProfile = {
        getFunctionalThresholdPower: () => env.userFtp(),
        getProfile() {
            const p = env.profile();
            const o = Object.create(UserProfile.Profile.prototype);
            Object.assign(o, { weight: p.weight, height: p.height, gender: p.gender, birthYear: p.birthYear,
                restingHeartRate: p.restingHeartRate, averageRestingHeartRate: p.restingHeartRate,
                runningStepLength: null, walkingStepLength: null, activityClass: null, vo2maxRunning: null, vo2maxCycling: null,
                wakeTime: $.new_(Duration, [7 * 3600]), sleepTime: $.new_(Duration, [23 * 3600]) });
            return o;
        },
        getHeartRateZones: () => env.profile().hrZones.slice(),
        getCurrentSport: () => env.sport().sport,
        Profile: class Profile extends LangObject {},
        HR_ZONE_SPORT_GENERIC: 0, HR_ZONE_SPORT_RUNNING: 1, HR_ZONE_SPORT_BIKING: 2, HR_ZONE_SPORT_SWIMMING: 3,
        GENDER_FEMALE: 0, GENDER_MALE: 1,
    };

    // ---------------- AntPlus
    class RadarTarget extends LangObject {}
    const AntPlus = {
        THREAT_NONE: 0, THREAT_APPROACHING: 1, THREAT_FAST_APPROACHING: 2,
        THREAT_SIDE_NO_SIDE: 0, THREAT_SIDE_RIGHT: 1, THREAT_SIDE_LEFT: 2,
        RadarTarget,
        BikeRadarListener: class BikeRadarListener extends LangObject {},
        BikeRadar: class BikeRadar extends LangObject {
            initialize(listener) { this.listener = listener; return null; }
            getRadarInfo() {
                const r = env.radar();
                if (!r) return null;
                const out = [];
                for (let i = 0; i < 8; i++) {
                    const t = Object.create(RadarTarget.prototype);
                    const range = r.ranges[i] ?? 0, speed = r.speeds[i] ?? 0;
                    t.range = new F(range); t.speed = new F(speed);
                    t.threat = speed > 0 ? (speed >= 9 ? 2 : 1) : 0;
                    t.threatSide = 0;
                    out.push(t);
                }
                return out;
            }
            getDeviceState() { return null; }
        },
    };

    // ---------------- Weather
    const Weather = {
        CurrentConditions: class CurrentConditions extends LangObject {},
        getCurrentConditions() {
            const w = env.weather();
            if (!w) return null;
            const o = Object.create(Weather.CurrentConditions.prototype);
            Object.assign(o, { windBearing: w.bearing | 0, windSpeed: new F(w.speed), temperature: w.temp ?? null,
                condition: 0, observationTime: null, observationLocationName: null, observationLocationPosition: null,
                precipitationChance: null, relativeHumidity: null, feelsLikeTemperature: null, highTemperature: null,
                lowTemperature: null, forecastTime: null });
            return o;
        },
        getHourlyForecast: () => null,
        getDailyForecast: () => null,
        getSunrise: () => null,
        getSunset: () => null,
    };

    // ---------------- Position
    class Location extends LangObject {
        initialize(o) {
            const lat = num(o.get(sym('latitude'))), lon = num(o.get(sym('longitude')));
            const fmt = o.get(sym('format'));
            const rad = fmt === sym('radians');
            const semi = fmt === sym('semicircles');
            this.lat = rad ? lat * 180 / Math.PI : semi ? lat * 180 / 2147483648 : lat;
            this.lon = rad ? lon * 180 / Math.PI : semi ? lon * 180 / 2147483648 : lon;
            return null;
        }
        toDegrees() { return [new D(this.lat), new D(this.lon)]; }
        toRadians() { return [new D(this.lat * Math.PI / 180), new D(this.lon * Math.PI / 180)]; }
        toGeoString(fmt) { return `${this.lat.toFixed(5)}, ${this.lon.toFixed(5)}`; }
    }
    const Position = {
        Location,
        Info: class Info extends LangObject {},
        QUALITY_NOT_AVAILABLE: 0, QUALITY_LAST_KNOWN: 1, QUALITY_POOR: 2, QUALITY_USABLE: 3, QUALITY_GOOD: 4,
        LOCATION_DISABLE: 0, LOCATION_ONE_SHOT: 1, LOCATION_CONTINUOUS: 2,
        GEO_DEG: 0, GEO_DM: 1, GEO_DMS: 2, GEO_MGRS: 3,
        getInfo: () => env.position(),
        enableLocationEvents(type, cb) { env.listeners.position = num(type) === 0 ? null : { cb, once: num(type) === 1 }; return null; },
    };
    Position.newLocation = (lat, lon) => { const o = Object.create(Location.prototype); o.lat = lat; o.lon = lon; return o; };
    Position.newInfo = (v) => { const o = Object.create(Position.Info.prototype); Object.assign(o, { accuracy: 0, altitude: null, heading: null, position: null, speed: null, when: null }, v); return o; };

    // ---------------- Sensor
    const Sensor = {
        Info: class Info extends LangObject {},
        SENSOR_BIKESPEED: 0, SENSOR_BIKECADENCE: 1, SENSOR_BIKEPOWER: 3, SENSOR_FOOTPOD: 4, SENSOR_HEARTRATE: 5,
        SENSOR_TEMPERATURE: 7, SENSOR_ONBOARD_HEARTRATE: 9,
        getInfo: () => env.sensor(),
        setEnabledSensors: () => [],
        enableSensorEvents(cb) { env.listeners.sensor = cb || null; return null; },
        enableSensorType: () => true,
        disableSensorType: () => null,
        getRegisteredSensors: () => null,
    };
    Sensor.newInfo = (v) => {
        const o = Object.create(Sensor.Info.prototype);
        Object.assign(o, { accel: null, altitude: null, cadence: null, heading: null, heartRate: null, mag: null, oxygenSaturation: null,
            power: null, pressure: null, speed: null, temperature: null, timestamp: null, iq: null }, v);
        return o;
    };

    // ---------------- Timer (runs on simulated time; env.timers is driven by the engine)
    const Timer = {
        Timer: class Timer extends LangObject {
            start(cb, ms, repeat) { env.timers.add(this); this.cb = cb; this.ms = num(ms); this.repeat = repeat; this.due = env.now() * 1000 + this.ms; return null; }
            stop() { env.timers.delete(this); return null; }
        },
    };

    // ---------------- StringUtil
    const StringUtil = {
        CHAR_ENCODING_UTF8: 0,
        utf8ArrayToString: (a) => new TextDecoder().decode(new Uint8Array(a instanceof Bytes ? a.a : a.map(num))),
        stringReplace: (s, a, b) => str(s).split(str(a)).join(str(b)),
    };

    const T = { Lang, Graphics, Activity, Application, WatchUi, FitContributor, System, Time, Math: M, UserProfile,
        AntPlus, Weather, Position, Sensor, Timer, StringUtil };
    T.Toybox = T;
    return { T, $, newDc: (ctx, x0, y0, w, h) => new Dc(ctx, x0, y0, w, h), newInfo: Activity.newInfo, F, D, MDict };
}

function deepCopy(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof L) return new L(v.v);
    if (v instanceof F) return v instanceof D ? new D(v.v) : new F(v.v);
    if (v instanceof Bytes) return new Bytes(v.a.slice());
    if (Array.isArray(v)) return v.map(deepCopy);
    if (v instanceof MDict) return new MDict([...v.map.values()].map(([k, x]) => [k, deepCopy(x)]));
    return v;
}
