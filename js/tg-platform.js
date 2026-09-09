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

    // ── v8.0 FIX (infinite "Unlocking…" on iOS) ──────────────────────────
    // CloudStorage/DeviceStorage/SecureStorage calls only ever resolved when
    // Telegram's native bridge actually invoked our callback. SecureStorage
    // and DeviceStorage are newer APIs (Bot API 9.0) and on some iOS client
    // versions `isVersionAtLeast('9.0')` can report true while the native
    // handler for that specific method never calls back — the Promise then
    // hangs forever, and since boot()'s very first await is
    // `_readMKAnywhere()` -> `secureGet('mk')`, the whole app got stuck on
    // the "Unlocking…" screen with no way out. Every bridge call below now
    // races against this timeout, so a dead callback resolves as a normal
    // `{ ok:false, error:'bridge_timeout' }` instead of hanging, letting the
    // existing retry / degraded-mode logic in EncryptionManager take over.
    BRIDGE_TIMEOUT_MS: 2500,

    init() {
        const wa = (window.Telegram && window.Telegram.WebApp) || null;
        const at = (v) => { try { return !!(wa && wa.isVersionAtLeast && wa.isVersionAtLeast(v)); } catch (e) { return false; } };
        try { this.supportsCloud     = !!(wa && wa.CloudStorage)     && at('6.9'); } catch (e) { this.supportsCloud = false; }
        try { this.supportsSecure    = !!(wa && wa.SecureStorage)    && at('9.0'); } catch (e) { this.supportsSecure = false; }
        try { this.supportsDevice    = !!(wa && wa.DeviceStorage)    && at('9.0'); } catch (e) { this.supportsDevice = false; }
    },

    // ── Generic callback->Promise wrapper shared by all three storages.
    // Returns a TRI-STATE result so callers can tell "key genuinely absent"
    // apart from "the call failed" — conflating those two was the root
    // cause of a real data-loss bug in v5 (see EncryptionManager below).
    // Shared guard: starts a timer alongside the native call and whichever
    // settles first wins. A `settled` flag stops a late-arriving native
    // callback (one that finally fires *after* we already gave up) from
    // double-resolving the promise or clobbering a result we already handed
    // back to the caller.
    _withTimeout(executor) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };
            const timer = setTimeout(() => finish({ ok: false, error: 'bridge_timeout' }), this.BRIDGE_TIMEOUT_MS);
            try { executor(finish); }
            catch (e) { finish({ ok: false, error: e }); }
        });
    },
    _wrapGet(api, key) {
        return this._withTimeout((finish) => {
            api.getItem(key, (err, value) => {
                if (err) return finish({ ok: false, error: err });
                const present = value !== null && value !== undefined && value !== '';
                finish({ ok: true, value: present ? value : null });
            });
        });
    },
    _wrapSet(api, key, value) {
        return this._withTimeout((finish) => {
            api.setItem(key, value, (err) => finish({ ok: !err, error: err || null }));
        });
    },
    _wrapRemove(api, key) {
        return this._withTimeout((finish) => {
            api.removeItem(key, (err) => finish({ ok: !err, error: err || null }));
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
        return this._withTimeout((finish) => {
            const ss = window.Telegram.WebApp.SecureStorage;
            if (typeof ss.restoreKey !== 'function') return finish({ ok: false, error: 'unsupported' });
            ss.restoreKey(key, (err, value) => {
                if (err) return finish({ ok: false, error: err });
                finish({ ok: true, value: value || null });
            });
        });
    },
};


