// ================================================================
//  BOOT SEQUENCE
// ================================================================
(async function boot() {
    // Apply saved language to the lock screen before we even know which
    // tier we'll land on (the language preference itself isn't sensitive,
    // so this one hint is intentionally kept outside the encrypted vault).
    let savedLang = 'en';
    try { savedLang = localStorage.getItem('dbmix_lang_hint') || 'en'; } catch (e) {}
    EncryptionManager.applyLang(savedLang);

    // Enter-key support across every lock-screen text input.
    const enterHandlers = {
        lockPasswordInput: () => EncryptionManager.legacyUnlock(),
        migratePasswordInput: () => EncryptionManager.migrateFromV5(),
        recoveryCodeInput: () => EncryptionManager.unlockWithRecoveryCode(),
    };
    Object.keys(enterHandlers).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); enterHandlers[id](); } });
    });

    // v8.0: hard watchdog around boot(). The v8.0 timeout fix in TGPlatform
    // already stops a dead native-bridge callback from hanging forever, but
    // this is a second, independent safety net — if boot() ever fails to
    // resolve for ANY other reason, the person gets a Retry / Continue
    // offline screen instead of being stuck on "Unlocking…" with no way out.
    //
    // Timing note: with every bridge call now bounded by
    // TGPlatform.BRIDGE_TIMEOUT_MS (2.5s), the absolute worst case — EVERY
    // storage tier dead at once — chains through _readMKAnywhere (up to 3
    // sequential bridge calls), a 3-try CloudStorage retry, a 3-try legacy-v5
    // retry, silent-vault-creation writes, and _persistMKEverywhere's
    // write+verify pairs, totalling roughly ~40s. This watchdog is set
    // comfortably above that so it can only ever fire on a genuine hang
    // (e.g. an unguarded await added by a future change), never on a boot
    // that's simply working through legitimate retries.
    let bootSettled = false;
    const bootWatchdog = setTimeout(() => {
        if (bootSettled) return;
        console.warn('[boot] watchdog fired — EncryptionManager.boot() did not resolve in time');
        try { EncryptionManager._showBlockingError(); } catch (e) {}
    }, 45000);

    try {
        await EncryptionManager.boot(); // figures out which tier to show, or unlocks instantly and calls diary.init()
    } finally {
        bootSettled = true;
        clearTimeout(bootWatchdog);
    }
})();

// Persist language hint (unencrypted, just for lock screen UI)
const _patchApplyLang = diary.applyLang;
diary.applyLang = function(lang) {
    try { localStorage.setItem('dbmix_lang_hint', lang); } catch(e) {}
    _patchApplyLang.call(diary, lang);
    EncryptionManager.applyLang(lang);
};
