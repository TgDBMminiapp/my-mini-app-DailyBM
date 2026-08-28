// ================================================================
//  TGPlatform — thin wrappers around Telegram Mini App storage APIs.
//
//  Three storage tiers, each with a different job:
//   - CloudStorage   (Bot API 6.9+) small, ~4KB/value, syncs across
//                     every device signed into the same Telegram account.
//                     Used as the cross-device sync transport.
//   - DeviceStorage   (Bot API 9.0+) up to ~5MB/bot/user, persistent,
//                     LOCAL only (no cross-device sync). Used as the
//                     fast local cache + offline buffer.
//   - SecureStorage   (Bot API 9.0+) OS Keychain/Keystore-backed,
//                     10 slots/user, LOCAL only. Used to hold the
//                     Master Key so unlock is instant on return visits.
//
//  NOTE FOR THE DEVELOPER: SecureStorage/DeviceStorage are newer APIs
//  (Bot API 9.0, April 2025). The exact method names below follow the
//  same shape as the long-stable CloudStorage API (setItem/getItem/
//  removeItem/clear), which is how Telegram's own docs describe them,
//  but you should diff this against your installed telegram-web-app.js
//  /@types/telegram-web-app the first time you deploy — every call is
//  wrapped in try/catch with graceful fallback, so a name mismatch
//  degrades safely instead of breaking the app.
// ================================================================
const TGPlatform = {
    supportsCloud: false,
    supportsSecure: false,
    supportsDevice: false,
    supportsBiometric: false,

    init() {
        const wa = (window.Telegram && window.Telegram.WebApp) || null;
        const at = (v) => { try { return !!(wa && wa.isVersionAtLeast && wa.isVersionAtLeast(v)); } catch (e) { return false; } };
        try { this.supportsCloud     = !!(wa && wa.CloudStorage)     && at('6.9'); } catch (e) { this.supportsCloud = false; }
        try { this.supportsSecure    = !!(wa && wa.SecureStorage)    && at('9.0'); } catch (e) { this.supportsSecure = false; }
        try { this.supportsDevice    = !!(wa && wa.DeviceStorage)    && at('9.0'); } catch (e) { this.supportsDevice = false; }
        try { this.supportsBiometric = !!(wa && wa.BiometricManager) && at('7.2'); } catch (e) { this.supportsBiometric = false; }
    },

    // ── Generic callback->Promise wrapper shared by all three storages.
    // Returns a TRI-STATE result so callers can tell "key genuinely absent"
    // apart from "the call failed" — conflating those two was the root
    // cause of a real data-loss bug in v5 (see EncryptionManager below).
    _wrapGet(api, key) {
        return new Promise((resolve) => {
            try {
                api.getItem(key, (err, value) => {
                    if (err) return resolve({ ok: false, error: err });
                    const present = value !== null && value !== undefined && value !== '';
                    resolve({ ok: true, value: present ? value : null });
                });
            } catch (e) { resolve({ ok: false, error: e }); }
        });
    },
    _wrapSet(api, key, value) {
        return new Promise((resolve) => {
            try { api.setItem(key, value, (err) => resolve({ ok: !err, error: err || null })); }
            catch (e) { resolve({ ok: false, error: e }); }
        });
    },
    _wrapRemove(api, key) {
        return new Promise((resolve) => {
            try { api.removeItem(key, (err) => resolve({ ok: !err, error: err || null })); }
            catch (e) { resolve({ ok: false, error: e }); }
        });
    },

    cloudGet(key)        { return this._wrapGet(window.Telegram.WebApp.CloudStorage, key); },
    cloudSet(key, value) { return this._wrapSet(window.Telegram.WebApp.CloudStorage, key, value); },
    cloudRemove(key)     { return this._wrapRemove(window.Telegram.WebApp.CloudStorage, key); },

    deviceGet(key)        { return this._wrapGet(window.Telegram.WebApp.DeviceStorage, key); },
    deviceSet(key, value) { return this._wrapSet(window.Telegram.WebApp.DeviceStorage, key, value); },
    deviceRemove(key)     { return this._wrapRemove(window.Telegram.WebApp.DeviceStorage, key); },

    secureGet(key)        { return this._wrapGet(window.Telegram.WebApp.SecureStorage, key); },
    secureSet(key, value) { return this._wrapSet(window.Telegram.WebApp.SecureStorage, key, value); },
    secureRemove(key)     { return this._wrapRemove(window.Telegram.WebApp.SecureStorage, key); },
    // restoreKey: lets the user explicitly re-grant access to a SecureStorage
    // value that existed on this device before (e.g. after a fresh install).
    secureRestore(key) {
        return new Promise((resolve) => {
            try {
                const ss = window.Telegram.WebApp.SecureStorage;
                if (typeof ss.restoreKey !== 'function') return resolve({ ok: false, error: 'unsupported' });
                ss.restoreKey(key, (err, value) => {
                    if (err) return resolve({ ok: false, error: err });
                    resolve({ ok: true, value: value || null });
                });
            } catch (e) { resolve({ ok: false, error: e }); }
        });
    },

    // ── Biometric gate (optional extra "App Lock" layer, not the primary
    // key-retrieval mechanism — SecureStorage already handles that).
    biometricAvailable() {
        try {
            const bm = window.Telegram.WebApp.BiometricManager;
            return !!(bm && bm.isInited && bm.isBiometricAvailable);
        } catch (e) { return false; }
    },
    biometricInit() {
        return new Promise((resolve) => {
            try {
                const bm = window.Telegram.WebApp.BiometricManager;
                if (bm.isInited) return resolve(true);
                bm.init(() => resolve(true));
            } catch (e) { resolve(false); }
        });
    },
    biometricAuthenticate(reason) {
        return new Promise((resolve) => {
            try {
                window.Telegram.WebApp.BiometricManager.authenticate({ reason: reason || '' }, (success) => resolve(!!success));
            } catch (e) { resolve(false); }
        });
    },
};


