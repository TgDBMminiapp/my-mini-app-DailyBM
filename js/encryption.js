// @ts-check
// ================================================================
//  ENCRYPTION MANAGER v7 — "zero-friction" Master-Key architecture.
//
//  ── WHY v6 WAS REPLACED ──
//  v6 introduced a random Master Key (MK) + recovery code, which was
//  the right cryptographic shape, but the BOOT flow around it grew
//  into five separate tiers (Welcome → Show Recovery → Enter Recovery
//  → Migrate v5 → Legacy Password → Error), each independently
//  deciding what to show. Two concrete bugs came directly from that:
//
//   BUG A — "brand-new account is asked for a password/recovery code":
//     boot() treated ANY non-ok CloudStorage read (including a slow
//     first read right after the Mini App opens, before Telegram has
//     finished warming up CloudStorage) as "ambiguous" and jumped
//     straight to a blocking error / credential screen instead of
//     just retrying. A transient hiccup on the very first launch was
//     indistinguishable, to the old code, from "we can't tell if this
//     is a new or existing account" — so it played it "safe" by
//     asking the user for something that never existed.
//
//   BUG B — "new device asks for the recovery code again next time":
//     unlockWithRecoveryCode() wrote the freshly-recovered MK with
//     `if (supportsSecure) TGPlatform.secureSet('mk', mkB64)` and NEVER
//     checked whether that write actually succeeded, and never wrote
//     a fallback copy anywhere else. If that single SecureStorage
//     write silently failed (quota, OS keychain prompt dismissed,
//     older client, etc.) there was no second copy anywhere on the
//     device, so next launch's Tier-1 check found nothing local and
//     fell right back to "enter your recovery code" — forever.
//
//  ── v7 DESIGN ──
//  Same crypto as v6 (untouched, still correct): one random 256-bit
//  AES-256-GCM Master Key per account, generated once with
//  crypto.getRandomValues, that never leaves the device in plaintext.
//    • CloudStorage  — stores ONLY: an encrypted sentinel + a
//      recovery-code-wrapped copy of the MK. Syncs per Telegram
//      account, so it is what lets a genuinely new device discover
//      "yes, this account already has a vault".
//    • SecureStorage — OS Keychain/Keystore, per-device. Primary home
//      for the plaintext-to-Telegram (but still just ciphertext bytes
//      to us) MK so unlock is instant with no server round-trip.
//    • DeviceStorage / localStorage — best-effort SECOND and THIRD
//      copies of the same MK on the same device. Purely a durability
//      hedge: `_persistMKEverywhere()` writes to every tier available
//      and verifies each write by reading it back, so a single failed
//      write (BUG B) can no longer strand the user.
//
//  Only TWO situations ever show the person something to do:
//    1. First-ever run of a brand-new account → we generate the vault
//       SILENTLY and unlock immediately, then show a dismissible,
//       one-time "here's your recovery code, save it" notice. This is
//       informational, not a gate — the app underneath is already
//       unlocked.
//    2. A genuinely new device on an account that already has a vault
//       (CloudStorage confirms a recovery blob exists, but nothing is
//       stored locally) → the recovery-code screen. This is the only
//       real "credential" prompt left in the whole app.
//  Every other combination — returning device, temporarily offline,
//  SecureStorage unsupported, etc. — is resolved automatically:
//    • Ambiguous/failed cloud or secure reads are retried with a short
//      backoff (`_withRetries`) before anything is decided.
//    • If still unreachable after retries, v7 does NOT block the
//      person behind an error screen by default — it degrades to a
//      local-only vault (generated + stored in whatever local tier IS
//      available) and quietly retries publishing the cloud recovery
//      blob on a timer / on next boot, only surfacing the error screen
//      if even local storage is unusable.
//    • Existing v5 (password-only) and v6 (already-migrated) accounts
//      keep working exactly as before — the legacy/migration paths are
//      preserved verbatim, just re-ordered so they only ever trigger
//      for accounts that genuinely have that history.
// ================================================================
const SENTINEL_NEW    = 'DBMIX_V6_OK';       // shared sentinel value, unchanged since v6 so
const SENTINEL_LEGACY = 'DAILYBOOKMIX_V5';   // existing encrypted data keeps decrypting fine.

const EncryptionManager = {
    _key: null,              // CryptoKey actually used to encrypt/decrypt app data
    _rawMK: null,             // base64 Master Key, kept in memory only for the lifetime of
                               // this session so "generate a new recovery code" doesn't need
                               // to ask the user to re-authenticate. Never persisted as-is.
    _pendingMK: null,        // base64 MK generated during silent vault creation, shown on
                             // the one-time recovery-code notice but not yet acknowledged.
    _pendingRecoveryCode: null,
    _offlineMode: false,     // true once we've decided to proceed without cloud confirmation
    _localOnlyFallback: false, // true when running with zero Telegram storage APIs at all

    // ---------- low-level primitives (AES-256-GCM — unchanged from v6/v5) ----------
    // v5 used 200,000 PBKDF2 iterations; v6+ raises new wraps to 600,000 (current
    // OWASP guidance). Migration must derive with the ORIGINAL count to match
    // already-encrypted v5 data -- changing it would silently produce a
    // different key and make all existing notes/tasks undecryptable.
    LEGACY_ITERATIONS: 200000,
    CURRENT_ITERATIONS: 600000,
    async _deriveFromSecret(secret, salt, extractable = false, iterations = this.CURRENT_ITERATIONS) {
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            extractable, ['encrypt', 'decrypt']
        );
    },
    async _importMK(mkB64) {
        return crypto.subtle.importKey('raw', Util.b64decode(mkB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
    async _encryptWithKey(key, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
        return Util.b64encode(iv.buffer) + ':' + Util.b64encode(cipher);
    },
    async _decryptWithKey(key, payload) {
        const parts = payload.split(':');
        const iv = Util.b64decode(parts[0]);
        const data = Util.b64decode(parts.slice(1).join(':'));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
        return new TextDecoder().decode(plain);
    },
    // Public encrypt/decrypt used by StorageManager for ALL app data — operate
    // on `this._key`, whichever unlock path produced it.
    async encrypt(plaintext) {
        if (!this._key) return plaintext;
        return this._encryptWithKey(this._key, plaintext);
    },
    async decrypt(ciphertext) {
        if (!this._key) return ciphertext;
        try {
            if (typeof ciphertext !== 'string' || !ciphertext.includes(':')) return ciphertext; // not encrypted
            return await this._decryptWithKey(this._key, ciphertext);
        } catch (e) { return ciphertext; }
    },

    // ---------- small retry helper: turns "one flaky read" into a real answer ----------
    // Runs `fn` up to `tries` times with short backoff, and only treats the result
    // as "confirmed unreachable" after every attempt failed. This directly fixes
    // BUG A: a single slow/late CloudStorage response on cold start no longer gets
    // misread as "we can't tell, better ask for credentials".
    async _withRetries(fn, tries = 3, delayMs = 350) {
        let last = { ok: false, value: null };
        for (let i = 0; i < tries; i++) {
            last = await fn();
            if (last.ok) return last;
            if (i < tries - 1) await Util.sleep(delayMs * (i + 1));
        }
        return last;
    },

    // ---------- write the MK to every available local tier, and VERIFY each write ----------
    // This is the direct fix for BUG B. Previously only SecureStorage was written,
    // and its result was never checked. Now we write to all local tiers we have
    // and read each one back before trusting it — a single failed tier can no
    // longer strand the person on "enter your recovery code" forever.
    async _persistMKEverywhere(mkB64) {
        const results = { secure: false, device: false, local: false };
        if (TGPlatform.supportsSecure) {
            const w = await TGPlatform.secureSet('mk', mkB64);
            if (w.ok) {
                const r = await TGPlatform.secureGet('mk');
                results.secure = r.ok && r.value === mkB64;
            }
        }
        if (TGPlatform.supportsDevice) {
            const w = await TGPlatform.deviceSet('mk', mkB64);
            if (w.ok) {
                const r = await TGPlatform.deviceGet('mk');
                results.device = r.ok && r.value === mkB64;
            }
        }
        try {
            localStorage.setItem('dbmix_mk', mkB64);
            results.local = localStorage.getItem('dbmix_mk') === mkB64;
        } catch (e) { results.local = false; }
        // At least one durable local copy is enough for instant unlock next time.
        return results.secure || results.device || results.local;
    },

    // Reads the MK back from whichever local tier has it, preferring the most
    // secure one first. Mirrors _persistMKEverywhere's write order.
    async _readMKAnywhere() {
        if (TGPlatform.supportsSecure) {
            let r = await TGPlatform.secureGet('mk');
            if (!r.ok) {
                const restored = await TGPlatform.secureRestore('mk');
                if (restored.ok && restored.value) r = restored;
            }
            if (r.ok && r.value) return r.value;
        }
        if (TGPlatform.supportsDevice) {
            const r = await TGPlatform.deviceGet('mk');
            if (r.ok && r.value) return r.value;
        }
        try {
            const v = localStorage.getItem('dbmix_mk');
            if (v) return v;
        } catch (e) {}
        return null;
    },

    // ---------- boot: the entire new decision tree lives here ----------
    async boot() {
        TGPlatform.init();
        this._showScreen('lockScreenChecking');

        // ── Case 1: returning device — an MK already lives somewhere local. ──
        // Zero-friction path: no network needed, no screen shown beyond the
        // instant "Unlocking…" flash.
        const localMK = await this._readMKAnywhere();
        if (localMK) {
            if (await this._finishUnlockWithMK(localMK)) return;
            // Corrupted/mismatched local copy — fall through and treat as absent.
        }

        // ── No Telegram storage APIs at all (old client, or testing outside
        // Telegram in a plain browser). Everything stays device-local. ──
        if (!TGPlatform.supportsSecure && !TGPlatform.supportsCloud && !TGPlatform.supportsDevice) {
            return this._bootLocalOnlyFallback();
        }

        // ── Case 2 vs. brand-new account: ask CloudStorage (with retries, so a
        // single slow/late response can't masquerade as "unknown"). ──
        if (TGPlatform.supportsCloud) {
            const rec = await this._withRetries(() => TGPlatform.cloudGet('enc_mk_recovery'));
            if (rec.ok) {
                if (rec.value) {
                    // Confirmed: this account has a vault, just not on this device yet.
                    this._showScreen('lockScreenEnterRecovery');
                    return;
                }
                // Confirmed absent in the cloud too — check for an old v5 (password-only)
                // account before concluding this is truly brand new.
                const legacy = await this._checkLegacyV5();
                if (legacy.state === 'found') { this._showScreen('lockScreenMigrate'); return; }
                if (legacy.state !== 'error') {
                    // Confirmed on every reachable tier: nothing anywhere. Create the
                    // vault silently — never show a screen asking for something that
                    // was never set.
                    return this._silentCreateVault();
                }
            }
            // Cloud genuinely unreachable after retries — do not block the person on a
            // credential screen. Degrade gracefully: work locally now, keep trying to
            // reconcile with the cloud in the background.
            return this._bootDegraded();
        }

        // CloudStorage unsupported but Secure/Device storage is: still confirmed
        // brand-new on this device with no way to check other devices — safe to
        // create locally (this device just won't cross-sync yet).
        return this._silentCreateVault();
    },

    async _checkLegacyV5() {
        if (TGPlatform.supportsCloud) {
            const r = await this._withRetries(() => TGPlatform.cloudGet('dbmix_salt'));
            if (r.ok) {
                if (r.value) return { state: 'found', saltB64: r.value };
                // confirmed absent in cloud — still check local before declaring "none"
            } else {
                return { state: 'error' };
            }
        }
        try {
            const local = localStorage.getItem('dbmix_salt');
            if (local) return { state: 'found', saltB64: local };
        } catch (e) {}
        return { state: 'absent' };
    },

    // ---------- brand-new account: create the vault with zero taps ----------
    async _silentCreateVault() {
        try {
            const mkB64 = Util.b64encode(crypto.getRandomValues(new Uint8Array(32)).buffer);
            this._key = await this._importMK(mkB64);

            const code = Util.generateRecoveryCode();
            this._pendingRecoveryCode = code;
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const wrapKey = await this._deriveFromSecret(Util.normalizeRecoveryCode(code), salt);
            const wrapped = await this._encryptWithKey(wrapKey, mkB64);

            if (TGPlatform.supportsCloud) {
                await TGPlatform.cloudSet('recovery_salt', Util.b64encode(salt.buffer));
                await TGPlatform.cloudSet('enc_mk_recovery', wrapped);
                const enc = await this.encrypt(SENTINEL_NEW);
                await TGPlatform.cloudSet('dbmix_sentinel', enc);
            }
            await this._persistMKEverywhere(mkB64);
            this._rawMK = mkB64;
            this._pendingMK = mkB64;

            // Unlock the app content immediately — the recovery-code notice below is
            // informational, layered on TOP of an already-unlocked app, not a gate.
            await this._enterApp();
            this._presentRecoveryNotice(code);
        } catch (e) {
            console.error('[EncryptionManager] _silentCreateVault failed:', e);
            // Even vault creation failing shouldn't lock the person out of their own
            // fresh, empty journal — fall back to a purely local vault.
            return this._bootLocalOnlyFallback();
        }
    },

    // Shows the one-time "save your recovery code" notice on top of the already-
    // unlocked app. Does not block data access; closing/continuing just dismisses it.
    _presentRecoveryNotice(code) {
        const disp = document.getElementById('recoveryCodeDisplay');
        if (disp) disp.textContent = code;
        const check = document.getElementById('recoverySavedCheck');
        if (check) check.checked = false;
        this.onRecoveryCheckChanged();
        document.getElementById('encryptionLock').classList.add('open');
        this._showScreen('lockScreenShowRecovery');
    },

    // ---------- cloud confirmed unreachable after retries: degrade, don't block ----------
    async _bootDegraded() {
        this._offlineMode = true;
        // We genuinely cannot tell "brand new" from "existing account on another
        // device" right now. The safest, least-annoying choice is to let the person
        // keep using the app locally with a freshly-generated device vault, and
        // reconcile with the cloud automatically once it's reachable again — rather
        // than blocking them behind a credential prompt for a credential that may
        // not even exist. We never delete or overwrite any existing cloud recovery
        // blob here, so if they do have real cloud data, reconciliation (or a
        // normal retry once connectivity returns) will find it rather than lose it.
        const mkB64 = Util.b64encode(crypto.getRandomValues(new Uint8Array(32)).buffer);
        this._key = await this._importMK(mkB64);
        await this._persistMKEverywhere(mkB64);
        this._rawMK = mkB64;
        await this._enterApp();
        this._showToastOnApp(
            (typeof diary !== 'undefined' && diary.lang === 'ru')
                ? '⚠️ Работаем офлайн — синхронизация возобновится при подключении'
                : '⚠️ Working offline — sync will resume once reconnected'
        );
        this._scheduleCloudReconcile();
    },

    // Periodically retries publishing this device's recovery blob to the cloud
    // once connectivity/CloudStorage comes back, so a temporary outage during
    // first launch doesn't permanently prevent multi-device sync from working.
    _scheduleCloudReconcile() {
        if (this._reconcileTimer) return;
        this._reconcileTimer = setInterval(async () => {
            if (!TGPlatform.supportsCloud || !this._rawMK) return;
            const rec = await TGPlatform.cloudGet('enc_mk_recovery');
            if (rec.ok && !rec.value) {
                // Cloud is reachable now and confirmed still empty — publish this
                // device's vault so other devices can recover it.
                const code = Util.generateRecoveryCode();
                const salt = crypto.getRandomValues(new Uint8Array(16));
                const wrapKey = await this._deriveFromSecret(Util.normalizeRecoveryCode(code), salt);
                const wrapped = await this._encryptWithKey(wrapKey, this._rawMK);
                await TGPlatform.cloudSet('recovery_salt', Util.b64encode(salt.buffer));
                await TGPlatform.cloudSet('enc_mk_recovery', wrapped);
                const enc = await this.encrypt(SENTINEL_NEW);
                await TGPlatform.cloudSet('dbmix_sentinel', enc);
                this._offlineMode = false;
                clearInterval(this._reconcileTimer);
                this._reconcileTimer = null;
                this._pendingRecoveryCode = code;
                this._presentRecoveryNotice(code);
            } else if (rec.ok && rec.value) {
                // Cloud came back AND another device already published a vault first —
                // stop retrying; this device keeps working with its own local vault
                // (already-encrypted local data stays readable), and the person can
                // switch to the cloud vault later via Sidebar → Backup & recovery if
                // they explicitly want to.
                this._offlineMode = false;
                clearInterval(this._reconcileTimer);
                this._reconcileTimer = null;
            }
        }, 20000);
    },

    // ---------- zero Telegram storage APIs available (old client / plain browser) ----------
    async _bootLocalOnlyFallback() {
        this._localOnlyFallback = true;
        // An existing password-protected local vault takes priority — that's a
        // real credential the person actually set, so it's fine to ask for it.
        let saltB64 = null;
        try { saltB64 = localStorage.getItem('dbmix_salt'); } catch (e) {}
        if (saltB64) {
            let cachedPw = null;
            try { cachedPw = localStorage.getItem('dbmix_pw'); } catch (e) {}
            if (cachedPw && await this._legacyTryUnlock(cachedPw)) return;
            this._showScreen('lockScreenLegacyPassword');
            return;
        }
        // No existing vault of any kind on this device/browser — generate a random
        // key and keep it in localStorage directly. There is nothing to type: data
        // never leaves this browser anyway when Telegram storage is unavailable, so
        // a typed password would add friction without adding real security.
        try {
            const mkB64 = Util.b64encode(crypto.getRandomValues(new Uint8Array(32)).buffer);
            this._key = await this._importMK(mkB64);
            localStorage.setItem('dbmix_mk', mkB64);
            this._rawMK = mkB64;
            const enc = await this.encrypt(SENTINEL_NEW);
            localStorage.setItem('dbmix_sentinel', enc);
            await this._enterApp();
        } catch (e) {
            console.error('[EncryptionManager] local-only fallback failed:', e);
            this._showBlockingError();
        }
    },

    async _finishUnlockWithMK(mkB64) {
        try {
            this._key = await this._importMK(mkB64);
            const ok = await this._verifySentinelOrCreate();
            if (!ok) { this._key = null; return false; }
            this._rawMK = mkB64;
            // Make sure every tier has this MK — cheap no-op if they already do,
            // but heals a device that previously only had a partial write.
            await this._persistMKEverywhere(mkB64);
            await this._enterApp();
            return true;
        } catch (e) { this._key = null; return false; }
    },

    // Tri-state sentinel check: cloud wins when reachable, device cache as
    // fallback. Only fabricates a fresh sentinel when absence is CONFIRMED on
    // every reachable layer (with retries) — this avoids a transient CloudStorage
    // error silently creating a brand-new identity and orphaning existing data.
    async _verifySentinelOrCreate() {
        let sentinel = null, ambiguous = false;
        if (TGPlatform.supportsCloud) {
            const r = await this._withRetries(() => TGPlatform.cloudGet('dbmix_sentinel'), 2);
            if (r.ok) sentinel = r.value; else ambiguous = true;
        }
        if (!sentinel && TGPlatform.supportsDevice) {
            const r2 = await TGPlatform.deviceGet('dbmix_sentinel');
            if (r2.ok && r2.value) sentinel = r2.value;
        }
        if (!sentinel) { try { const l = localStorage.getItem('dbmix_sentinel'); if (l) sentinel = l; } catch (e) {} }
        if (sentinel) {
            const dec = await this.decrypt(sentinel);
            return dec === SENTINEL_NEW || dec === SENTINEL_LEGACY;
        }
        if (ambiguous) return false; // do NOT fabricate a new identity on uncertainty
        const enc = await this.encrypt(SENTINEL_NEW);
        if (TGPlatform.supportsCloud) await TGPlatform.cloudSet('dbmix_sentinel', enc);
        if (TGPlatform.supportsDevice) await TGPlatform.deviceSet('dbmix_sentinel', enc);
        try { localStorage.setItem('dbmix_sentinel', enc); } catch (e) {}
        return true;
    },

    async _enterApp() {
        document.getElementById('encryptionLock').classList.remove('open');
        document.getElementById('appContent').style.display = 'block';
        await diary.init();
    },

    _showToastOnApp(msg) {
        try {
            if (typeof diary !== 'undefined' && typeof diary.toast === 'function') diary.toast(msg);
        } catch (e) {}
    },

    onRecoveryCheckChanged() {
        const check = document.getElementById('recoverySavedCheck');
        const btn = document.getElementById('recoveryContinueBtn');
        if (btn) btn.disabled = !(check && check.checked);
    },

    async copyRecoveryCode() {
        const code = (document.getElementById('recoveryCodeDisplay') || {}).textContent || '';
        const btn = document.getElementById('recoveryCopyBtn');
        const orig = btn ? btn.textContent : '';
        try {
            await navigator.clipboard.writeText(code);
            if (btn) { btn.textContent = '✅ Copied'; setTimeout(() => { btn.textContent = orig; }, 1500); }
        } catch (e) {
            if (btn) { btn.textContent = '⚠️ Select & copy manually'; setTimeout(() => { btn.textContent = orig; }, 2000); }
        }
    },

    // Dismisses the one-time recovery notice. The app was already unlocked before
    // this screen appeared, so this is just closing an overlay, not "logging in".
    finishVaultCreation() {
        document.getElementById('encryptionLock').classList.remove('open');
        this._pendingMK = null;
    },

    // ---------- new device, same account — enter recovery code (the ONE real prompt) ----------
    async unlockWithRecoveryCode() {
        const input = document.getElementById('recoveryCodeInput');
        const btn = document.getElementById('enterRecoveryBtn');
        const code = Util.normalizeRecoveryCode(input ? input.value : '');
        if (code.length < 16) { this._flashInputError(input); return; }
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        try {
            const saltRes = await this._withRetries(() => TGPlatform.cloudGet('recovery_salt'));
            const wrappedRes = await this._withRetries(() => TGPlatform.cloudGet('enc_mk_recovery'));
            if (!saltRes.ok || !wrappedRes.ok || !saltRes.value || !wrappedRes.value) {
                throw new Error('recovery data unavailable');
            }
            const salt = Util.b64decode(saltRes.value);
            const wrapKey = await this._deriveFromSecret(code, salt);
            const mkB64 = await this._decryptWithKey(wrapKey, wrappedRes.value); // throws on wrong code
            this._key = await this._importMK(mkB64);
            const sentinelOk = await this._verifySentinelOrCreate();
            if (!sentinelOk) throw new Error('sentinel mismatch after recovery unlock');
            this._rawMK = mkB64;
            // FIX for BUG B: persist to every local tier and VERIFY, instead of a
            // single unchecked SecureStorage write.
            const persisted = await this._persistMKEverywhere(mkB64);
            await this._enterApp();
            if (!persisted) {
                // Extremely rare (every local tier failed) — still unlocked for this
                // session; warn so the person knows to try again on next launch.
                this._showToastOnApp(
                    (typeof diary !== 'undefined' && diary.lang === 'ru')
                        ? '⚠️ Не удалось сохранить ключ на этом устройстве — при следующем запуске код может понадобиться снова'
                        : "⚠️ Couldn't save the key on this device — you may need the code again next launch"
                );
            }
        } catch (e) {
            this._key = null;
            if (btn) { btn.disabled = false; btn.textContent = this._t('enterRecoveryBtn', 'Unlock this device'); }
            this._flashInputError(input);
        }
    },

    confirmStartFresh() {
        const modal = document.getElementById('startFreshModal');
        if (modal) modal.classList.add('open');
        this.applyLang(this._langHint());
    },

    cancelStartFresh() {
        const modal = document.getElementById('startFreshModal');
        if (modal) modal.classList.remove('open');
    },

    async executeStartFresh() {
        const btn = document.getElementById('start-fresh-confirm');
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        try {
            await this._wipeIdentityAndRestart();
        } finally {
            this.cancelStartFresh();
            if (btn) {
                btn.disabled = false;
                btn.textContent = this._t('start-fresh-confirm', 'Delete everything and start fresh');
            }
        }
    },

    async _wipeIdentityAndRestart() {
        this._key = null;
        this._rawMK = null;
        this._pendingMK = null;
        this._pendingRecoveryCode = null;

        const cloudKeys = await this._listCloudKeys();
        if (cloudKeys.length) {
            await Promise.all(cloudKeys.map(k => TGPlatform.cloudRemove(k).catch(() => {})));
        } else if (TGPlatform.supportsCloud) {
            for (const k of this._knownWipeKeys()) {
                await TGPlatform.cloudRemove(k);
            }
        }

        const deviceKeys = await this._listDeviceKeys();
        if (deviceKeys.length) {
            await Promise.all(deviceKeys.map(k => TGPlatform.deviceRemove(k).catch(() => {})));
        } else if (TGPlatform.supportsDevice) {
            for (const k of this._knownWipeKeys().concat(['mk', 'dbmix_sentinel'])) {
                try { await TGPlatform.deviceRemove(k); } catch (e) {}
            }
        }

        if (TGPlatform.supportsSecure) {
            try { await TGPlatform.secureRemove('mk'); } catch (e) {}
        }

        try {
            const keep = 'dbmix_lang_hint';
            const doomed = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k !== keep && (k.startsWith('dbmix_') || k === 'dbmix_mk')) doomed.push(k);
            }
            doomed.forEach(k => localStorage.removeItem(k));
        } catch (e) {}

        if (typeof StorageManager !== 'undefined') {
            try {
                await StorageManager.wipeCollection('notes');
                await StorageManager.wipeCollection('habits');
                await StorageManager.wipeCollection('memories');
            } catch (e) {}
        }
        if (typeof TaskManager !== 'undefined') {
            try { await TaskManager.wipeAll(); } catch (e) {}
        }

        await this._silentCreateVault();
    },

    _knownWipeKeys() {
        return [
            'enc_mk_recovery', 'recovery_salt', 'dbmix_sentinel', 'dbmix_salt',
            'fireStreak', 'lastActiveDate', 'userNickname', 'userId', 'achievements_v1',
            'lang', 'theme', 'notes_index', 'habits_index', 'memories_index',
            'notes', 'habits', 'memories', 'task_index', 'task_stats', 'tasks_v1',
        ];
    },

    _listCloudKeys() {
        return new Promise(resolve => {
            try {
                const api = window.Telegram && Telegram.WebApp && Telegram.WebApp.CloudStorage;
                if (!api || typeof api.getKeys !== 'function') return resolve([]);
                api.getKeys((err, keys) => resolve(err ? [] : (keys || [])));
            } catch (e) { resolve([]); }
        });
    },

    _listDeviceKeys() {
        return new Promise(resolve => {
            try {
                const api = window.Telegram && Telegram.WebApp && Telegram.WebApp.DeviceStorage;
                if (!api || typeof api.getKeys !== 'function') return resolve([]);
                api.getKeys((err, keys) => resolve(err ? [] : (keys || [])));
            } catch (e) { resolve([]); }
        });
    },

    // ---------- legacy: migrate an existing v5 (password-based) account to v7 ----------
    async migrateFromV5() {
        const input = document.getElementById('migratePasswordInput');
        const btn = document.getElementById('migrateUnlockBtn');
        const pw = input ? input.value : '';
        if (!pw) { this._flashInputError(input); return; }
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        try {
            const legacy = await this._checkLegacyV5();
            if (legacy.state !== 'found') throw new Error('legacy salt vanished');
            const salt = Util.b64decode(legacy.saltB64);

            // Derive EXTRACTABLE this time, and with the ORIGINAL v5 iteration
            // count (200,000) -- same bytes as the original key (PBKDF2 is
            // deterministic), so all existing encrypted data keeps decrypting
            // correctly under it with zero re-encryption.
            const derivedKey = await this._deriveFromSecret(pw, salt, true, this.LEGACY_ITERATIONS);

            // Verify against the legacy sentinel before trusting the password.
            this._key = derivedKey;
            let sentinel = null;
            if (TGPlatform.supportsCloud) {
                const r = await TGPlatform.cloudGet('dbmix_sentinel');
                if (r.ok) sentinel = r.value;
            }
            if (!sentinel) { try { sentinel = localStorage.getItem('dbmix_sentinel'); } catch (e) {} }
            if (sentinel) {
                const dec = await this.decrypt(sentinel);
                if (dec !== SENTINEL_LEGACY && dec !== SENTINEL_NEW) throw new Error('wrong password');
            }

            // Adopt this key's raw bytes as the new Master Key going forward.
            const rawMK = await crypto.subtle.exportKey('raw', derivedKey);
            const mkB64 = Util.b64encode(rawMK);
            this._key = await this._importMK(mkB64); // re-import non-extractable for normal use

            // Set up the recovery path + device fast-unlock, same as a new vault.
            const code = Util.generateRecoveryCode();
            const newSalt = crypto.getRandomValues(new Uint8Array(16));
            const wrapKey = await this._deriveFromSecret(Util.normalizeRecoveryCode(code), newSalt);
            const wrapped = await this._encryptWithKey(wrapKey, mkB64);
            if (TGPlatform.supportsCloud) {
                await TGPlatform.cloudSet('recovery_salt', Util.b64encode(newSalt.buffer));
                await TGPlatform.cloudSet('enc_mk_recovery', wrapped);
            }
            const enc = await this.encrypt(SENTINEL_NEW);
            if (TGPlatform.supportsCloud) await TGPlatform.cloudSet('dbmix_sentinel', enc);
            if (TGPlatform.supportsDevice) await TGPlatform.deviceSet('dbmix_sentinel', enc);
            try { localStorage.setItem('dbmix_sentinel', enc); } catch (e) {}
            await this._persistMKEverywhere(mkB64);

            this._rawMK = mkB64;
            await this._enterApp();
            this._presentRecoveryNotice(code);
        } catch (e) {
            this._key = null;
            if (btn) { btn.disabled = false; btn.textContent = 'Upgrade my account'; }
            this._flashInputError(input);
        }
    },

    // ---------- legacy: no Telegram storage APIs, existing password-protected vault ----------
    async legacyUnlock() {
        const input = document.getElementById('lockPasswordInput');
        const btn = document.getElementById('lockUnlockBtn');
        const pw = input ? input.value : '';
        if (!pw) { this._flashInputError(input); return; }
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        try {
            let saltB64 = null;
            try { saltB64 = localStorage.getItem('dbmix_salt'); } catch (e) {}
            if (!saltB64) throw new Error('no legacy vault found');
            const salt = Util.b64decode(saltB64);
            this._key = await this._deriveFromSecret(pw, salt);

            let sentinel = null;
            try { sentinel = localStorage.getItem('dbmix_sentinel'); } catch (e) {}
            if (sentinel) {
                const dec = await this.decrypt(sentinel);
                if (dec !== SENTINEL_NEW && dec !== SENTINEL_LEGACY) throw new Error('wrong password');
            } else {
                const enc = await this.encrypt(SENTINEL_NEW);
                try { localStorage.setItem('dbmix_sentinel', enc); } catch (e) {}
            }
            try { localStorage.setItem('dbmix_pw', pw); } catch (e) {}
            await this._enterApp();
        } catch (e) {
            this._key = null;
            if (btn) { btn.disabled = false; btn.textContent = 'Unlock 🔓'; }
            this._flashInputError(input);
        }
    },

    async _legacyTryUnlock(pw) {
        try {
            let saltB64 = null;
            try { saltB64 = localStorage.getItem('dbmix_salt'); } catch (e) {}
            if (!saltB64) return false;
            const salt = Util.b64decode(saltB64);
            this._key = await this._deriveFromSecret(pw, salt);
            let sentinel = null;
            try { sentinel = localStorage.getItem('dbmix_sentinel'); } catch (e) {}
            if (sentinel) {
                const dec = await this.decrypt(sentinel);
                if (dec !== SENTINEL_NEW && dec !== SENTINEL_LEGACY) { this._key = null; return false; }
            }
            await this._enterApp();
            return true;
        } catch (e) { this._key = null; return false; }
    },

    // ---------- optional: rotate the recovery code without full re-auth ----------
    // Uses the raw MK already held in memory from this session's unlock (see
    // _rawMK above) — the user does not need to re-enter anything to do this.
    async regenerateRecoveryCode() {
        if (!this._rawMK || !TGPlatform.supportsCloud) return null;
        try {
            const code = Util.generateRecoveryCode();
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const wrapKey = await this._deriveFromSecret(Util.normalizeRecoveryCode(code), salt);
            const wrapped = await this._encryptWithKey(wrapKey, this._rawMK);
            await TGPlatform.cloudSet('recovery_salt', Util.b64encode(salt.buffer));
            await TGPlatform.cloudSet('enc_mk_recovery', wrapped);
            return code;
        } catch (e) {
            console.error('[EncryptionManager] regenerateRecoveryCode failed:', e);
            return null;
        }
    },

    // Lets the person re-view their recovery code any time from the sidebar,
    // reusing the same one-time notice UI (see requirement: "you can always
    // view this again later from the sidebar").
    async viewRecoveryCodeAgain() {
        const code = await this.regenerateRecoveryCode();
        if (code) this._presentRecoveryNotice(code);
        return code;
    },

    // ---------- shared screen-state helpers ----------
    _showScreen(id) {
        document.querySelectorAll('#encryptionLock .lock-screen').forEach(el => el.classList.remove('active'));
        const el = document.getElementById(id);
        if (el) el.classList.add('active');
    },
    _showBlockingError() {
        document.getElementById('encryptionLock').classList.add('open');
        this._showScreen('lockScreenError');
    },
    retryBoot() { this.boot(); },
    // Escape hatch from the error screen: proceed with a local-only vault rather
    // than leaving the person stuck if retries keep failing.
    continueOffline() { this._bootDegraded(); },
    _showToast(screenId, msg) {
        const host = document.getElementById(screenId);
        if (!host) return;
        let t = host.querySelector('.lock-inline-toast');
        if (!t) { t = document.createElement('div'); t.className = 'lock-inline-toast'; host.appendChild(t); }
        t.textContent = msg;
        t.style.opacity = '1';
        setTimeout(() => { t.style.opacity = '0'; }, 3000);
    },
    _flashInputError(input) {
        if (!input) return;
        input.style.borderColor = '#f87171';
        input.style.boxShadow = '0 0 0 4px rgba(248,113,113,0.2)';
        setTimeout(() => { input.style.borderColor = ''; input.style.boxShadow = ''; }, 1200);
        input.focus();
    },
    onRecoveryInputChange() {
        const input = document.getElementById('recoveryCodeInput');
        if (!input) return;
        const pos = input.selectionStart;
        const before = input.value.length;
        input.value = Util.formatRecoveryInput(input.value);
        const delta = input.value.length - before;
        try { input.setSelectionRange(pos + delta, pos + delta); } catch (e) {}
    },

    _langHint() {
        if (typeof diary !== 'undefined' && diary.lang) return diary.lang;
        try { return localStorage.getItem('dbmix_lang_hint') || 'en'; } catch (e) { return 'en'; }
    },
    _t(key, fallback) {
        const lang = this._langHint();
        if (typeof T !== 'undefined') {
            const dict = T[lang] || T.en || {};
            if (dict[key]) return dict[key];
            if (T.en && T.en[key]) return T.en[key];
        }
        return fallback || key;
    },

    // ---------- translations for the lock screen (from translations.js) ----------
    applyLang(lang) {
        const t = (key, fb) => {
            if (typeof T !== 'undefined') {
                const dict = (T[lang] || T.en) || {};
                if (dict[key]) return dict[key];
                if (T.en && T.en[key]) return T.en[key];
            }
            return fb || key;
        };
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        const setPh = (id, v) => { const el = document.getElementById(id); if (el) el.placeholder = v; };
        set('lockCheckingText', t('checking', lang === 'ru' ? 'Разблокировка…' : 'Unlocking…'));
        set('recoveryShowTitle', t('recoveryShowTitle', lang === 'ru' ? 'Сохрани код восстановления' : 'Save your recovery code'));
        set('recoveryShowDesc', t('recoveryShowDesc', lang === 'ru'
            ? 'Дневник уже разблокирован и зашифрован сквозным шифрованием — пароль на этом устройстве не нужен. Сохрани этот код на случай нового устройства или переустановки.'
            : 'Your journal is already unlocked and end-to-end encrypted — no password needed on this device. Save this code once, just in case you ever set up a new device or reinstall.'));
        set('recoveryCopyBtn', t('recoveryCopyBtn', lang === 'ru' ? '📋 Скопировать' : '📋 Copy code'));
        set('recoverySavedLabel', t('recoverySavedLabel', lang === 'ru' ? 'Я сохранил его в надёжном месте' : 'I’ve saved this somewhere safe'));
        set('recoveryContinueBtn', t('recoveryContinueBtn', lang === 'ru' ? 'Продолжить' : 'Continue'));
        set('recoverySkipHint', t('recoverySkipHint', lang === 'ru' ? 'Ты всегда можешь посмотреть его снова в боковом меню.' : 'You can always view this again later from the sidebar.'));
        set('enterRecoveryTitle', t('enterRecoveryTitle'));
        set('enterRecoveryDesc', t('enterRecoveryDesc'));
        setPh('recoveryCodeInput', t('recoveryCodeInput-ph'));
        set('enterRecoveryBtn', t('enterRecoveryBtn'));
        set('noRecoveryText', t('noRecoveryText'));
        set('startFreshBtn', t('startFreshBtn'));
        set('startFreshHint', t('startFreshHint'));
        set('start-fresh-title', t('start-fresh-title'));
        set('start-fresh-desc', t('start-fresh-desc'));
        set('start-fresh-cancel', t('start-fresh-cancel'));
        set('start-fresh-confirm', t('start-fresh-confirm'));
        set('del-modal-title', t('del-modal-title'));
        set('del-modal-desc', t('del-modal-desc'));
        set('del-cancel-btn', t('del-cancel-btn'));
        set('del-confirm-btn', t('del-confirm-btn'));
        set('migrateTitle', t('migrateTitle', lang === 'ru' ? 'Разовое обновление' : 'One-time upgrade'));
        set('migrateDesc', t('migrateDesc', lang === 'ru'
            ? 'Мы нашли на этом аккаунте старый дневник, защищённый паролем. Введи этот пароль один раз, чтобы перейти на мгновенную разблокировку — больше вводить его не понадобится.'
            : 'We found an older password-protected journal on this account. Enter that password once to switch to instant unlock — you won’t need to type it again after this.'));
        setPh('migratePasswordInput', t('migratePh', lang === 'ru' ? 'Текущий пароль' : 'Current password'));
        set('migrateUnlockBtn', t('migrateBtn', lang === 'ru' ? 'Обновить аккаунт' : 'Upgrade my account'));
        set('errorTitle', t('errorTitle', lang === 'ru' ? 'Проблема соединения' : 'Connection problem'));
        set('errorDesc', t('errorDesc', lang === 'ru'
            ? 'Не удалось подключиться к защищённому хранилищу Telegram. Данные в безопасности — можно повторить попытку или продолжить работу локально.'
            : 'Couldn’t reach Telegram’s secure storage. Your data is safe on your account — you can retry, or keep working locally until the connection is back.'));
        set('errorRetryBtn', t('retryBtn', lang === 'ru' ? 'Повторить' : 'Retry'));
        set('errorOfflineLink', t('offlineLink', lang === 'ru' ? 'Продолжить офлайн' : 'Continue offline'));
        set('lock-title', t('legacyTitle', 'DailyBookimix'));
        set('lock-desc', t('legacyDesc', lang === 'ru' ? 'Введи пароль, чтобы разблокировать зашифрованный дневник.' : 'Enter your password to unlock your encrypted journal.'));
        set('lock-hint', t('legacyHint', lang === 'ru' ? 'В этом браузере уже есть зашифрованный дневник — введи его пароль.' : 'This browser has an existing encrypted journal — enter its password.'));
        set('lockUnlockBtn', t('legacyBtn', lang === 'ru' ? 'Разблокировать 🔓' : 'Unlock 🔓'));
    }
};



