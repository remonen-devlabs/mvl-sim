// Monkey C -> JavaScript translator.
// Arithmetic, comparisons and method calls on built-in types go through runtime helpers ($.*)
// so Number (32-bit int) / Long (64-bit) / Float (32-bit) / Char semantics match the device.
// Anything the translator does not understand is an error with file:line, never a guess.

const KEYWORDS = new Set(['class', 'function', 'var', 'const', 'if', 'else', 'for', 'while', 'do', 'return',
    'break', 'continue', 'new', 'null', 'true', 'false', 'self', 'me', 'extends', 'import', 'using', 'as', 'module',
    'private', 'protected', 'public', 'hidden', 'static', 'has', 'instanceof', 'switch', 'case', 'default', 'try',
    'catch', 'finally', 'throw', 'and', 'or', 'not', 'enum', 'typedef', 'native']);

const PUNCT = ['<<=', '>>=', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=',
    '^=', '<<', '>>', '=>', '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.',
    '(', ')', '[', ']', '{', '}'];

export class TranslateError extends Error {}

function tokenize(src, file) {
    const toks = [];
    let i = 0, line = 1;
    const err = (m) => { throw new TranslateError(`${file}:${line}: ${m}`); };
    while (i < src.length) {
        const c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
            i += 2; continue;
        }
        const start = i, ws = i > 0 && /\s/.test(src[i - 1]);
        if (/[A-Za-z_$]/.test(c)) {
            while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
            const v = src.slice(start, i);
            toks.push({ t: KEYWORDS.has(v) ? 'kw' : 'id', v, line, ws });
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
            let isFloat = false, isDouble = false, isLong = false, v, big = null;
            if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
                i += 2;
                while (/[0-9a-fA-F]/.test(src[i])) i++;
                big = BigInt('0x' + src.slice(start + 2, i));
                if (/[lL]/.test(src[i])) { i++; isLong = true; }
                v = Number(BigInt.asIntN(32, big));
            } else {
                while (/[0-9]/.test(src[i])) i++;
                if (src[i] === '.' && /[0-9]/.test(src[i + 1])) { isFloat = true; i++; while (/[0-9]/.test(src[i])) i++; }
                if (/[eE]/.test(src[i]) && /[-+0-9]/.test(src[i + 1])) {
                    isFloat = true; i++; if (/[-+]/.test(src[i])) i++; while (/[0-9]/.test(src[i])) i++;
                }
                const text = src.slice(start, i);
                v = parseFloat(text);
                if (/[dD]/.test(src[i])) { isFloat = true; isDouble = true; i++; }
                else if (/[fF]/.test(src[i])) { isFloat = true; i++; }
                else if (/[lL]/.test(src[i]) && !isFloat) { i++; isLong = true; }
                if (!isFloat) { big = BigInt(text); v = Number(BigInt.asIntN(32, big)); }
            }
            toks.push({ t: 'num', v, isFloat, isDouble, isLong, big, line, ws });
            continue;
        }
        if (c === '"' || c === '\'') {
            i++;
            let s = '';
            while (i < src.length && src[i] !== c) {
                if (src[i] === '\\') {
                    i++;
                    const e = src[i];
                    if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) { s += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)); i += 5; continue; }
                    s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e;
                    i++;
                } else { if (src[i] === '\n') err('newline in string'); s += src[i++]; }
            }
            i++;
            toks.push({ t: c === '"' ? 'str' : 'char', v: s, line, ws });
            continue;
        }
        const p = PUNCT.find(p => src.startsWith(p, i));
        if (!p) err(`unexpected character '${c}'`);
        i += p.length;
        toks.push({ t: 'p', v: p, line, ws });
    }
    toks.push({ t: 'eof', v: '<eof>', line, ws: true });
    return toks;
}

// ---------------------------------------------------------------- parser

const newScopeNode = (name, annotations, line, file) => ({ kind: 'module', name, annotations, line, file, imports: [], classes: [], functions: [], vars: [], modules: [] });

class Parser {
    constructor(src, file) {
        this.file = file;
        this.toks = tokenize(src, file);
        this.i = 0;
    }
    get tok() { return this.toks[this.i]; }
    peek(n = 1) { return this.toks[this.i + n]; }
    err(m, tok = this.tok) { throw new TranslateError(`${this.file}:${tok.line}: ${m} (at '${tok.v}')`); }
    is(v) { const t = this.tok; return (t.t === 'p' || t.t === 'kw') && t.v === v; }
    isId(v) { return this.tok.t === 'id' && (v === undefined || this.tok.v === v); }
    accept(v) { if (this.is(v)) { this.i++; return true; } return false; }
    expect(v) { if (!this.is(v)) this.err(`expected '${v}'`); return this.toks[this.i++]; }
    ident() {
        const t = this.tok;
        if (t.t !== 'id') this.err('expected identifier');
        this.i++;
        return t.v;
    }
    dotted() { const p = [this.ident()]; while (this.accept('.')) p.push(this.ident()); return p; }

    // Types are skipped: `as Array<Number>?`, `as [Views] or [Views, InputDelegates]`, `{ :a as Number }`
    skipType() {
        for (;;) {
            this.skipTypeAtom();
            while (this.accept('?')) { /* nullable */ }
            if (this.tok.t === 'kw' && this.tok.v === 'or') { this.i++; continue; }
            break;
        }
    }
    skipTypeAtom() {
        if (this.is('[')) return this.skipBalanced('[', ']');
        if (this.is('{')) return this.skipBalanced('{', '}');
        if (this.is('(')) return this.skipBalanced('(', ')');
        if (this.tok.t !== 'id' && !(this.tok.t === 'kw' && (this.tok.v === 'null'))) this.err('expected type');
        this.i++;
        while (this.is('.')) { this.i++; this.ident(); }
        if (this.is('<')) {
            let depth = 0;
            do {
                if (this.is('<')) depth++;
                else if (this.is('>')) depth--;
                else if (this.is('>>')) depth -= 2;
                else if (this.tok.t === 'eof') this.err('unterminated type');
                this.i++;
            } while (depth > 0);
        }
        if (this.is('(')) { // Method(a as X) as Y
            this.skipBalanced('(', ')');
            if (this.accept('as')) this.skipType();
        }
    }
    skipBalanced(open, close) {
        let depth = 0;
        do {
            if (this.is(open)) depth++;
            else if (this.is(close)) depth--;
            else if (this.tok.t === 'eof') this.err('unbalanced ' + open);
            this.i++;
        } while (depth > 0);
    }

    // ------------------------------------------------ top level
    program() {
        const prog = newScopeNode('', [], 1, this.file);
        this.body(prog, null);
        return prog;
    }

    // Shared by program, module and class bodies. A class target has `members`.
    body(target, endTok) {
        const isClass = !!target.members;
        while (!(endTok ? this.is(endTok) : this.tok.t === 'eof')) {
            const annotations = [];
            while (this.is('(') && this.peek().t === 'p' && this.peek().v === ':') {
                this.i++;
                for (;;) {
                    this.expect(':');
                    annotations.push(this.ident());
                    if (!this.accept(',')) break;
                }
                this.expect(')');
            }
            const mods = new Set();
            while (this.tok.t === 'kw' && ['private', 'protected', 'public', 'hidden', 'static', 'native'].includes(this.tok.v)) {
                mods.add(this.tok.v); this.i++;
            }
            const line = this.tok.line;
            const add = (kind, decl) => {
                if (isClass) target.members.push(decl);
                else if (kind === 'function') target.functions.push(decl);
                else target.vars.push(decl);
            };
            if (this.accept('import') || this.accept('using')) {
                const kw = this.toks[this.i - 1].v;
                const parts = this.dotted();
                let alias = null;
                if (this.accept('as')) alias = this.ident();
                this.expect(';');
                (target.imports || (target.imports = [])).push({ kw, path: parts, alias, line, file: this.file });
            } else if (this.accept('class')) {
                const name = this.ident();
                let ext = null;
                if (this.accept('extends')) ext = this.dotted();
                this.expect('{');
                const cls = { kind: 'class', name, ext, members: [], imports: [], annotations, line, file: this.file };
                this.body(cls, '}');
                this.expect('}');
                if (isClass) this.err('nested classes are not supported');
                target.classes.push(cls);
            } else if (this.accept('module')) {
                if (isClass) this.err('a module inside a class');
                const name = this.ident();
                this.expect('{');
                const mod = newScopeNode(name, annotations, line, this.file);
                this.body(mod, '}');
                this.expect('}');
                target.modules.push(mod);
            } else if (this.accept('function')) {
                const name = this.ident();
                this.expect('(');
                const params = [];
                if (!this.is(')')) {
                    for (;;) {
                        params.push(this.ident());
                        if (this.accept('as')) this.skipType();
                        if (!this.accept(',')) break;
                    }
                }
                this.expect(')');
                if (this.accept('as')) this.skipType();
                if (mods.has('native') || this.is(';')) { this.expect(';'); continue; }
                const fbody = this.block();
                add('function', { kind: 'function', name, params, body: fbody, annotations, mods, line, file: this.file });
            } else if (this.is('var') || this.is('const')) {
                const kind = this.tok.v; this.i++;
                for (;;) {
                    const vline = this.tok.line;
                    const name = this.ident();
                    if (this.accept('as')) this.skipType();
                    let init = null;
                    if (this.accept('=')) init = this.expr();
                    add(kind, { kind, name, init, annotations, mods, line: vline, file: this.file });
                    if (!this.accept(',')) break;
                }
                this.expect(';');
            } else if (this.accept('enum')) {
                if (this.tok.t === 'id') this.i++; // named enum: the name is a type only
                this.expect('{');
                let base = { k: 'num', v: 0, line }, off = 0;
                while (!this.is('}')) {
                    const eline = this.tok.line;
                    const name = this.ident();
                    if (this.accept('=')) { base = this.expr(); off = 0; }
                    let init;
                    if (off === 0) init = base;
                    else if (base.k === 'num' && !base.isFloat) init = { ...base, v: (base.v + off) | 0, big: base.big != null ? base.big + BigInt(off) : null };
                    else init = { k: 'bin', op: '+', l: base, r: { k: 'num', v: off, line: eline }, line: eline };
                    add('const', { kind: 'const', name, init, annotations, mods: new Set([...mods, 'enum']), line: eline, file: this.file });
                    off++;
                    if (!this.accept(',')) break;
                }
                this.expect('}');
                this.accept(';');
            } else if (this.accept('typedef')) {
                this.ident(); this.expect('as'); this.skipType(); this.expect(';');
            } else {
                this.err(isClass ? 'unexpected token in class body' : 'unexpected token at module level');
            }
        }
    }

    // ------------------------------------------------ statements
    block() {
        const line = this.tok.line;
        this.expect('{');
        const body = [];
        while (!this.is('}')) body.push(this.statement());
        this.expect('}');
        return { k: 'block', body, line };
    }

    statement() {
        const line = this.tok.line;
        if (this.is('{')) return this.block();
        if (this.accept(';')) return { k: 'block', body: [], line };
        if (this.accept('var')) {
            const decls = [];
            for (;;) {
                const name = this.ident();
                if (this.accept('as')) this.skipType();
                let init = null;
                if (this.accept('=')) init = this.expr();
                decls.push({ name, init });
                if (!this.accept(',')) break;
            }
            this.expect(';');
            return { k: 'var', decls, line };
        }
        if (this.accept('if')) {
            this.expect('('); const cond = this.expr(); this.expect(')');
            const then = this.statement();
            let els = null;
            if (this.accept('else')) els = this.statement();
            return { k: 'if', cond, then, els, line };
        }
        if (this.accept('for')) {
            this.expect('(');
            let init = null;
            if (this.is('var')) init = this.statement(); // consumes ';'
            else { if (!this.is(';')) init = { k: 'expr', e: this.exprList(), line }; this.expect(';'); }
            const cond = this.is(';') ? null : this.expr();
            this.expect(';');
            const update = this.is(')') ? null : this.exprList();
            this.expect(')');
            const body = this.statement();
            return { k: 'for', init, cond, update, body, line };
        }
        if (this.accept('while')) {
            this.expect('('); const cond = this.expr(); this.expect(')');
            return { k: 'while', cond, body: this.statement(), line };
        }
        if (this.accept('do')) {
            const body = this.statement();
            this.expect('while'); this.expect('('); const cond = this.expr(); this.expect(')'); this.expect(';');
            return { k: 'do', cond, body, line };
        }
        if (this.accept('return')) {
            const e = this.is(';') ? null : this.expr();
            this.expect(';');
            return { k: 'return', e, line };
        }
        if (this.accept('break')) { this.expect(';'); return { k: 'break', line }; }
        if (this.accept('continue')) { this.expect(';'); return { k: 'continue', line }; }
        if (this.accept('throw')) { const e = this.expr(); this.expect(';'); return { k: 'throw', e, line }; }
        if (this.accept('try')) {
            const body = this.block();
            const catches = [];
            while (this.accept('catch')) {
                this.expect('(');
                const name = this.ident();
                let type = null;
                if (this.accept('instanceof')) type = this.dotted();
                this.expect(')');
                catches.push({ name, type, body: this.block() });
            }
            let fin = null;
            if (this.accept('finally')) fin = this.block();
            return { k: 'try', body, catches, fin, line };
        }
        if (this.accept('switch')) {
            this.expect('('); const disc = this.expr(); this.expect(')');
            this.expect('{');
            const cases = [];
            while (!this.is('}')) {
                const cline = this.tok.line;
                if (this.accept('default')) { this.expect(':'); cases.push({ test: null, body: [], line: cline }); }
                else {
                    this.expect('case');
                    let test;
                    if (this.accept('instanceof')) test = { k: 'caseinstanceof', type: this.dotted(), line: cline };
                    else test = this.expr();
                    this.expect(':');
                    cases.push({ test, body: [], line: cline });
                }
                while (!this.is('case') && !this.is('default') && !this.is('}')) cases[cases.length - 1].body.push(this.statement());
            }
            this.expect('}');
            return { k: 'switch', disc, cases, line };
        }
        const e = this.expr();
        this.expect(';');
        return { k: 'expr', e, line };
    }

    exprList() {
        const list = [this.expr()];
        while (this.accept(',')) list.push(this.expr());
        return list.length === 1 ? list[0] : { k: 'seq', list, line: list[0].line };
    }

    // ------------------------------------------------ expressions
    expr() { return this.assignment(); }

    assignment() {
        const left = this.ternary();
        const t = this.tok;
        if (t.t === 'p' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(t.v)) {
            if (!['id', 'member', 'index'].includes(left.k)) this.err('invalid assignment target');
            this.i++;
            const value = this.assignment();
            return { k: 'assign', op: t.v, target: left, value, line: t.line };
        }
        return left;
    }

    ternary() {
        const cond = this.logicOr();
        if (this.is('?')) {
            const line = this.tok.line;
            this.i++;
            const a = this.assignment();
            this.expect(':');
            const b = this.assignment();
            return { k: 'tern', cond, a, b, line };
        }
        return cond;
    }

    logicOr() {
        let l = this.logicAnd();
        while (this.is('||') || this.is('or')) { const line = this.tok.line; this.i++; l = { k: 'logic', op: '||', l, r: this.logicAnd(), line }; }
        return l;
    }
    logicAnd() {
        let l = this.bitOr();
        while (this.is('&&') || this.is('and')) { const line = this.tok.line; this.i++; l = { k: 'logic', op: '&&', l, r: this.bitOr(), line }; }
        return l;
    }
    binLevel(next, ops) {
        let l = next();
        while (this.tok.t === 'p' && ops.includes(this.tok.v)) {
            const op = this.tok.v, line = this.tok.line;
            this.i++;
            l = { k: 'bin', op, l, r: next(), line };
        }
        return l;
    }
    bitOr() { return this.binLevel(() => this.bitXor(), ['|']); }
    bitXor() { return this.binLevel(() => this.bitAnd(), ['^']); }
    bitAnd() { return this.binLevel(() => this.equality(), ['&']); }
    equality() { return this.binLevel(() => this.relational(), ['==', '!=']); }
    relational() {
        let l = this.shift();
        for (;;) {
            const line = this.tok.line;
            if (this.tok.t === 'p' && ['<', '>', '<=', '>='].includes(this.tok.v)) {
                const op = this.tok.v; this.i++;
                l = { k: 'bin', op, l, r: this.shift(), line };
            } else if (this.accept('instanceof')) {
                l = { k: 'instanceof', e: l, type: this.dotted(), line };
            } else if (this.accept('has')) {
                this.expect(':');
                l = { k: 'has', e: l, sym: this.ident(), line };
            } else return l;
        }
    }
    shift() { return this.binLevel(() => this.additive(), ['<<', '>>']); }
    additive() { return this.binLevel(() => this.multiplicative(), ['+', '-']); }
    multiplicative() { return this.binLevel(() => this.unary(), ['*', '/', '%']); }

    unary() {
        const t = this.tok;
        if (t.t === 'p' && (t.v === '-' || t.v === '!' || t.v === '~' || t.v === '+')) {
            this.i++;
            const e = this.unary();
            if (t.v === '+') return e;
            if (t.v === '-' && e.k === 'num') return { ...e, v: e.isFloat ? -e.v : (-e.v) | 0, big: e.big != null ? -e.big : null };
            return { k: 'un', op: t.v, e, line: t.line };
        }
        if (t.t === 'kw' && t.v === 'not') { this.i++; return { k: 'un', op: '!', e: this.unary(), line: t.line }; }
        if (t.t === 'p' && (t.v === '++' || t.v === '--')) {
            this.i++;
            return { k: 'incdec', op: t.v, prefix: true, target: this.unary(), line: t.line };
        }
        return this.postfix();
    }

    postfix() {
        let e = this.primary();
        for (;;) {
            const line = this.tok.line;
            if (this.accept('.')) {
                e = { k: 'member', obj: e, name: this.ident(), line };
            } else if (this.is('(')) {
                e = { k: 'call', callee: e, args: this.args(), line };
            } else if (this.accept('[')) {
                const idx = this.expr();
                this.expect(']');
                e = { k: 'index', obj: e, idx, line };
            } else if (this.is('++') || this.is('--')) {
                const op = this.tok.v; this.i++;
                e = { k: 'incdec', op, prefix: false, target: e, line };
            } else if (this.accept('as')) {
                this.skipType();
            } else return e;
        }
    }

    args() {
        this.expect('(');
        const args = [];
        if (!this.is(')')) {
            for (;;) { args.push(this.expr()); if (!this.accept(',')) break; }
        }
        this.expect(')');
        return args;
    }

    primary() {
        const t = this.tok, line = t.line;
        if (t.t === 'num') { this.i++; return { k: 'num', v: t.v, isFloat: t.isFloat, isDouble: t.isDouble, isLong: t.isLong, big: t.big, line }; }
        if (t.t === 'str') { this.i++; return { k: 'str', v: t.v, line }; }
        if (t.t === 'char') { this.i++; return { k: 'char', v: t.v, line }; }
        if (t.t === 'id') { this.i++; return { k: 'id', name: t.v, line }; }
        if (t.t === 'kw') {
            if (t.v === 'null') { this.i++; return { k: 'null', line }; }
            if (t.v === 'true' || t.v === 'false') { this.i++; return { k: 'bool', v: t.v === 'true', line }; }
            if (t.v === 'self' || t.v === 'me') { this.i++; return { k: 'self', line }; }
            if (t.v === 'new') {
                this.i++;
                if (this.accept('[')) {
                    const size = this.expr();
                    this.expect(']');
                    if (this.isId('b') && !this.tok.ws) { this.i++; return { k: 'newbytes', size, line }; }
                    return { k: 'newarr', size, line };
                }
                let callee = { k: 'id', name: this.ident(), line };
                while (this.accept('.')) callee = { k: 'member', obj: callee, name: this.ident(), line };
                if (this.is('<')) this.skipTypeArgs();
                // Typed array allocation: new Array<Number>[5]
                if (callee.k === 'id' && callee.name === 'Array' && this.accept('[')) {
                    const size = this.expr();
                    this.expect(']');
                    return { k: 'newarr', size, line };
                }
                return { k: 'new', callee, args: this.args(), line };
            }
        }
        if (t.t === 'p') {
            if (t.v === ':' && this.peek().t === 'id' && !this.peek().ws) {
                this.i++;
                return { k: 'sym', v: this.ident(), line };
            }
            if (t.v === '(') { this.i++; const e = this.expr(); this.expect(')'); return e; }
            if (t.v === '[') {
                this.i++;
                const items = [];
                while (!this.is(']')) { items.push(this.expr()); if (!this.accept(',')) break; }
                this.expect(']');
                if (this.isId('b') && !this.tok.ws) { this.i++; return { k: 'bytearr', items, line }; }
                return { k: 'arr', items, line };
            }
            if (t.v === '{') {
                this.i++;
                const entries = [];
                while (!this.is('}')) {
                    const key = this.expr();
                    this.expect('=>');
                    entries.push([key, this.expr()]);
                    if (!this.accept(',')) break;
                }
                this.expect('}');
                return { k: 'dict', entries, line };
            }
        }
        this.err('unexpected token in expression');
    }
    skipTypeArgs() { // type arguments after new: new Array<Number>[5], generic classes
        let depth = 0;
        do {
            if (this.is('<')) depth++; else if (this.is('>')) depth--; else if (this.is('>>')) depth -= 2;
            else if (this.tok.t === 'eof') this.err('unterminated type');
            this.i++;
        } while (depth > 0);
    }
}

// ---------------------------------------------------------------- emitter

const LANG_TYPES = new Set(['Number', 'Float', 'Long', 'Double', 'String', 'Array', 'Dictionary', 'Boolean', 'Char',
    'Symbol', 'Method', 'Object', 'ByteArray', 'Exception']);

const ASSIGN_OPS = { '+=': 'add', '-=': 'sub', '*=': 'mul', '/=': 'div', '%=': 'mod', '&=': 'band', '|=': 'bor', '^=': 'bxor', '<<=': 'shl', '>>=': 'shr' };
const BIN_OPS = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '&': 'band', '|': 'bor', '^': 'bxor', '<<': 'shl', '>>': 'shr',
    '==': 'eq', '!=': 'ne', '<': 'lt', '>': 'gt', '<=': 'le', '>=': 'ge' };

/**
 * sources: [{file, text}]; opts.exclude: annotation names to drop; opts.toybox: runtime T (for base-class lookups)
 * Returns { code, classes } where code is JS for new Function('T','G','$', code).
 * classes: full names ('MyModule.MyClass' or 'MyClass') -> JS path under G.
 */
export function translate(sources, opts) {
    const exclude = new Set(opts.exclude || []);
    const T = opts.toybox;
    const progs = sources.map(s => new Parser(s.text, s.file).program());
    const keep = (m) => !m.annotations.some(a => exclude.has(a));

    // ------------------------------------------------ symbol tables
    // Scope: { name, js, parent, classes, functions, vars, modules (Maps) }
    const mkScope = (name, parent) => ({ name, js: parent ? `${parent.js}.${name}` : 'G', parent, classes: new Map(), functions: new Map(), vars: new Map(), modules: new Map() });
    const global = mkScope('', null);
    const allClasses = [];      // class decls
    const staticPaths = new Set(); // JS paths of modules and classes (plain property access is safe)
    const imports = [];         // all import/using entries

    function dup(scope, name, d) {
        if (scope.classes.has(name) || scope.functions.has(name) || scope.vars.has(name)) {
            throw new TranslateError(`${d.file}:${d.line}: ${name} defined twice${scope.name ? ' in module ' + scope.name : ''} (after annotation exclusion)`);
        }
    }
    function collect(node, scope) {
        for (const im of node.imports || []) imports.push(im);
        for (const m of node.modules || []) {
            if (!keep(m)) continue;
            let s = scope.modules.get(m.name);
            if (!s) { s = mkScope(m.name, scope); scope.modules.set(m.name, s); staticPaths.add(s.js); }
            collect(m, s);
        }
        for (const c of node.classes || []) {
            if (!keep(c)) continue;
            dup(scope, c.name, c);
            const members = c.members.filter(keep);
            const memberMap = new Map();
            for (const m of members) {
                if (memberMap.has(m.name)) throw new TranslateError(`${m.file}:${m.line}: ${m.name} defined twice in ${c.name} (after annotation exclusion)`);
                memberMap.set(m.name, m);
                // Class constants and enums belong to the class, not to each instance
                m.isStatic = m.mods.has('static') || m.kind === 'const';
            }
            for (const im of c.imports || []) imports.push(im);
            const decl = { ...c, members, memberMap, scope, js: `${scope.js}.${c.name}`, full: scope.js === 'G' ? c.name : `${scope.js.slice(2)}.${c.name}` };
            scope.classes.set(c.name, decl);
            allClasses.push(decl);
            staticPaths.add(decl.js);
        }
        for (const f of node.functions || []) if (keep(f)) { dup(scope, f.name, f); scope.functions.set(f.name, { ...f, scope }); }
        for (const v of node.vars || []) if (keep(v)) { dup(scope, v.name, v); scope.vars.set(v.name, { ...v, scope }); }
    }
    for (const p of progs) collect(p, global);

    // ------------------------------------------------ imports: aliases and opened modules
    const aliases = new Map();   // name -> JS path
    const opened = [];           // JS paths whose members are visible unqualified
    const skippedToybox = new Set(); // Toybox modules imported but not in the stand-in
    function resolveToyboxPath(parts) {
        let o = T;
        for (const p of parts) { if (o == null || !(p in o)) return null; o = o[p]; }
        return o;
    }
    function userPath(parts) { // ['A','B'] -> scope or class decl at G.A.B
        let s = global, i = 0;
        for (; i < parts.length; i++) {
            const m = s.modules.get(parts[i]);
            if (m) { s = m; continue; }
            const c = s.classes.get(parts[i]);
            if (c && i === parts.length - 1) return { kind: 'class', decl: c, js: c.js };
            return null;
        }
        return { kind: 'module', scope: s, js: s.js };
    }
    for (const im of imports) {
        const parts = im.path[0] === 'Toybox' ? im.path.slice(1) : im.path;
        let js = null;
        if (im.path[0] === 'Toybox' && resolveToyboxPath(parts)) js = parts.length ? `T.${parts.join('.')}` : 'T';
        else if (userPath(im.path)) js = userPath(im.path).js;
        else if (resolveToyboxPath(parts)) js = `T.${parts.join('.')}`;
        if (!js) {
            // Toybox modules this stand-in does not have yet: fail only if they are used
            if (im.path[0] === 'Toybox') { skippedToybox.add(im.path[1]); continue; }
            throw new TranslateError(`${im.file}:${im.line}: unknown module ${im.path.join('.')}`);
        }
        aliases.set(im.alias || im.path[im.path.length - 1], js);
        if (im.kw === 'import') opened.push(js);
    }
    const jsObj = (js) => js === 'T' ? T : js.startsWith('T.') ? resolveToyboxPath(js.slice(2).split('.')) : null;
    function openedHas(js, name) {
        if (js.startsWith('T')) { const o = jsObj(js); return o != null && name in o; }
        const u = userPath(js.split('.').slice(1));
        if (!u || u.kind !== 'module') return false;
        const s = u.scope;
        return s.classes.has(name) || s.functions.has(name) || s.vars.has(name) || s.modules.has(name);
    }

    // ------------------------------------------------ classes
    function lookupScopeChain(scope, name) {
        for (let s = scope; s; s = s.parent) {
            if (s.classes.has(name) || s.functions.has(name) || s.vars.has(name) || s.modules.has(name)) return `${s.js}.${name}`;
        }
        return null;
    }
    // A dotted type/class path -> {user decl} | {toybox path} | null
    function resolveClassPath(parts, scope) {
        const p0 = parts[0] === 'Toybox' ? null : lookupScopeChain(scope, parts[0]) || aliases.get(parts[0]) || null;
        if (p0 && p0.startsWith('G')) {
            const u = userPath([...p0.split('.').slice(1), ...parts.slice(1)]);
            if (u && u.kind === 'class') return { user: u.decl };
        }
        const tb = parts[0] === 'Toybox' ? parts.slice(1) : parts;
        if (p0 && p0.startsWith('T')) {
            const full = [...p0.split('.').slice(1), ...tb.slice(1)];
            if (resolveToyboxPath(full)) return { toybox: full };
        }
        if (resolveToyboxPath(tb)) return { toybox: tb };
        for (const js of opened) {
            if (!js.startsWith('T')) continue;
            const full = [...(js === 'T' ? [] : js.split('.').slice(1)), ...tb];
            if (resolveToyboxPath(full)) return { toybox: full };
        }
        return null;
    }
    function baseOf(cls) {
        if (!cls.ext) return { toybox: ['Lang', 'Object'] };
        const r = resolveClassPath(cls.ext, cls.scope);
        if (!r) throw new TranslateError(`${cls.file}:${cls.line}: unknown base class ${cls.ext.join('.')}`);
        if (r.user === cls) throw new TranslateError(`${cls.file}:${cls.line}: class ${cls.name} extends itself`);
        return r;
    }
    // [{decl?} | {toybox, js}] from the class itself up
    function ancestry(cls) {
        const out = [];
        let cur = cls;
        const seen = new Set();
        while (cur) {
            if (seen.has(cur)) throw new TranslateError(`${cls.file}:${cls.line}: class inheritance cycle at ${cur.name}`);
            seen.add(cur);
            out.push({ decl: cur, js: cur.js, name: cur.name });
            const b = baseOf(cur);
            if (b.user) cur = b.user;
            else {
                out.push({ toybox: b.toybox, js: `T.${b.toybox.join('.')}`, name: b.toybox[b.toybox.length - 1] });
                // Toybox's own superclasses (DataField -> View), so View.setLayout() works as a super call
                const mod = b.toybox.slice(0, -1);
                const holder = mod.length ? resolveToyboxPath(mod) : T;
                let k = resolveToyboxPath(b.toybox);
                while (k && holder && (k = Object.getPrototypeOf(k)) && k !== Function.prototype) {
                    const key = Object.keys(holder).find(n => holder[n] === k);
                    if (!key) break;
                    out.push({ toybox: [...mod, key], js: `T.${[...mod, key].join('.')}`, name: key });
                }
                cur = null;
            }
        }
        return out;
    }

    const order = [];
    const placed = new Set();
    function visit(c, stack = new Set()) {
        if (placed.has(c)) return;
        if (stack.has(c)) throw new TranslateError(`${c.file}:${c.line}: class inheritance cycle at ${c.name}`);
        stack.add(c);
        const b = baseOf(c);
        if (b.user) visit(b.user, stack);
        placed.add(c);
        order.push(c);
    }
    for (const c of allClasses) visit(c);

    // ------------------------------------------------ emit
    const out = [];
    const emit = (s) => out.push(s);
    let uid = 0;

    // Module objects, outermost first
    (function mods(s) { for (const m of s.modules.values()) { emit(`${m.js} = ${m.js} || {};`); mods(m); } })(global);

    // Module-level functions
    (function fns(s) {
        for (const f of s.functions.values()) {
            const ctx = ctxFor(s, null, f.params, true, f.file);
            emit(`${s.js}.${f.name} = function(${f.params.map(local).join(', ')}) {\n${stmts(f.body.body, ctx)}\n};`);
        }
        for (const m of s.modules.values()) fns(m);
    })(global);

    for (const c of order) {
        const b = baseOf(c);
        const baseJs = b.user ? b.user.js : `T.${b.toybox.join('.')}`;
        emit(`${c.js} = class ${c.name} extends ${baseJs} {`);
        const fctx = ctxFor(c.scope, c, [], false, c.file);
        emit(`  $initFields() {\n    super.$initFields();`);
        for (const m of c.members) {
            if (m.kind !== 'var' || m.isStatic) continue;
            fctx.file = m.file;
            emit(`    $.L=${JSON.stringify(m.file + ':' + m.line)}; this.${m.name} = ${m.init ? expr(m.init, fctx) : 'null'};`);
        }
        emit(`  }`);
        for (const m of c.members.filter(m => m.kind === 'function')) {
            const ctx = ctxFor(c.scope, c, m.params, m.isStatic, m.file);
            emit(`  ${m.isStatic ? 'static ' : ''}${m.name}(${m.params.map(local).join(', ')}) {\n${stmts(m.body.body, ctx)}\n  }`);
        }
        emit(`};`);
        emit(`${c.js}.prototype.$className = ${JSON.stringify(c.full)};`);
    }

    // Constants, then variables: module level and class statics, in source order
    const inits = [];
    (function vars(s) {
        for (const v of s.vars.values()) inits.push({ v, target: `${s.js}.${v.name}`, ctx: () => ctxFor(s, null, [], true, v.file) });
        for (const m of s.modules.values()) vars(m);
    })(global);
    for (const c of order) for (const m of c.members) if (m.isStatic && m.kind !== 'function') inits.push({ v: m, target: `${c.js}.${m.name}`, ctx: () => ctxFor(c.scope, c, [], true, m.file) });
    for (const kind of ['const', 'var']) {
        for (const it of inits) {
            if (it.v.kind !== kind) continue;
            emit(`$.L=${JSON.stringify(it.v.file + ':' + it.v.line)}; ${it.target} = ${it.v.init ? expr(it.v.init, it.ctx()) : 'null'};`);
        }
    }
    const classes = Object.fromEntries(allClasses.map(c => [c.full, c.js]));
    return { code: out.join('\n'), classes };

    // ------------------------------------------------ helpers

    function local(n) { return 'l_' + n; }

    // A Toybox module/class path, a user module/class path or a resource path: plain property access is safe
    function isPath(js) { return /^T(\.[A-Za-z_$][\w$]*)*$/.test(js) || /^G\.Rez(\.[A-Za-z_$][\w$]*)*$/.test(js) || staticPaths.has(js); }

    function ctxFor(scope, cls, params, isStatic, file) {
        const instance = new Set(), statics = new Map();
        let toyboxBase = null, anc = [];
        if (cls) {
            anc = ancestry(cls);
            for (const a of anc) {
                if (a.decl) {
                    for (const m of a.decl.members) {
                        if (m.isStatic) { if (!statics.has(m.name) && !instance.has(m.name)) statics.set(m.name, a.decl.js); }
                        else if (!statics.has(m.name)) instance.add(m.name);
                    }
                } else if (!toyboxBase) toyboxBase = resolveToyboxPath(a.toybox);
            }
        }
        return { scope, cls, isStatic, scopes: [new Set(params)], instance, statics, toyboxBase, anc, file, loops: [] };
    }

    function isLocal(ctx, n) { return ctx.scopes.some(s => s.has(n)); }

    function stmts(list, ctx) { return list.map(s => stmt(s, ctx)).join('\n'); }

    function lineMark(ctx, line) { return `$.L=${JSON.stringify(ctx.file + ':' + line)};`; }

    function stmt(s, ctx) {
        switch (s.k) {
            case 'block': {
                ctx.scopes.push(new Set());
                const body = s.body.map(x => stmt(x, ctx)).join('\n');
                ctx.scopes.pop();
                return `{\n${body}\n}`;
            }
            case 'var': {
                const parts = s.decls.map(d => {
                    const init = d.init ? expr(d.init, ctx) : 'null';
                    ctx.scopes[ctx.scopes.length - 1].add(d.name);
                    return `${local(d.name)} = ${init}`;
                });
                return `${lineMark(ctx, s.line)} let ${parts.join(', ')};`;
            }
            case 'expr': return `${lineMark(ctx, s.line)} ${expr(s.e, ctx)};`;
            case 'if':
                return `${lineMark(ctx, s.line)} if ($.b(${expr(s.cond, ctx)})) ${scoped(s.then, ctx)}${s.els ? ` else ${scoped(s.els, ctx)}` : ''}`;
            case 'for': {
                ctx.scopes.push(new Set());
                let init = '';
                if (s.init) {
                    if (s.init.k === 'var') {
                        init = 'let ' + s.init.decls.map(d => {
                            const v = d.init ? expr(d.init, ctx) : 'null';
                            ctx.scopes[ctx.scopes.length - 1].add(d.name);
                            return `${local(d.name)} = ${v}`;
                        }).join(', ');
                    } else init = expr(s.init.e, ctx);
                }
                const cond = s.cond ? `$.b(${expr(s.cond, ctx)})` : '';
                const upd = s.update ? expr(s.update, ctx) : '';
                const body = loopBody(s.body, ctx);
                ctx.scopes.pop();
                return `${lineMark(ctx, s.line)} for (${init}; ${cond}; ${upd}) ${body}`;
            }
            case 'while': return `${lineMark(ctx, s.line)} while ($.b(${expr(s.cond, ctx)})) ${loopBody(s.body, ctx)}`;
            case 'do': return `${lineMark(ctx, s.line)} do ${loopBody(s.body, ctx)} while ($.b(${expr(s.cond, ctx)}));`;
            case 'return': return `${lineMark(ctx, s.line)} return${s.e ? ' ' + expr(s.e, ctx) : ' null'};`;
            case 'break':
                if (!ctx.loops.length) throw new TranslateError(`${ctx.file}:${s.line}: break outside a loop or switch`);
                return 'break;';
            case 'continue':
                if (!ctx.loops.some(l => l === 'loop')) throw new TranslateError(`${ctx.file}:${s.line}: continue outside a loop`);
                return 'continue;';
            case 'throw': return `${lineMark(ctx, s.line)} throw ${expr(s.e, ctx)};`;
            case 'try': {
                let js = `try ${stmt(s.body, ctx)}`;
                if (s.catches.length) {
                    js += ` catch ($ex) {\n$ex = $.caught($ex);\n`;
                    s.catches.forEach((c, i) => {
                        ctx.scopes.push(new Set([c.name]));
                        const test = c.type ? `$.io($ex, ${typeRef(c.type, ctx, s.line)})` : 'true';
                        js += `${i ? 'else ' : ''}if (${test}) { let ${local(c.name)} = $ex; ${stmt(c.body, ctx)} }\n`;
                        ctx.scopes.pop();
                    });
                    js += `else throw $ex;\n}`;
                }
                if (s.fin) js += ` finally ${stmt(s.fin, ctx)}`;
                return js;
            }
            case 'switch': {
                // Monkey C compares with ==; the matching case index (default if none) drives a JS
                // switch on numbers, so fall-through and `break` behave as in Monkey C, also inside loops.
                const n = ++uid, d = `$sd${n}`, ix = `$si${n}`;
                let js = `${lineMark(ctx, s.line)} {\nconst ${d} = ${expr(s.disc, ctx)}; let ${ix} = -1;\n`;
                const tests = [];
                s.cases.forEach((c, i) => {
                    if (!c.test) return;
                    const t = c.test.k === 'caseinstanceof' ? `$.io(${d}, ${typeRef(c.test.type, ctx, c.line)})` : `$.eq(${d}, ${expr(c.test, ctx)})`;
                    tests.push(`if (${t}) ${ix} = ${i};`);
                });
                js += tests.join('\nelse ') + '\n';
                const def = s.cases.findIndex(c => !c.test);
                if (def >= 0) js += `if (${ix} < 0) ${ix} = ${def};\n`;
                js += `switch (${ix}) {\n`;
                ctx.loops.push('switch');
                s.cases.forEach((c, i) => {
                    ctx.scopes.push(new Set());
                    js += `case ${i}: {\n${c.body.map(x => stmt(x, ctx)).join('\n')}\n}\n`;
                    ctx.scopes.pop();
                });
                ctx.loops.pop();
                return js + '}\n}';
            }
        }
        throw new TranslateError(`${ctx.file}:${s.line}: unsupported statement ${s.k}`);
    }

    function loopBody(s, ctx) {
        ctx.loops.push('loop');
        const js = scoped(s, ctx);
        ctx.loops.pop();
        return js;
    }

    function scoped(s, ctx) {
        if (s.k === 'block') return stmt(s, ctx);
        ctx.scopes.push(new Set());
        const js = `{ ${stmt(s, ctx)} }`;
        ctx.scopes.pop();
        return js;
    }

    function typeRef(parts, ctx, line) {
        let p = parts[0] === 'Toybox' ? parts.slice(1) : parts;
        if (p[0] === 'Lang' && p.length === 2 && LANG_TYPES.has(p[1])) return JSON.stringify(p[1]);
        if (p.length === 1 && LANG_TYPES.has(p[0]) && !lookupScopeChain(ctx.scope, p[0])) return JSON.stringify(p[0]);
        const r = resolveClassPath(parts, ctx.scope);
        if (r && r.user) return r.user.js;
        if (r && r.toybox) return `T.${r.toybox.join('.')}`;
        throw new TranslateError(`${ctx.file}:${line ?? '?'}: unknown type ${parts.join('.')}`);
    }

    // Identifier -> JS
    function ident(name, ctx, line) {
        if (isLocal(ctx, name)) return local(name);
        if (ctx.instance.has(name)) {
            if (ctx.isStatic) throw new TranslateError(`${ctx.file}:${line}: instance member '${name}' used in a static context`);
            return `this.${name}`;
        }
        if (ctx.statics.has(name)) return `${ctx.statics.get(name)}.${name}`;
        if (!ctx.isStatic && ctx.toyboxBase && name in ctx.toyboxBase.prototype) return `this.${name}`;
        if (ctx.toyboxBase && name in ctx.toyboxBase && name !== 'prototype' && name !== 'name' && name !== 'length') {
            const a = ctx.anc.find(x => x.toybox);
            return `${a.js}.${name}`;
        }
        const sc = lookupScopeChain(ctx.scope, name);
        if (sc) return sc;
        if (aliases.has(name)) return aliases.get(name);
        if (name === 'Toybox') return 'T';
        if (name === 'Rez') return 'G.Rez';
        if (T[name]) return `T.${name}`;
        if (skippedToybox.has(name)) throw new TranslateError(`${ctx.file}:${line}: Toybox.${name} is not available in MVL Sim yet`);
        for (const js of opened) if (openedHas(js, name)) return `${js}.${name}`;
        throw new TranslateError(`${ctx.file}:${line}: unknown identifier '${name}'`);
    }

    // A static (module/class/Toybox) JS path for an expression, or null
    function staticOf(e, ctx) {
        if (e.k === 'id') {
            if (isLocal(ctx, e.name) || ctx.instance.has(e.name)) return null;
            let js;
            try { js = ident(e.name, ctx, e.line); } catch {
                // Inside a class, a superclass's own name works even when not imported
                // (using Toybox.Application as App; class A extends App.AppBase { ... AppBase.initialize(); })
                const anc = ctx.anc && ctx.anc.slice(1).find(a => a.name === e.name);
                return anc ? anc.js : null;
            }
            return isPath(js) ? js : null;
        }
        if (e.k === 'member') {
            const o = staticOf(e.obj, ctx);
            if (!o) return null;
            const js = `${o}.${e.name}`;
            return isPath(js) ? js : null;
        }
        return null;
    }

    function lvalue(t, ctx) {
        if (t.k === 'id') {
            const js = ident(t.name, ctx, t.line);
            return { get: js, set: (v) => `${js} = ${v}` };
        }
        if (t.k === 'member') {
            const o = expr(t.obj, ctx);
            if (isPath(o) || o === 'this') return { get: `${o}.${t.name}`, set: (v) => `${o}.${t.name} = ${v}` };
            return { get: `$.g(${o}, ${JSON.stringify(t.name)})`, set: (v) => `$.nn(${o}).${t.name} = ${v}` };
        }
        if (t.k === 'index') {
            const o = expr(t.obj, ctx), i = expr(t.idx, ctx);
            return { get: `$.idx(${o}, ${i})`, set: (v) => `$.setidx(${o}, ${i}, ${v})` };
        }
        throw new TranslateError(`${ctx.file}:${t.line}: invalid assignment target`);
    }

    function expr(e, ctx) {
        switch (e.k) {
            case 'num':
                if (e.isFloat) return e.isDouble ? `$.d(${e.v})` : `$.f(${e.v})`;
                if (e.isLong) return `$.long(${BigInt.asIntN(64, e.big)}n)`;
                return String(e.v | 0);
            case 'str': return JSON.stringify(e.v);
            case 'char': return `$.ch(${JSON.stringify(e.v)})`;
            case 'sym': return `$.sym(${JSON.stringify(e.v)})`;
            case 'null': return 'null';
            case 'bool': return String(e.v);
            case 'self':
                if (ctx.isStatic) throw new TranslateError(`${ctx.file}:${e.line}: self in a static context`);
                return 'this';
            case 'id': return ident(e.name, ctx, e.line);
            case 'member': {
                const st = staticOf(e.obj, ctx);
                if (st) { checkToybox(st, e.name, ctx, e.line, false); return `${st}.${e.name}`; }
                const o = expr(e.obj, ctx);
                if (isPath(o)) return `${o}.${e.name}`;
                return `$.g(${o}, ${JSON.stringify(e.name)})`;
            }
            case 'index': return `$.idx(${expr(e.obj, ctx)}, ${expr(e.idx, ctx)})`;
            case 'call': return call(e, ctx);
            case 'new': {
                const callee = staticOf(e.callee, ctx) || expr(e.callee, ctx);
                return `$.new_(${callee}, [${e.args.map(a => expr(a, ctx)).join(', ')}])`;
            }
            case 'newarr': return `$.newarr(${expr(e.size, ctx)})`;
            case 'newbytes': return `$.newbytes(${expr(e.size, ctx)})`;
            case 'arr': return `[${e.items.map(a => expr(a, ctx)).join(', ')}]`;
            case 'bytearr': return `$.bytes([${e.items.map(a => expr(a, ctx)).join(', ')}])`;
            case 'dict': return `$.dict([${e.entries.map(([k, v]) => `[${expr(k, ctx)}, ${expr(v, ctx)}]`).join(', ')}])`;
            case 'un':
                if (e.op === '-') return `$.neg(${expr(e.e, ctx)})`;
                if (e.op === '!') return `$.not(${expr(e.e, ctx)})`;
                if (e.op === '~') return `$.bnot(${expr(e.e, ctx)})`;
                break;
            case 'bin': return `$.${BIN_OPS[e.op]}(${expr(e.l, ctx)}, ${expr(e.r, ctx)})`;
            case 'logic': return `($.b(${expr(e.l, ctx)}) ${e.op} $.b(${expr(e.r, ctx)}))`;
            case 'tern': return `($.b(${expr(e.cond, ctx)}) ? ${expr(e.a, ctx)} : ${expr(e.b, ctx)})`;
            case 'instanceof': return `$.io(${expr(e.e, ctx)}, ${typeRef(e.type, ctx, e.line)})`;
            case 'has': {
                // Toybox.X has :Y / Activity.Info has :z: a missing Toybox piece is simply false
                const tb = toyboxChain(e.e, ctx);
                if (tb) { const o = resolveToyboxPath(tb); return o == null ? 'false' : `$.has(T${tb.map(p => '.' + p).join('')}, ${JSON.stringify(e.sym)})`; }
                return `$.has(${staticOf(e.e, ctx) || expr(e.e, ctx)}, ${JSON.stringify(e.sym)})`;
            }
            case 'assign': {
                const lv = lvalue(e.target, ctx);
                const v = expr(e.value, ctx);
                if (e.op === '=') return `(${lv.set(v)})`;
                return `(${lv.set(`$.${ASSIGN_OPS[e.op]}(${lv.get}, ${v})`)})`;
            }
            case 'incdec': {
                const lv = lvalue(e.target, ctx);
                const fn = e.op === '++' ? '$.add' : '$.sub';
                if (e.prefix) return `(${lv.set(`${fn}(${lv.get}, 1)`)})`;
                return `(($o) => (${lv.set(`${fn}($o, 1)`)}, $o))(${lv.get})`;
            }
            case 'seq': return e.list.map(x => expr(x, ctx)).join(', ');
        }
        throw new TranslateError(`${ctx.file}:${e.line}: unsupported expression ${e.k}`);
    }

    function call(e, ctx) {
        const args = e.args.map(a => expr(a, ctx));
        const c = e.callee;
        if (c.k === 'id') {
            if (c.name === 'method' && !isLocal(ctx, 'method') && !ctx.instance.has('method') && !ctx.isStatic) return `this.method(${args.join(', ')})`;
            const fn = ident(c.name, ctx, e.line);
            return `${fn}(${args.join(', ')})`;
        }
        if (c.k === 'member') {
            const st = staticOf(c.obj, ctx);
            // Super call: DataField.initialize() / WatchUi.DataField.initialize() inside a subclass
            if (st && !ctx.isStatic && ctx.cls) {
                const anc = ctx.anc.slice(1).find(a => a.js === st);
                if (anc) {
                    const isInstance = anc.decl
                        ? !(anc.decl.memberMap.get(c.name)?.isStatic)
                        : typeof resolveToyboxPath(anc.toybox).prototype[c.name] === 'function';
                    if (!anc.decl && !isInstance && !(c.name in resolveToyboxPath(anc.toybox))) {
                        throw new TranslateError(`${ctx.file}:${e.line}: Toybox.${anc.toybox.join('.')}.${c.name}() is not available in MVL Sim yet`);
                    }
                    if (isInstance) return `${st}.prototype.${c.name}.call(this${args.length ? ', ' + args.join(', ') : ''})`;
                }
            }
            if (st) { checkToybox(st, c.name, ctx, e.line, true); return `${st}.${c.name}(${args.join(', ')})`; }
            const o = expr(c.obj, ctx);
            if (o === 'this' || isPath(o)) return `${o}.${c.name}(${args.join(', ')})`;
            return `$.m(${o}, ${JSON.stringify(c.name)}, [${args.join(', ')}])`;
        }
        return `$.callv(${expr(c, ctx)}, [${args.join(', ')}])`;
    }
    // T path + member that the stand-in lacks: a clear error instead of undefined
    function checkToybox(st, name, ctx, line, isCall) {
        if (!/^T(.|$)/.test(st)) return;
        const o = st === 'T' ? T : resolveToyboxPath(st.slice(2).split('.'));
        if (o == null || !(name in o)) {
            throw new TranslateError(`${ctx.file}:${line}: Toybox.${st === 'T' ? '' : st.slice(2) + '.'}${name}${isCall ? '()' : ''} is not available in MVL Sim yet`);
        }
    }
    // Member chain naming a Toybox path (Toybox.X.Y, an alias of a Toybox module, an imported Toybox name)
    function toyboxChain(e, ctx) {
        if (e.k === 'id') {
            if (isLocal(ctx, e.name) || ctx.instance.has(e.name) || ctx.statics.has(e.name) || lookupScopeChain(ctx.scope, e.name)) return null;
            if (e.name === 'Toybox') return [];
            const a = aliases.get(e.name);
            if (a) return a.startsWith('T') ? (a === 'T' ? [] : a.slice(2).split('.')) : null;
            if (skippedToybox.has(e.name) || T[e.name]) return [e.name];
            return null;
        }
        if (e.k === 'member') { const p = toyboxChain(e.obj, ctx); return p ? [...p, e.name] : null; }
        return null;
    }
}
