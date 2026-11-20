// ================================================================
//  TGPlatform — wrappers around the Telegram Mini App bridge.
//
//  Storage tiers (each with a different job):
//   - CloudStorage  (Bot API 6.9+)  small values, syncs across the user's
//                   Telegram devices. Cross-device sync transport.
//   - DeviceStorage (Bot API 9.0+)  local-only, ~5 MB. Fast local cache.
//   - SecureStorage (Bot API 9.0+)  OS keychain/keystore, local-only.
//                   Holds the Master Key for instant unlock.
//
//  Every bridge call is wrapped in a timeout and a try/catch, so an
//  unsupported or unresponsive native handler degrades to a normal
//  { ok:false } result instead of hanging or throwing.
//
//  Besides storage, this module owns the Mini App "shell" integration:
//  ready()/expand(), viewport + safe-area CSS variables, Telegram theme
//  parameters, the native BackButton and app lifecycle events. All of it is
//  optional — in a plain browser, or on an old client, every call is a no-op.
// ================================================================
const TGPlatform = {
    supportsCloud: false,
    supportsSecure: false,
    supportsDevice: false,

    // Bridge calls race against this timeout. On some iOS client versions a native
    // handler can report support but never invoke its callback; without a timeout the
    // promise would hang and boot would sit on "Unlocking…" forever.
    BRIDGE_TIMEOUT_MS: 2500,

    init() {
        const wa = (window.Telegram && window.Telegram.WebApp) || null;
        const at = (v) => { try { return !!(wa && wa.isVersionAtLeast && wa.isVersionAtLeast(v)); } catch (e) { return false; } };
        try { this.supportsCloud     = !!(wa && wa.CloudStorage)     && at('6.9'); } catch (e) { this.supportsCloud = false; }
        try { this.supportsSecure    = !!(wa && wa.SecureStorage)    && at('9.0'); } catch (e) { this.supportsSecure = false; }
        try { this.supportsDevice    = !!(wa && wa.DeviceStorage)    && at('9.0'); } catch (e) { this.supportsDevice = false; }
    },

    // Generic callback -> Promise wrapper shared by all three storages. Results are
    // TRI-STATE ({ok:true,value:null} = confirmed absent, {ok:false} = call failed) so
    // callers never mistake a failed read for an empty one. A `settled` flag stops a
    // late native callback from resolving the promise a second time.
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

    // ─────────────────────────── Mini App shell ───────────────────────────
    get webApp() { return (window.Telegram && window.Telegram.WebApp) || null; },
    get inTelegram() { const wa = this.webApp; return !!(wa && (wa.initData || wa.platform && wa.platform !== 'unknown')); },
    atLeast(v) { try { const wa = this.webApp; return !!(wa && wa.isVersionAtLeast && wa.isVersionAtLeast(v)); } catch (e) { return false; } },
    /** Calls a WebApp method only if it exists; never throws. */
    _call(name, ...args) {
        try { const wa = this.webApp; if (wa && typeof wa[name] === 'function') return wa[name](...args); }
        catch (e) { DBLog.warn('Telegram', `Native call "${name}" failed.`, e); }
    },
    _on(name, fn) {
        try { const wa = this.webApp; if (wa && typeof wa.onEvent === 'function') wa.onEvent(name, fn); } catch (e) { /* unsupported event */ }
    },

    _shellReady: false,
    _themeListeners: [],

    /** Called as early as possible (before unlock) so Telegram can drop its loader
     *  and the app gets the full viewport. Safe to call more than once. */
    initApp() {
        if (this._shellReady) return;
        this._shellReady = true;
        this._applyViewport();
        this._applySafeArea();
        this._applyThemeParams();
        this._call('ready');
        this._call('expand');

        this._on('viewportChanged', () => this._applyViewport());
        this._on('safeAreaChanged', () => this._applySafeArea());
        this._on('contentSafeAreaChanged', () => this._applySafeArea());
        this._on('themeChanged', () => { this._applyThemeParams(); this._themeListeners.forEach(f => { try { f(); } catch (e) { /* listener error */ } }); });
        // Browsers without Telegram: keep --app-h in sync with the visual viewport.
        const vv = window.visualViewport;
        if (vv) vv.addEventListener('resize', () => this._applyViewport());
        window.addEventListener('resize', () => this._applyViewport());

        DBLog.info('Telegram', this.inTelegram
            ? `Mini App shell ready (platform: ${(this.webApp && this.webApp.platform) || 'unknown'}).`
            : 'Running outside Telegram. Native features are unavailable.');
    },

    /** Telegram's stable viewport height (excludes the keyboard animation) → --app-h. */
    _applyViewport() {
        const wa = this.webApp;
        let h = 0;
        if (wa && wa.viewportStableHeight > 0) h = wa.viewportStableHeight;
        else if (window.visualViewport && window.visualViewport.height > 0) h = window.visualViewport.height;
        else h = window.innerHeight;
        document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
    },

    /** Device + Telegram-UI safe areas → CSS variables (fall back to env() in CSS). */
    _applySafeArea() {
        const wa = this.webApp, root = document.documentElement.style;
        const px = (n) => (Number.isFinite(n) && n > 0 ? n : 0) + 'px';
        const dev = (wa && wa.safeAreaInset) || {}, content = (wa && wa.contentSafeAreaInset) || {};
        root.setProperty('--tg-safe-top',    px((dev.top || 0) + (content.top || 0)));
        root.setProperty('--tg-safe-bottom', px((dev.bottom || 0) + (content.bottom || 0)));
        root.setProperty('--tg-safe-left',   px((dev.left || 0) + (content.left || 0)));
        root.setProperty('--tg-safe-right',  px((dev.right || 0) + (content.right || 0)));
    },

    /** Telegram's colour scheme: 'dark' | 'light' | null when not inside Telegram. */
    colorScheme() { const wa = this.webApp; return wa && (wa.colorScheme === 'dark' || wa.colorScheme === 'light') ? wa.colorScheme : null; },

    /** Exposes Telegram's accent colour as --tg-accent (used only as an optional hint). */
    _applyThemeParams() {
        const wa = this.webApp; if (!wa || !wa.themeParams) return;
        const tp = wa.themeParams, root = document.documentElement.style;
        ['bg_color', 'text_color', 'hint_color', 'link_color', 'button_color', 'button_text_color', 'secondary_bg_color']
            .forEach(k => { if (typeof tp[k] === 'string' && /^#[0-9a-f]{3,8}$/i.test(tp[k])) root.setProperty('--tg-' + k.replace(/_/g, '-'), tp[k]); });
    },
    onThemeChanged(fn) { this._themeListeners.push(fn); },

    /** Matches Telegram's own header/background/bottom bar to the app surface so there
     *  is no coloured strip above or below the content. No-ops where unsupported. */
    syncChrome(bg) {
        if (!/^#[0-9a-f]{6}$/i.test(bg)) return;
        if (this.atLeast('6.1')) { this._call('setHeaderColor', bg); this._call('setBackgroundColor', bg); }
        if (this.atLeast('7.10')) this._call('setBottomBarColor', bg);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', bg);
    },

    // Native BackButton (Bot API 6.1+). `handler` closes the top-most overlay.
    _backHandler: null, _backVisible: false,
    setBackButton(visible, handler) {
        const wa = this.webApp; if (!wa || !wa.BackButton || !this.atLeast('6.1')) return;
        try {
            if (handler && handler !== this._backHandler) {
                if (this._backHandler) wa.BackButton.offClick(this._backHandler);
                wa.BackButton.onClick(handler); this._backHandler = handler;
            }
            if (visible !== this._backVisible) { this._backVisible = visible; visible ? wa.BackButton.show() : wa.BackButton.hide(); }
        } catch (e) { DBLog.warn('Telegram', 'BackButton is unavailable.', e); }
    },

    /** Lifecycle: `activated` (Bot API 8.0) plus the standard visibilitychange. */
    onResume(fn) {
        let last = 0;
        const fire = () => { const now = Date.now(); if (now - last < 400) return; last = now; try { fn(); } catch (e) { DBLog.error('App', 'Resume handler failed.', e); } };
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fire(); });
        this._on('activated', fire);
    },
};
