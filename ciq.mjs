// Finds the user's own Connect IQ installation: SDK, device files, fonts and the developer key.
// Nothing from Garmin is shipped with MVL Sim; everything is read from these folders.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

export const IS_WIN = platform() === 'win32';

// Connect IQ's data folder (SDK Manager downloads SDKs, devices and fonts here)
export function defaultCiqRoot() {
    if (IS_WIN) return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Garmin', 'ConnectIQ');
    if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Garmin', 'ConnectIQ');
    return join(homedir(), '.Garmin', 'ConnectIQ');
}

export class Ciq {
    // opts: { ciq, sdk, key } (all optional; from command line / config / environment)
    constructor(opts = {}) {
        this.root = resolve(opts.ciq || defaultCiqRoot());
        this.devices = join(this.root, 'Devices');
        this.fonts = join(this.root, 'Fonts');
        this.sdkOverride = opts.sdk ? resolve(opts.sdk) : null;
        this.keyOverride = opts.key ? resolve(opts.key) : null;
        this._defaultJungle = null;
    }

    // The active SDK: --sdk, else current-sdk.cfg (written by the SDK Manager), else the newest in Sdks/
    sdk() {
        if (this.sdkOverride) return this.sdkOverride;
        const cfg = join(this.root, 'current-sdk.cfg');
        if (existsSync(cfg)) {
            const p = readFileSync(cfg, 'utf8').trim();
            if (p && existsSync(p)) return resolve(p);
        }
        const dir = join(this.root, 'Sdks');
        if (existsSync(dir)) {
            const all = readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory()).sort();
            if (all.length) return join(dir, all[all.length - 1]);
        }
        return null;
    }

    monkeyc() {
        const sdk = this.sdk();
        if (!sdk) return null;
        const p = join(sdk, 'bin', IS_WIN ? 'monkeyc.bat' : 'monkeyc');
        return existsSync(p) ? p : null;
    }

    // Developer key for the compile check: --key / MVL_SIM_KEY / config, else the one the
    // Monkey C VS Code extension is set up with (monkeyC.developerKeyPath in the user settings).
    key() {
        if (this.keyOverride) return { path: this.keyOverride, from: 'configured' };
        for (const s of vscodeSettingsFiles()) {
            if (!existsSync(s)) continue;
            try {
                const m = /"monkeyC\.developerKeyPath"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(readFileSync(s, 'utf8'));
                if (m) return { path: JSON.parse(`"${m[1]}"`), from: s };
            } catch { /* unreadable settings */ }
        }
        return null;
    }

    // Installed devices: [{ id, name }] (name from compiler.json's displayName)
    listDevices() {
        if (this._devices) return this._devices;
        let ids = [];
        try { ids = readdirSync(this.devices).filter(d => /^[\w-]+$/.test(d) && existsSync(join(this.devices, d, 'simulator.json'))); } catch { /* none */ }
        this._devices = ids.map(id => {
            let name = id;
            try { name = JSON.parse(readFileSync(join(this.devices, id, 'compiler.json'), 'utf8')).displayName || id; } catch { /* keep id */ }
            return { id, name };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return this._devices;
    }

    hasDevice(id) { return /^[\w-]+$/.test(id) && existsSync(join(this.devices, id, 'simulator.json')); }

    deviceFiles(id) {
        if (!/^[\w-]+$/.test(id)) throw new Error('bad device id');
        const dir = join(this.devices, id);
        if (!existsSync(join(dir, 'simulator.json'))) {
            throw new Error(`Device files for "${id}" are not installed (${dir}). Install the device with the Connect IQ SDK Manager.`);
        }
        const sim = JSON.parse(readFileSync(join(dir, 'simulator.json'), 'utf8'));
        const compiler = existsSync(join(dir, 'compiler.json')) ? JSON.parse(readFileSync(join(dir, 'compiler.json'), 'utf8')) : {};
        return { sim, compiler };
    }

    // The SDK's default.jungle (qualifier chain per device and language), as text
    defaultJungle() {
        if (this._defaultJungle !== null) return this._defaultJungle;
        const sdk = this.sdk();
        const p = sdk ? join(sdk, 'bin', 'default.jungle') : null;
        this._defaultJungle = p && existsSync(p) ? readFileSync(p, 'utf8') : '';
        return this._defaultJungle;
    }

    fontFile(name) {
        // name without extension; .ttf only (Garmin .cft fonts are not rendered)
        const p = join(this.fonts, name + '.ttf');
        return existsSync(p) ? p : null;
    }

    summary() {
        const key = this.key();
        return { ciq: this.root, ciqFound: existsSync(this.root), sdk: this.sdk(), monkeyc: this.monkeyc(),
            key: key ? key.path : null, keyFrom: key ? key.from : null, keyExists: key ? existsSync(key.path) : false };
    }
}

function vscodeSettingsFiles() {
    const flavours = ['Code', 'Code - Insiders', 'VSCodium'];
    let base;
    if (IS_WIN) base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    else if (platform() === 'darwin') base = join(homedir(), 'Library', 'Application Support');
    else base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return flavours.map(f => join(base, f, 'User', 'settings.json'));
}
