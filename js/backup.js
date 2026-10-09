// @ts-check
// ================================================================
//  BACKUP — account data export / import (v9.2)
//
//  FILE FORMAT (JSON, "format": 1)
//    { app, format, appVersion, exportedAt, data: {
//        notes[], habits[], memories[],
//        settings{lang,theme,nickname}, streak{...},
//        tasks{days{YYYY-MM-DD: day}, stats}, achievements{state,custom},
//        actionLog[] } }
//
//  DELIBERATELY NOT EXPORTED: Telegram user ID, encryption keys,
//  recovery codes. A backup file never contains anything that can
//  unlock or identify the account. The file itself is plain JSON —
//  the UI tells people to keep it private.
//
//  IMPORT SAFETY
//   1. The file is fully parsed + validated and rebuilt from a
//      whitelist of fields BEFORE anything is touched.
//   2. The user must confirm an explicit overwrite warning.
//   3. Current data is snapshotted first; if applying fails midway
//      the snapshot is restored.
//  Writes go through StorageManager, so local storage is updated
//  first (offline-safe) and CloudStorage sync is best-effort, exactly
//  like every other save in the app.
// ================================================================

/** @typedef {{ ok: true, data: any, exportedAt: string }} ParseOk */
/** @typedef {{ ok: false, errorKey: string }} ParseFail */

const BackupManager = {
    APP_ID: 'dailybookimix',
    FORMAT_VERSION: 1,
    APP_VERSION: '9.2',
    MAX_FILE_BYTES: 10 * 1024 * 1024,

    _busy: false,
    _DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
    _NOTE_CATS: ['personal', 'work', 'ideas'],
    _MEM_TYPES: ['book', 'movie', 'series', 'game', 'relations', 'other'],

    // ───────────────────────── EXPORT ─────────────────────────

    /** Builds the backup object from the app's live state + storage. */
    async collect() {
        // Task day-shards are loaded lazily; make sure every known day is in memory.
        const known = new Set(Object.keys(TaskManager._summary));
        Object.keys(TaskManager._data).forEach(d => {
            const day = TaskManager._data[d];
            if (day && ((day.tasks && day.tasks.length) || day.mood)) known.add(d);
        });
        const dates = Array.from(known).filter(d => this._DATE_RE.test(d));
        await Promise.all(dates.map(d => TaskManager._loadDay(d)));
        /** @type {Record<string, any>} */
        const days = {};
        dates.forEach(d => { days[d] = TaskManager._data[d]; });

        return {
            app: this.APP_ID,
            format: this.FORMAT_VERSION,
            appVersion: this.APP_VERSION,
            exportedAt: new Date().toISOString(),
            data: JSON.parse(JSON.stringify({
                notes: diary.notes,
                habits: diary.habits,
                memories: diary.memories,
                settings: { lang: diary.lang, theme: diary.theme, nickname: SidebarUI.profile.nickname || '' },
                streak: { fireStreak: diary.fireStreak, lastActiveDate: diary.lastActiveDate, streakLog: diary.streakLog },
                tasks: { days, stats: TaskManager._stats },
                achievements: { state: AchievementsUI._state, custom: AchievementsUI._custom },
                actionLog: ActionLog.getAll(),
            })),
        };
    },

    async exportData() {
        if (this._busy) return;
        this._busy = true;
        this._setBusy('sbExportRow', true);
        try {
            const backup = await this.collect();
            const json = JSON.stringify(backup, null, 2);
            const filename = `dailybook-backup-${Util.localDateStr()}.json`;
            const outcome = await this._deliver(json, filename);
            if (outcome === 'cancelled') return; // user dismissed the share sheet — not an error
            ActionLog.record('data_exported');
            diary.toast(diary.t('export-toast-ok'));
        } catch (e) {
            console.error('[BackupManager] export failed:', e);
            diary.toast(diary.t('err-export'), 'error');
        } finally {
            this._busy = false;
            this._setBusy('sbExportRow', false);
        }
    },

    /** Hands the file to the user. Mobile Telegram webviews often ignore
     *  `<a download>` for blobs, so there the native share sheet is tried first. */
    async _deliver(json, filename) {
        const blob = new Blob([json], { type: 'application/json' });
        const platform = (window.Telegram && Telegram.WebApp && Telegram.WebApp.platform) || '';
        const mobile = platform === 'ios' || platform === 'android';
        if (mobile && typeof File === 'function' && navigator.canShare && navigator.share) {
            try {
                const file = new File([blob], filename, { type: 'application/json' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: filename });
                    return 'shared';
                }
            } catch (e) {
                if (e && e.name === 'AbortError') return 'cancelled';
                // any other failure → fall through to the download link
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return 'downloaded';
    },

    // ───────────────────────── IMPORT ─────────────────────────

    /** Must be called synchronously from the click handler (browsers block file pickers otherwise). */
    pickFile() {
        if (this._busy) return;
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('importFileInput'));
        if (!input) return;
        input.value = ''; // so choosing the same file twice still fires "change"
        input.click();
    },

    async onFileChosen(input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file || this._busy) return;
        this._busy = true;
        this._setBusy('sbImportRow', true);
        try {
            const parsed = await this._readAndValidate(file);
            if (!parsed.ok) { diary.toast(diary.t(parsed.errorKey), 'error'); return; }
            SidebarUI.close();
            this._setBusy('sbImportRow', false);
            await DataDialog.confirm({
                icon: '⚠️',
                title: diary.t('import-confirm-title'),
                desc: diary.t('import-confirm-desc'),
                details: this._summaryLines(parsed),
                confirmLabel: diary.t('import-confirm-btn'),
                run: () => this._runImport(parsed.data),
            });
        } catch (e) {
            console.error('[BackupManager] import failed:', e);
            diary.toast(diary.t('err-import-read'), 'error');
        } finally {
            this._busy = false;
            this._setBusy('sbImportRow', false);
        }
    },

    async _readAndValidate(file) {
        if (file.size === 0) return { ok: false, errorKey: 'err-import-empty' };
        if (file.size > this.MAX_FILE_BYTES) return { ok: false, errorKey: 'err-import-toolarge' };
        let text;
        try {
            text = typeof file.text === 'function' ? await file.text() : await this._readWithReader(file);
        } catch (e) { return { ok: false, errorKey: 'err-import-read' }; }
        return this.parse(text);
    },

    _readWithReader(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(r.error);
            r.readAsText(file);
        });
    },

    /** @returns {ParseOk|ParseFail} */
    parse(text) {
        text = String(text).replace(/^\uFEFF/, '');
        if (!text.trim()) return { ok: false, errorKey: 'err-import-empty' };
        let json;
        try { json = JSON.parse(text); } catch (e) { return { ok: false, errorKey: 'err-import-parse' }; }
        if (!this._isObj(json) || json.app !== this.APP_ID) return { ok: false, errorKey: 'err-import-format' };
        if (typeof json.format !== 'number' || !Number.isInteger(json.format) || json.format < 1) return { ok: false, errorKey: 'err-import-corrupt' };
        if (json.format > this.FORMAT_VERSION) return { ok: false, errorKey: 'err-import-version' };
        if (!this._isObj(json.data)) return { ok: false, errorKey: 'err-import-corrupt' };
        try {
            const data = this._sanitize(json.data);
            return { ok: true, data, exportedAt: typeof json.exportedAt === 'string' ? json.exportedAt : '' };
        } catch (e) {
            return { ok: false, errorKey: 'err-import-corrupt' };
        }
    },

    _summaryLines(parsed) {
        const d = parsed.data;
        /** @type {Array<[string, string]>} */
        const lines = [
            [diary.t('bk-notes'), String(d.notes.length)],
            [diary.t('bk-habits'), String(d.habits.length)],
            [diary.t('bk-memories'), String(d.memories.length)],
            [diary.t('bk-task-days'), String(Object.keys(d.tasks.days).length)],
        ];
        const when = parsed.exportedAt ? new Date(parsed.exportedAt) : null;
        if (when && !isNaN(when.getTime())) lines.push([diary.t('bk-created'), Util.localDateTimeStr(when)]);
        return lines;
    },

    // ── Validation: every collection is REBUILT from whitelisted, type-checked
    //    fields, so a hand-edited or hostile file can't inject unexpected
    //    properties into app state or storage. Throws on any structural problem.
    _isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); },
    _str(v, max = 100000) { if (typeof v !== 'string' || v.length > max) throw new Error('bad string'); return v; },
    _optStr(v, max) { return v == null ? '' : this._str(v, max); },
    _num(v) { if (typeof v !== 'number' || !isFinite(v)) throw new Error('bad number'); return v; },
    _bool(v) { return v === true; },
    _date(v) { if (typeof v !== 'string' || !this._DATE_RE.test(v)) throw new Error('bad date'); return v; },
    _optDate(v) { return v == null || v === '' ? null : this._date(v); },
    _arr(v) { if (!Array.isArray(v)) throw new Error('not array'); return v; },

    _uniqueIds(list) {
        const seen = new Set();
        for (const it of list) { if (seen.has(it.id)) throw new Error('duplicate id'); seen.add(it.id); }
        return list;
    },

    _sanitize(d) {
        const notes = this._uniqueIds(this._arr(d.notes).map(n => {
            if (!this._isObj(n)) throw new Error('bad note');
            return {
                id: this._num(n.id), title: this._str(n.title, 2000), content: this._str(n.content),
                category: this._NOTE_CATS.includes(n.category) ? n.category : 'personal',
                date: this._optStr(n.date, 100), pinned: this._bool(n.pinned),
            };
        }));

        const habits = this._uniqueIds(this._arr(d.habits).map(h => {
            if (!this._isObj(h)) throw new Error('bad habit');
            const goal = this._num(h.goal);
            if (goal < 1) throw new Error('bad goal');
            return {
                id: this._num(h.id), name: this._str(h.name, 2000), startDate: this._date(h.startDate),
                endDate: this._optDate(h.endDate), goal: Math.floor(goal),
                description: this._optStr(h.description), pinned: this._bool(h.pinned),
                completedDays: Array.from(new Set(this._arr(h.completedDays).map(x => this._date(x)))),
            };
        }));

        const memories = this._uniqueIds(this._arr(d.memories).map(m => {
            if (!this._isObj(m)) throw new Error('bad memory');
            return {
                id: this._num(m.id), title: this._str(m.title, 2000),
                type: this._MEM_TYPES.includes(m.type) ? m.type : 'other',
                startDate: this._optDate(m.startDate) || '', endDate: this._optDate(m.endDate),
                notes: this._optStr(m.notes), partnerName: this._optStr(m.partnerName, 2000),
                date: this._optStr(m.date, 100), pinned: this._bool(m.pinned),
                events: (m.events == null ? [] : this._arr(m.events)).map(ev => {
                    if (!this._isObj(ev)) throw new Error('bad event');
                    return { date: this._date(ev.date), desc: this._optStr(ev.desc, 20000) };
                }),
            };
        }));

        if (!this._isObj(d.settings)) throw new Error('bad settings');
        const settings = {
            lang: d.settings.lang === 'ru' || d.settings.lang === 'en' ? d.settings.lang : null,
            theme: d.settings.theme === 'dark' || d.settings.theme === 'orange' ? d.settings.theme : null,
            nickname: this._optStr(d.settings.nickname, 200),
        };

        if (!this._isObj(d.streak)) throw new Error('bad streak');
        const streak = {
            fireStreak: Math.max(0, Math.floor(this._num(d.streak.fireStreak))),
            lastActiveDate: d.streak.lastActiveDate ? this._date(d.streak.lastActiveDate) : '',
            streakLog: (d.streak.streakLog == null ? [] : this._arr(d.streak.streakLog)).map(x => this._date(x)).slice(-90),
        };

        if (!this._isObj(d.tasks) || !this._isObj(d.tasks.days)) throw new Error('bad tasks');
        /** @type {Record<string, any>} */
        const days = {};
        for (const date of Object.keys(d.tasks.days)) {
            this._date(date);
            const day = d.tasks.days[date];
            if (!this._isObj(day)) throw new Error('bad day');
            const tasks = this._arr(day.tasks).map(t => {
                if (!this._isObj(t)) throw new Error('bad task');
                return {
                    id: this._num(t.id), text: this._str(t.text, 20000), important: this._bool(t.important),
                    completed: this._bool(t.completed),
                    completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
                    createdAt: typeof t.createdAt === 'string' ? t.createdAt : '',
                };
            });
            days[date] = {
                tasks, mood: this._optStr(day.mood, 50),
                countedActive: this._bool(day.countedActive), countedPerfect: this._bool(day.countedPerfect),
            };
        }
        const st = this._isObj(d.tasks.stats) ? d.tasks.stats : {};
        const n0 = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0);
        const stats = {
            totalCompletedAllTime: n0(st.totalCompletedAllTime), totalTasksAddedAllTime: n0(st.totalTasksAddedAllTime),
            maxCompletedInSingleDay: n0(st.maxCompletedInSingleDay), activeDaysCount: n0(st.activeDaysCount),
            hadPerfectDay: this._bool(st.hadPerfectDay), currentStreak: n0(st.currentStreak),
            longestStreak: n0(st.longestStreak),
            lastStreakDate: st.lastStreakDate && this._DATE_RE.test(st.lastStreakDate) ? st.lastStreakDate : '',
        };

        if (!this._isObj(d.achievements)) throw new Error('bad achievements');
        /** @type {Record<string, {earned: boolean, earnedDate: string}>} */
        const achState = {};
        const rawState = this._isObj(d.achievements.state) ? d.achievements.state : {};
        for (const id of Object.keys(rawState)) {
            const a = rawState[id];
            if (/^[\w-]{1,64}$/.test(id) && this._isObj(a) && a.earned === true) {
                achState[id] = { earned: true, earnedDate: typeof a.earnedDate === 'string' ? a.earnedDate.slice(0, 40) : '' };
            }
        }
        const custom = this._uniqueIds((d.achievements.custom == null ? [] : this._arr(d.achievements.custom)).map(a => {
            if (!this._isObj(a)) throw new Error('bad custom achievement');
            return {
                id: this._num(a.id), icon: this._str(a.icon, 50), title: this._str(a.title, 2000),
                desc: this._optStr(a.desc, 20000), completed: this._bool(a.completed),
                earnedDate: typeof a.earnedDate === 'string' ? a.earnedDate : null,
                createdAt: typeof a.createdAt === 'string' ? a.createdAt : '',
            };
        }));

        return {
            notes, habits, memories, settings, streak,
            tasks: { days, stats },
            achievements: { state: achState, custom },
            actionLog: Array.isArray(d.actionLog) ? ActionLog.sanitize(d.actionLog) : null,
        };
    },

    // ── Applying ──
    /** Runs while the confirm dialog shows its spinner. Never throws — reports via toast. */
    async _runImport(data) {
        let snapshot;
        try {
            snapshot = (await this.collect()).data;
        } catch (e) {
            console.error('[BackupManager] could not snapshot current data; import aborted:', e);
            diary.toast(diary.t('err-import-generic'), 'error');
            return;
        }
        ActionLog._muted = true;
        try {
            await this._apply(data);
            ActionLog._muted = false;
            ActionLog.record('data_imported');
            diary.toast(diary.t('import-toast-ok'));
        } catch (e) {
            console.error('[BackupManager] apply failed, rolling back:', e);
            try {
                await this._apply(this._sanitize(snapshot));
                diary.toast(diary.t('err-import-apply'), 'error');
            } catch (e2) {
                console.error('[BackupManager] rollback failed:', e2);
                diary.toast(diary.t('err-import-fatal'), 'error');
            }
        } finally {
            ActionLog._muted = false;
        }
    },

    async _apply(d) {
        // Notes / habits / memories: saveCollection diffs against the last snapshot,
        // so shards that no longer exist are removed and new ones written.
        diary.notes    = diary._sortPinned(d.notes);
        diary.habits   = diary._sortPinned(d.habits);
        diary.memories = diary._sortPinned(d.memories);
        await Promise.all([
            StorageManager.saveCollection('notes', diary.notes),
            StorageManager.saveCollection('habits', diary.habits),
            StorageManager.saveCollection('memories', diary.memories),
        ]);

        // Streak
        diary.fireStreak = d.streak.fireStreak;
        diary.lastActiveDate = d.streak.lastActiveDate;
        diary.streakLog = d.streak.streakLog.slice();
        await diary._saveStreak();

        // Tasks: remove every existing day shard (including any not in the index), then write the imported ones.
        const orphans = Object.keys(TaskManager._data).filter(k => !(k in TaskManager._summary));
        await Promise.all(orphans.map(k => StorageManager.removeItem('task_day_' + k)));
        await TaskManager.wipeAll();
        const dates = Object.keys(d.tasks.days);
        dates.forEach(date => {
            TaskManager._data[date] = d.tasks.days[date];
            TaskManager._recomputeSummaryFor(date);
        });
        TaskManager._stats = { ...d.tasks.stats };
        await Promise.all([
            ...dates.map(date => StorageManager.setItem('task_day_' + date, JSON.stringify(TaskManager._data[date]))),
            StorageManager.setItem('task_index', JSON.stringify(TaskManager._summary)),
            StorageManager.setItem('task_stats', JSON.stringify(TaskManager._stats)),
        ]);
        TaskManager._viewDate = null;
        await TaskManager._loadDay(TaskManager.today());

        // Achievements
        AchievementsUI._state = { ...d.achievements.state };
        AchievementsUI._custom = d.achievements.custom.map(a => ({ ...a }));
        AchievementsUI._save();
        AchievementsUI._saveCustom();
        AchievementsUI._renderCustom();

        // Settings
        SidebarUI.profile.nickname = d.settings.nickname;
        await StorageManager.setItem('userNickname', d.settings.nickname);
        if (d.settings.theme && d.settings.theme !== diary.theme) diary.applyTheme(d.settings.theme);
        if (d.settings.lang && d.settings.lang !== diary.lang) diary.applyLang(d.settings.lang);

        // Action history (only when the backup carries one)
        if (d.actionLog) await ActionLog.replaceAll(d.actionLog);

        this._refreshUI();
    },

    _refreshUI() {
        diary.openNoteDetail = diary.openHabitDetail = diary.openMemoryDetail = null;
        diary._resetNoteForm();
        diary._resetHabitForm();
        diary._resetMemoryForm();
        diary.renderAll();
        diary.updateFooter();
        TaskManager.render();
        SidebarUI._updateHeaderDisplay();
        ActionHistoryUI.render();
    },

    // ── small UI helpers ──
    _setBusy(rowId, busy) {
        const row = document.getElementById(rowId);
        if (!row) return;
        row.classList.toggle('is-busy', busy);
        const arrow = row.querySelector('.sidebar-item-arrow');
        if (arrow) arrow.textContent = busy ? '⏳' : '›';
    },

    applyTranslations() {
        const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = diary.t(key); };
        set('sb-lbl-data', 'sb-lbl-data');
        set('sb-item-export', 'sb-item-export');
        set('sb-item-import', 'sb-item-import');
        set('sb-item-history', 'sb-item-history');
        set('sb-data-hint', 'sb-data-hint');
        set('dcCancel', 'dc-cancel');
        ActionHistoryUI.applyTranslations();
    },
};


// ================================================================
//  DataDialog — one reusable confirmation modal (import overwrite,
//  clear history). Optional `run` keeps the dialog open with a
//  spinner while an async job executes.
// ================================================================
const DataDialog = {
    _resolve: null,
    _running: false,

    /**
     * @param {{icon?: string, title: string, desc: string, details?: Array<[string,string]>, confirmLabel: string, run?: () => Promise<void>}} opts
     * @returns {Promise<boolean>}
     */
    confirm(opts) {
        if (this._resolve) this._finish(false);
        const $ = (id) => document.getElementById(id);
        $('dcIcon').textContent = opts.icon || '⚠️';
        $('dcTitle').textContent = opts.title;
        $('dcDesc').textContent = opts.desc;
        const det = $('dcDetails');
        det.innerHTML = (opts.details || []).map(([k, v]) =>
            `<div class="dc-line"><span>${Util.escHtml(k)}</span><b>${Util.escHtml(v)}</b></div>`).join('');
        det.style.display = opts.details && opts.details.length ? 'block' : 'none';
        const ok = /** @type {HTMLButtonElement} */ ($('dcConfirm'));
        const cancel = /** @type {HTMLButtonElement} */ ($('dcCancel'));
        ok.textContent = opts.confirmLabel; ok.disabled = false; cancel.disabled = false;
        cancel.textContent = diary.t('dc-cancel');
        this._run = opts.run || null;
        $('dataConfirmModal').classList.add('open');
        return new Promise(resolve => { this._resolve = resolve; });
    },

    _run: null,

    async onConfirm() {
        if (this._running) return;
        const ok = /** @type {HTMLButtonElement} */ (document.getElementById('dcConfirm'));
        const cancel = /** @type {HTMLButtonElement} */ (document.getElementById('dcCancel'));
        if (this._run) {
            this._running = true;
            const label = ok.textContent;
            ok.disabled = true; cancel.disabled = true; ok.textContent = '⏳';
            try { await this._run(); } catch (e) { console.error('[DataDialog] job failed:', e); }
            this._running = false;
            ok.textContent = label;
        }
        this._finish(true);
    },

    onCancel() {
        if (this._running) return;
        this._finish(false);
    },

    _finish(result) {
        const m = document.getElementById('dataConfirmModal');
        if (m) m.classList.remove('open');
        const r = this._resolve;
        this._resolve = null;
        this._run = null;
        if (r) r(result);
    },
};
