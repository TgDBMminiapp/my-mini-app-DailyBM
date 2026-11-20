// @ts-check
// ================================================================
//  ENCRYPTION MANAGER — Master-Key architecture
//
//  One random 256-bit AES-GCM Master Key (MK) per account, generated once with
//  crypto.getRandomValues. It never leaves the device in plaintext.
//    • CloudStorage  — stores only an encrypted sentinel and a copy of the MK
//      wrapped with a key derived (PBKDF2, 600k iterations) from the recovery
//      code. This is how a genuinely new device learns the account has a vault.
//    • SecureStorage — OS keychain/keystore; primary per-device home of the MK
//      for instant unlock.
//    • DeviceStorage / localStorage — second and third local copies of the MK.
//      _persistMKEverywhere() writes every available tier and verifies each by
//      reading it back, so one failed write cannot strand the person.
//
//  Boot decision tree (see boot()):
//    1. A local MK exists                       → unlock silently.
//    2. No Telegram storage at all              → device-local vault.
//    3. Cloud confirms a vault, nothing local   → ask for the recovery code
//       (the only real credential prompt).
//    4. Cloud confirms nothing anywhere         → create a vault silently and show a
//       dismissible "save your recovery code" notice over the unlocked app.
//    5. Cloud unreachable after retries         → work locally and reconcile in the
//       background; never block the person behind a credential screen.
//  Legacy password-based accounts (v5) keep working via migrateFromV5() /
//  legacyUnlock(); the PBKDF2 iteration counts below must not change or old data
//  would stop decrypting.
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
        } catch (e) {
            if (!this._decryptWarned) { this._decryptWarned = true; DBLog.warn('Security', 'Some stored data could not be decrypted with the current key.'); }
            return ciphertext;
        }
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
            if (await this._finishUnlockWithMK(localMK)) { DBLog.info('Security', 'Encrypted vault unlocked.'); return; }
            DBLog.warn('Security', 'The stored key did not match this account\'s data. Treating this device as new.');
        }

        // ── No Telegram storage APIs at all (old client, or testing outside
        // Telegram in a plain browser). Everything stays device-local. ──
        if (!TGPlatform.supportsSecure && !TGPlatform.supportsCloud && !TGPlatform.supportsDevice) {
            DBLog.warn('Telegram', 'Native storage is unavailable. Using local fallback.');
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
            DBLog.warn('Telegram', 'Cloud storage did not respond. Continuing offline and retrying in the background.');
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
            DBLog.error('Security', 'Could not create the encrypted vault. Falling back to device-local storage.', e);
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
        this._showToastOnApp(this._t('offlineModeToast'));
        this._scheduleCloudReconcile();
    },

    // Periodically retries publishing this device's recovery blob to the cloud
    // once connectivity/CloudStorage comes back, so a temporary outage during
    // first launch doesn't permanently prevent multi-device sync from working.
    _scheduleCloudReconcile() {
        if (this._reconcileTimer) return;
        this._reconcileTimer = setInterval(async () => {
            if (!TGPlatform.supportsCloud || !this._rawMK || this._reconciling) return;
            this._reconciling = true;
            try { await this._reconcileOnce(); } catch (e) { DBLog.warn('Sync', 'Background reconciliation failed. Will retry.', e); }
            finally { this._reconciling = false; }
        }, 20000);
    },

    async _reconcileOnce() {
        {
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
                DBLog.info('Sync', 'Synchronization completed. Recovery data published.');
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
        }
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
            DBLog.error('Security', 'Device-local vault could not be created.', e);
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
        await diary.init(); // idempotent: safe to call again after "start fresh" or a retry
        DBLog.info('App', 'Initialization completed.');
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
        let ok = false;
        try { await navigator.clipboard.writeText(code); ok = true; }
        catch (e) { ok = this._legacyCopy(code); } // clipboard API is blocked in some WebViews
        if (btn) {
            btn.textContent = this._t(ok ? 'recoveryCopyBtn-copied' : 'recoveryCopyBtn-failed');
            setTimeout(() => { btn.textContent = orig; }, ok ? 1500 : 2000);
        }
    },
    _legacyCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'offscreen-input';
            document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
            const ok = document.execCommand('copy'); ta.remove(); return ok;
        } catch (e) { return false; }
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
        // BUG FIX: recovery codes are always exactly 20 characters once
        // hyphens are stripped (see generateRecoveryCode / Util.normalizeRecoveryCode)
        // — this used to gate on `< 16`, so a code missing its last group (or with
        // stray pasted characters) would sail past validation and go straight to
        // a doomed decrypt attempt instead of an immediate, clear "incomplete
        // code" error. Also cap length defensively in case of a long paste.
        const code = Util.normalizeRecoveryCode(input ? input.value : '').slice(0, 20);
        if (code.length < 20) { this._flashInputError(input); return; }
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
            DBLog.info('Security', 'Encrypted vault unlocked with the recovery code.');
            if (!persisted) {
                // Extremely rare (every local tier failed) — still unlocked for this
                // session; warn so the person knows to try again on next launch.
                this._showToastOnApp(this._t('mkPersistFailedToast'));
            }
        } catch (e) {
            this._key = null;
            DBLog.warn('Security', 'Recovery code was not accepted or recovery data was unreachable.');
            if (btn) { btn.disabled = false; btn.textContent = this._t('enterRecoveryBtn'); }
            this._flashInputError(input);
        }
    },

    // Shows an explicit in-UI confirmation step (rather than a native confirm()
    // dialog) so the person clearly understands all data will be lost forever
    // before anything is wiped.
    confirmStartFresh() {
        const modal = document.getElementById('startFreshConfirmModal');
        if (modal) { modal.classList.add('open'); return; }
        // Fallback in case the modal markup is somehow missing.
        if (confirm(this._t('sfConfirmDesc'))) this._wipeIdentityAndRestart();
    },

    cancelStartFresh() {
        const modal = document.getElementById('startFreshConfirmModal');
        if (modal) modal.classList.remove('open');
    },

    async executeStartFresh() {
        const modal = document.getElementById('startFreshConfirmModal');
        const btn = document.getElementById('sfConfirmExecuteBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        try {
            await this._wipeIdentityAndRestart();
        } finally {
            if (modal) modal.classList.remove('open');
            if (btn) { btn.disabled = false; btn.textContent = this._t('sfConfirmBtn'); }
        }
    },

    async _wipeIdentityAndRestart() {
        if (TGPlatform.supportsCloud) {
            for (const k of ['enc_mk_recovery', 'recovery_salt', 'dbmix_sentinel', 'dbmix_salt']) {
                await TGPlatform.cloudRemove(k);
            }
        }
        if (TGPlatform.supportsDevice) { try { await TGPlatform.deviceRemove('dbmix_sentinel'); await TGPlatform.deviceRemove('mk'); } catch (e) {} }
        // FIX (reliability): SecureStorage's copy of the old Master Key was
        // never explicitly cleared here. _silentCreateVault() below overwrites
        // it with the brand-new MK right after, so this alone wasn't actually
        // stranding anyone — but leaving a stale key sitting in the OS
        // keychain until the very next write is needless risk on a path whose
        // whole job is guaranteeing a clean slate, so clear it explicitly too.
        if (TGPlatform.supportsSecure) { try { await TGPlatform.secureRemove('mk'); } catch (e) {} }
        try {
            localStorage.removeItem('dbmix_salt'); localStorage.removeItem('dbmix_sentinel');
            localStorage.removeItem('dbmix_mk'); localStorage.removeItem('dbmix_pw');
        } catch (e) {}
        // FIX (reliability): the old collection indexes were never removed
        // here, only left behind pointing at now-permanently-undecryptable
        // data under the new key. Clear what we can reach without a valid
        // key (the index/bookkeeping entries and any legacy blobs) so
        // "start fresh" cleans up after itself as completely as it can from
        // a locked-out lock screen. Per-item shards from collections that
        // were never loaded in this browser session can't be enumerated
        // without the old key we're discarding — those are inert, forever-
        // undecryptable leftovers, harmless to confidentiality but not
        // something this path can reach; StorageManager already handles
        // that gracefully everywhere else (see loadCollection).
        try {
            await Promise.all([
                (typeof StorageManager !== 'undefined') && StorageManager.wipeCollection('notes'),
                (typeof StorageManager !== 'undefined') && StorageManager.wipeCollection('habits'),
                (typeof StorageManager !== 'undefined') && StorageManager.wipeCollection('memories'),
                (typeof TaskManager !== 'undefined') && TaskManager.wipeAll(),
            ]);
            if (typeof StorageManager !== 'undefined') {
                // v9.0: also wipe custom achievements (dedicated key) on a full
                // "start fresh" reset, same as the account-deletion flow.
                for (const key of ['fireStreak', 'lastActiveDate', 'streakLog', 'freezeCount', 'freezeMonth', 'freezeLog', 'userNickname', 'userId', 'achievements_v1', 'custom_achievements_v1']) {
                    await StorageManager.removeItem(key);
                }
            }
            if (typeof AchievementsUI !== 'undefined') {
                AchievementsUI._state = {};
                AchievementsUI._custom = [];
            }
            if (typeof ActionLog !== 'undefined') await ActionLog.clear();
            if (typeof SidebarUI !== 'undefined') SidebarUI.profile.nickname = '';
        } catch (e) { DBLog.warn('Security', 'Some old data could not be cleared while starting fresh.', e); }
        DBLog.info('Security', 'Identity reset. Creating a new encrypted vault.');
        // Immediately create a brand-new vault silently instead of showing a
        // "welcome" screen that asks for anything — starting fresh means the
        // person gets a working, unlocked, empty journal right away.
        await this._silentCreateVault();
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
            if (btn) { btn.disabled = false; btn.textContent = this._t('migrateUnlockBtn'); }
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
            if (btn) { btn.disabled = false; btn.textContent = this._t('lockUnlockBtn'); }
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
            DBLog.error('Security', 'Could not generate a new recovery code.', e);
            return null;
        }
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
    _flashInputError(input) {
        if (!input) return;
        input.classList.add('input-error');
        setTimeout(() => input.classList.remove('input-error'), 1200);
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

    // ---------- translations for the lock screen ----------
    // Sourced from the shared translations.js `T` table (same system the rest
    // of the app uses via `diary.t()`), instead of a private duplicate dict.
    // Keys match the element ids 1:1, mirroring diary.applyTranslations().
    _t(key) {
        const lang = (typeof diary !== 'undefined' && diary.lang) || this._lastLang || 'en';
        return (typeof T !== 'undefined' && (T[lang] || T.en)[key]) || key;
    },
    applyLang(lang) {
        this._lastLang = lang;
        const strs = (typeof T !== 'undefined' && T[lang]) || (typeof T !== 'undefined' && T.en) || {};
        const t = (key) => strs[key] || key;
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        const setPh = (id, v) => { const el = document.getElementById(id); if (el) el.placeholder = v; };

        set('lockCheckingText', t('lockCheckingText'));
        set('recoveryShowTitle', t('recoveryShowTitle')); set('recoveryShowDesc', t('recoveryShowDesc'));
        set('recoveryCopyBtn', t('recoveryCopyBtn')); set('recoverySavedLabel', t('recoverySavedLabel'));
        set('recoveryContinueBtn', t('recoveryContinueBtn')); set('recoverySkipHint', t('recoverySkipHint'));
        set('enterRecoveryTitle', t('enterRecoveryTitle')); set('enterRecoveryDesc', t('enterRecoveryDesc'));
        setPh('recoveryCodeInput', t('recoveryCodeInput-ph')); set('enterRecoveryBtn', t('enterRecoveryBtn'));
        set('noRecoveryText', t('noRecoveryText')); set('startFreshLink', t('startFreshLink'));
        set('startFreshBtn', t('startFreshBtn')); set('startFreshHint', t('startFreshHint'));
        set('sfConfirmTitle', t('sfConfirmTitle')); set('sfConfirmDesc', t('sfConfirmDesc'));
        set('sfConfirmCancelBtn', t('sfConfirmCancel')); set('sfConfirmExecuteBtn', t('sfConfirmBtn'));
        set('migrateTitle', t('migrateTitle')); set('migrateDesc', t('migrateDesc'));
        setPh('migratePasswordInput', t('migratePasswordInput-ph')); set('migrateUnlockBtn', t('migrateUnlockBtn'));
        set('migrateStartFreshBtn', t('migrateStartFreshBtn')); set('migrateStartFreshHint', t('migrateStartFreshHint'));
        set('errorTitle', t('errorTitle')); set('errorDesc', t('errorDesc'));
        set('errorRetryBtn', t('errorRetryBtn')); set('errorOfflineLink', t('errorOfflineLink'));
        set('lock-title', t('lock-title')); set('lock-desc', t('lock-desc'));
        setPh('lockPasswordInput', t('lockPasswordInput-ph')); set('lockUnlockBtn', t('lockUnlockBtn'));
        set('lock-hint', t('lock-hint'));
    }
};



