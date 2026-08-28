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

    await EncryptionManager.boot(); // figures out which tier to show, or unlocks instantly and calls diary.init()
})();

// Persist language hint (unencrypted, just for lock screen UI)
const _patchApplyLang = diary.applyLang;
diary.applyLang = function(lang) {
    try { localStorage.setItem('dbmix_lang_hint', lang); } catch(e) {}
    _patchApplyLang.call(diary, lang);
    EncryptionManager.applyLang(lang);
};
