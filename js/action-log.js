// @ts-check
// ================================================================
//  ACTION LOG — privacy-friendly, anonymous activity history (v9.2)
//
//  PRIVACY GUARANTEES (by construction, not by convention):
//   - record() accepts ONLY a code from the fixed ACTION_CODES
//     whitelist. There is no parameter that could carry a note
//     title, habit name or any other user content, and unknown
//     codes are dropped. An entry is exactly { t: epoch-ms, a: code }.
//   - Stored encrypted and LOCAL-ONLY (StorageManager.setLocalItem):
//     never written to CloudStorage, never sent to any analytics or
//     third-party service.
//
//  PERFORMANCE: record() is an in-memory push + a debounced write
//  (one storage write per burst of actions, flushed immediately when
//  the app is backgrounded/closed). Capped at MAX_ENTRIES.
// ================================================================

/** @typedef {'note_created'|'note_updated'|'note_deleted'|'habit_created'|'habit_updated'|'habit_deleted'|'habit_checked'|'habit_unchecked'|'memory_created'|'memory_updated'|'memory_deleted'|'task_created'|'task_completed'|'task_deleted'|'settings_opened'|'theme_changed'|'language_changed'|'data_exported'|'data_imported'} ActionCode */
/** @typedef {{ t: number, a: ActionCode }} ActionEntry */

const ActionLog = {
    STORAGE_KEY: 'action_log_v1',
    MAX_ENTRIES: 500,
    FLUSH_DELAY_MS: 1500,

    /** @type {ReadonlyArray<ActionCode>} */
    ACTION_CODES: [
        'note_created', 'note_updated', 'note_deleted',
        'habit_created', 'habit_updated', 'habit_deleted', 'habit_checked', 'habit_unchecked',
        'memory_created', 'memory_updated', 'memory_deleted',
        'task_created', 'task_completed', 'task_deleted',
        'settings_opened', 'theme_changed', 'language_changed',
        'data_exported', 'data_imported',
    ],

    /** @type {ActionEntry[]} oldest first */
    _entries: [],
    _loaded: false,
    _timer: null,
    _chain: Promise.resolve(),
    _listenersBound: false,
    _muted: false, // true while a backup import runs, so restoring settings isn't logged as user actions

    async init() {
        if (!this._listenersBound) {
            this._listenersBound = true;
            // Flush when the Mini App is backgrounded/closed so the debounce never loses entries.
            document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this._flushNow(); });
            window.addEventListener('pagehide', () => this._flushNow());
        }
        let stored = [];
        try {
            const raw = await StorageManager.getLocalItem(this.STORAGE_KEY);
            stored = raw ? this.sanitize(JSON.parse(raw)) : [];
        } catch (e) { stored = []; }
        // Anything recorded while we were still loading stays newest.
        const pending = this._entries;
        this._entries = stored.concat(pending).slice(-this.MAX_ENTRIES);
        this._loaded = true;
        if (pending.length) this._schedule();
    },

    /** Drops anything that isn't a well-formed { t, a } with a whitelisted code. */
    sanitize(list) {
        if (!Array.isArray(list)) return [];
        /** @type {ActionEntry[]} */
        const out = [];
        for (const e of list) {
            if (!e || typeof e.t !== 'number' || !isFinite(e.t) || e.t <= 0) continue;
            if (!this.ACTION_CODES.includes(e.a)) continue;
            out.push({ t: Math.floor(e.t), a: e.a });
        }
        out.sort((x, y) => x.t - y.t);
        return out.slice(-this.MAX_ENTRIES);
    },

    /** @param {ActionCode} code */
    record(code) {
        if (this._muted || !this.ACTION_CODES.includes(code)) return;
        this._entries.push({ t: Date.now(), a: code });
        if (this._entries.length > this.MAX_ENTRIES) this._entries.splice(0, this._entries.length - this.MAX_ENTRIES);
        this._schedule();
    },

    /** Copy of all entries, oldest first. */
    getAll() { return this._entries.slice(); },

    /** Replace the whole log (used by backup import). */
    async replaceAll(list) {
        this._entries = this.sanitize(list);
        this._loaded = true;
        await this._flushNow();
    },

    /** Permanently delete every recorded action. */
    async clear() {
        this._entries = [];
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        await this._enqueue(() => StorageManager.removeLocalItem(this.STORAGE_KEY));
    },

    _schedule() {
        if (this._timer) return;
        this._timer = setTimeout(() => { this._timer = null; this._flushNow(); }, this.FLUSH_DELAY_MS);
    },

    _flushNow() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (!this._loaded) { this._schedule(); return Promise.resolve(); } // never overwrite the stored log before it was read
        return this._enqueue(() => StorageManager.setLocalItem(this.STORAGE_KEY, JSON.stringify(this._entries)));
    },

    /** Serialises writes so a clear() can never be undone by an older in-flight flush. */
    _enqueue(fn) {
        this._chain = this._chain.then(fn).catch(e => console.warn('[ActionLog] storage write failed:', e));
        return this._chain;
    },
};


// ================================================================
//  ACTION HISTORY MODAL (Settings → Action history)
// ================================================================
const ActionHistoryUI = {
    open() {
        SidebarUI.close();
        setTimeout(() => {
            this.render();
            document.getElementById('actionHistoryModal').classList.add('open');
        }, 300);
    },

    close() {
        const m = document.getElementById('actionHistoryModal');
        if (m) m.classList.remove('open');
    },

    isOpen() {
        const m = document.getElementById('actionHistoryModal');
        return !!m && m.classList.contains('open');
    },

    /** Newest first. Only reads fixed codes + timestamps — nothing sensitive exists to leak. */
    render() {
        const list  = document.getElementById('ahList');
        const empty = document.getElementById('ahEmpty');
        const clear = document.getElementById('ahClearBtn');
        if (!list || !empty || !clear) return;
        const entries = ActionLog.getAll();
        empty.style.display = entries.length ? 'none' : 'block';
        clear.disabled = entries.length === 0;
        const rows = [];
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            rows.push(
                `<div class="ah-row"><span class="ah-label">${Util.escHtml(diary.t('act-' + e.a))}</span>` +
                `<span class="ah-time">${Util.localDateTimeStr(e.t)}</span></div>`
            );
        }
        list.innerHTML = rows.join('');
    },

    applyTranslations() {
        const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = diary.t(key); };
        set('ahTitle', 'ah-title');
        set('ahDesc', 'ah-desc');
        set('ahEmpty', 'ah-empty');
        set('ahClearBtn', 'ah-clear-btn');
        if (this.isOpen()) this.render();
    },

    async requestClear() {
        const ok = await DataDialog.confirm({
            icon: '🗑️',
            title: diary.t('ah-clear-title'),
            desc: diary.t('ah-clear-desc'),
            confirmLabel: diary.t('ah-clear-confirm'),
        });
        if (!ok) return;
        const btn = document.getElementById('ahClearBtn');
        if (btn) btn.disabled = true;
        try {
            await ActionLog.clear();
            this.render();
            diary.toast(diary.t('ah-cleared'));
        } catch (e) {
            console.error('[ActionHistoryUI] clear failed:', e);
            diary.toast(diary.t('err-ah-clear'), 'error');
            this.render();
        }
    },
};
