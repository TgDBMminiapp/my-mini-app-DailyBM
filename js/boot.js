// ================================================================
//  BOOT SEQUENCE
//  Runs last: every module above is already defined.
// ================================================================
(async function boot() {
    // 1. Tell Telegram the page is ready and give the app the full viewport as early as possible
    //    (before unlock). No-op in a plain browser or on clients without the bridge.
    TGPlatform.initApp();

    // 2. Lock-screen language and theme. These two preferences are not sensitive, so a small
    //    unencrypted hint is kept outside the vault purely to avoid a flash of the wrong
    //    language/theme before the encrypted settings can be read.
    let savedLang = 'en', savedTheme = null;
    try {
        savedLang  = localStorage.getItem('dbmix_lang_hint') === 'ru' ? 'ru' : 'en';
        savedTheme = localStorage.getItem('dbmix_theme_hint');
    } catch (e) { /* storage blocked: defaults apply */ }
    if (!savedTheme && TGPlatform.colorScheme() === 'dark') savedTheme = 'dark';
    document.body.classList.toggle('theme-dark', savedTheme === 'dark');
    document.documentElement.lang = savedLang;
    TGPlatform.syncChrome(diary.THEME_CHROME[savedTheme === 'dark' ? 'dark' : 'orange']);
    EncryptionManager.applyLang(savedLang);

    // 3. Enter-key support across every lock-screen text input.
    const enterHandlers = {
        lockPasswordInput:    () => EncryptionManager.legacyUnlock(),
        migratePasswordInput: () => EncryptionManager.migrateFromV5(),
        recoveryCodeInput:    () => EncryptionManager.unlockWithRecoveryCode(),
    };
    Object.keys(enterHandlers).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); enterHandlers[id](); } });
    });

    // 4. Watchdog. Every native-bridge call is already bounded by TGPlatform.BRIDGE_TIMEOUT_MS, so this
    //    is an independent second safety net: if boot() fails to settle for any other reason the person
    //    gets a Retry / Continue-offline screen instead of an endless "Unlocking…". It is set well above
    //    the worst legitimate case (every storage tier dead, all retries exhausted, roughly 40 s).
    let bootSettled = false;
    const bootWatchdog = setTimeout(() => {
        if (bootSettled) return;
        DBLog.warn('App', 'Startup did not finish in time. Offering retry.');
        try { EncryptionManager._showBlockingError(); } catch (e) { /* UI not available */ }
    }, 45000);

    try {
        await EncryptionManager.boot(); // unlocks (or shows the right lock screen) and calls diary.init()
    } catch (e) {
        DBLog.error('App', 'Startup failed.', e);
        try { EncryptionManager._showBlockingError(); } catch (e2) { /* UI not available */ }
    } finally {
        bootSettled = true;
        clearTimeout(bootWatchdog);
    }
})();
