// ================================================================
//  DIARY — notes, habits, archive (memories), streaks, theme and language.
//  Rendering, form handling and persistence for the main app surface.
// ================================================================
const diary = {
    notes:          [],
    habits:         [],
    memories:       [],
    lang:           'en',
    theme:          'orange',
    fireStreak:     0,
    lastActiveDate: '',
    streakLog:      [], // recent local dates ('YYYY-MM-DD') that extended/kept the fire streak alive
    // v9.3: Day Streak Freezes. Each calendar month (local time) grants FREEZES_PER_MONTH
    // freezes. See updateStreak() for the auto-consume rules.
    FREEZES_PER_MONTH: 2,
    FREEZE_LOG_MAX:    36,
    freezeCount:    2,  // freezes remaining in freezeMonth (never < 0, never > FREEZES_PER_MONTH)
    freezeMonth:    '', // 'YYYY-MM' (local) the current allowance belongs to; '' = not initialised yet
    freezeLog:      [], // local dates ('YYYY-MM-DD') of MISSED days that a freeze covered (calendar marks them)
    _streakSaveChain: Promise.resolve(), // v9.3: serialises streak/freeze writes (see _queueStreakSave)
    tempEndHabitId:    null,
    tempEndRelationsId: null,
    openNoteDetail:   null,
    openHabitDetail:  null,
    openMemoryDetail: null,
    // v9.5: Archive type filter. View-only state (never stored): 'all' or one of MEMORY_TYPES.
    MEMORY_TYPES:     ['book','movie','series','game','relations','other'],
    memoryFilter:     'all',
    _calHabitId:    null,  // which habit's calendar modal is currently open
    _calYear:       null,  // year shown in the habit calendar modal
    _calMonth:      null,  // 0-indexed month shown in the habit calendar modal
    _streakCalYear:  null,  // year shown in the fire-streak calendar modal
    _streakCalMonth: null,  // 0-indexed month shown in the fire-streak calendar modal
    _habitTimerInterval: null, // live countdown ticker, only runs while the Habits tab is open and the app is visible
    NOTE_CATS:      ['personal','work','ideas'],
    // Page background per theme (must equal --bg in css/styles.css) — used to colour Telegram's own header/bar.
    THEME_CHROME:   { orange: '#f4efe8', dark: '#121419' },
    _themeExplicit: false, // true once the person (or a saved setting) chose a theme; until then Telegram's scheme is followed
    _inited:        false, // one-time event wiring done (init() can run again after a vault reset)
    _toastTimer:    null,
    _tab:           'notes',

    t(key) { return (T[this.lang] || T.en)[key] || key; },
    today() { return Util.localDateStr(); }, // FIX: was toISOString() (UTC) — see Util comment

    fmtDate(d) {
        if (!d) return '';
        // v9.5 FIX: new Date('YYYY-MM-DD') is UTC midnight, so west of UTC the label showed the
        // PREVIOUS day. Plain date strings are now read as local calendar dates (see Util.parseLocalDate).
        const dt = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Util.parseLocalDate(d) : new Date(d);
        return dt.toLocaleDateString(
            this.lang === 'ru' ? 'ru-RU' : 'en-GB',
            { day: 'numeric', month: 'short', year: 'numeric' }
        );
    },

    toast(text, type = 'success') {
        document.querySelectorAll('.toast-msg').forEach(t => t.remove());
        clearTimeout(this._toastTimer);
        const el = document.createElement('div');
        el.className = `toast-msg toast-${type}`;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.textContent = text;
        document.body.appendChild(el);
        this._toastTimer = setTimeout(() => el.remove(), 2700);
    },

    /** In-app confirmation (replaces window.confirm, which some WebViews suppress or style inconsistently).
     *  @returns {Promise<boolean>} */
    ask(messageKey, { icon = '🗑️', confirmKey = 'lbl-delete' } = {}) {
        return DataDialog.confirm({
            icon, title: this.t('dlg-confirm-title'), desc: this.t(messageKey), confirmLabel: this.t(confirmKey),
        });
    },

    closeModals() {
        document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
    },

    openSheet(mode) {
        const th = document.getElementById('sheetThemeSection');
        const la = document.getElementById('sheetLangSection');
        if (mode === 'theme') { th.style.display='block'; la.style.display='none'; }
        else                  { th.style.display='none';  la.style.display='block'; }
        this._updateSheetChecks();
        document.getElementById('sheetOverlay').classList.add('open');
        document.getElementById('bottomSheet').classList.add('open');
    },

    closeSheet() {
        document.getElementById('sheetOverlay').classList.remove('open');
        document.getElementById('bottomSheet').classList.remove('open');
    },

    _updateSheetChecks() {
        ['Orange','Dark'].forEach(t => {
            const o = document.getElementById('sheetOpt' + t);
            if (o) o.classList.toggle('active', this.theme === t.toLowerCase());
        });
        ['En','Ru'].forEach(l => {
            const o = document.getElementById('sheetOpt' + l);
            if (o) o.classList.toggle('active', this.lang === l.toLowerCase());
        });
    },

    /** Paints the theme: body class, browser/Telegram chrome colours, and the (non-sensitive) lock-screen hint. */
    _paintTheme() {
        document.body.classList.toggle('theme-dark', this.theme === 'dark');
        try { localStorage.setItem('dbmix_theme_hint', this.theme); } catch (e) { /* storage blocked */ }
        TGPlatform.syncChrome(this.THEME_CHROME[this.theme] || this.THEME_CHROME.orange);
    },

    applyTheme(theme, { silent = false } = {}) {
        if (theme !== 'dark') theme = 'orange';
        if (theme !== this.theme && !silent) ActionLog.record('theme_changed');
        this.theme = theme;
        this._paintTheme();
        if (!silent) {
            this._themeExplicit = true;
            StorageManager.setItem('theme', theme).catch(e => DBLog.warn('Storage', 'Theme preference could not be saved.', e));
        }
        this._updateSheetChecks();
        this._updateSettingsBar();
        this.closeSheet();
    },

    applyLang(lang) {
        if (lang !== 'ru') lang = 'en';
        if (lang !== this.lang) ActionLog.record('language_changed');
        this.lang = lang;
        document.documentElement.lang = lang;
        try { localStorage.setItem('dbmix_lang_hint', lang); } catch (e) { /* storage blocked */ }
        StorageManager.setItem('lang', lang).catch(e => DBLog.warn('Storage', 'Language preference could not be saved.', e));
        this._updateSheetChecks();
        this.applyTranslations();
        this.renderAll();
        TaskManager.render(); // the Tasks tab has its own labels (placeholder, mood, calendar, stats)
        this.closeSheet();
        SidebarUI.applyTranslations(lang);
        AchievementsUI.applyTranslations(lang);
        EncryptionManager.applyLang(lang);
    },

    _updateSettingsBar() {
        const icons = { orange: '☀️', dark: '🌙' };
        const el = document.getElementById('theme-icon');
        if (el) el.textContent = icons[this.theme] || '☀️';
    },

    applyTranslations() {
        const ids = [
            'app-desc','tab-notes','tab-habits','tab-memory','tab-tasks',
            'lang-btn-label','theme-btn-label',
            'sheet-theme-title','sheet-theme-orange','sheet-theme-orange-sub',
            'sheet-theme-dark','sheet-theme-dark-sub','sheet-lang-title',
            'my-notes-title','clear-all-txt',
            'my-habits-title','my-memories-title',
            'calendar-hint','end-habit-title','add-event-title',
            'end-relations-title','end-relations-hint',
            'lbl-note-title','lbl-note-cat','lbl-note-content',
            'lbl-habit-name','lbl-start-date','lbl-end-date','lbl-goal-days','lbl-habit-desc',
            'lbl-mem-title','lbl-mem-type','lbl-partner-name',
            'lbl-mem-start','lbl-mem-end','lbl-mem-notes',
            'lbl-event-date','lbl-event-desc',
            'save-note-btn-txt','start-habit-btn-txt','save-memory-btn-txt','save-event-btn-txt',
            'stat-notes-lbl','stat-habits-lbl','stat-mem-lbl','stat-tasks-lbl',
            'cancel-btn-1','cancel-btn-2','cancel-btn-3',
            'tasks-section-title',
        ];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = this.t(id);
        });

        const ceh = document.getElementById('confirm-end-habit-btn');
        if (ceh) ceh.textContent = this.t('lbl-end');
        const cbk = document.getElementById('confirm-breakup-btn');
        if (cbk) cbk.textContent = this.t('lbl-confirm');

        const editingNote = document.getElementById('noteId').value;
        document.getElementById('noteFormTitle').textContent = this.t(editingNote ? 'noteFormTitle-edit' : 'noteFormTitle-new');
        document.getElementById('noteFormIcon').textContent  = editingNote ? '✏️' : '✍️';

        const editingHabit = document.getElementById('habitId').value;
        document.getElementById('habitFormTitle').textContent = this.t(editingHabit ? 'habitFormTitle-edit' : 'habitFormTitle-new');

        const editingMemory = document.getElementById('memoryId').value;
        document.getElementById('memoryFormTitle').textContent = this.t(editingMemory ? 'memoryFormTitle-edit' : 'memoryFormTitle-new');

        const ph = (id, key) => { const el = document.getElementById(id); if(el) el.placeholder = this.t(key); };
        ph('noteTitle',        'noteTitle-ph');
        ph('noteContent',      'noteContent-ph');
        ph('habitName',        'habitName-ph');
        ph('habitDescription', 'habitDescription-ph');
        ph('memoryTitle',      'memoryTitle-ph');
        ph('partnerName',      'partnerName-ph');
        ph('memoryNotes',      'memoryNotes-ph');
        ph('notesSearch',      'notesSearch-ph');
        ph('habitsSearch',     'habitsSearch-ph');
        ph('memoriesSearch',   'memoriesSearch-ph');
        ph('tasksSearch',      'tasksSearch-ph');
        ph('eventDesc',        'eventDesc-ph');
        ph('taskQuickInput',   'tasks-quick-ph');

        const nc = document.getElementById('noteCategory');
        if (nc) nc.innerHTML = ['personal','work','ideas']
            .map(v => `<option value="${v}">${this.t('cat-'+v)}</option>`).join('');

        const fc = document.getElementById('filterCategory');
        if (fc) fc.innerHTML = `<option value="all">${this.t('cat-all')}</option>` +
            ['personal','work','ideas'].map(v => `<option value="${v}">${this.t('cat-'+v)}</option>`).join('');

        const mt = document.getElementById('memoryType');
        if (mt) mt.innerHTML = this.MEMORY_TYPES
            .map(v => `<option value="${v}">${this.t('type-'+v)}</option>`).join('');

        this._renderMemoryFilter(); // v9.5: Archive type chips (translated labels)

        this._updateSettingsBar();
    },

    async load() {
        const data = await StorageManager.getItems([
            'lang','theme','fireStreak','lastActiveDate','streakLog',
            'freezeCount','freezeMonth','freezeLog'
        ]);

        // v6: notes/habits/memories are now sharded (one key per item) instead
        // of one ever-growing blob. loadCollection() transparently migrates
        // any existing v5 blob the first time it's called.
        const [notesArr, habitsArr, memoriesArr] = await Promise.all([
            StorageManager.loadCollection('notes'),
            StorageManager.loadCollection('habits'),
            StorageManager.loadCollection('memories'),
        ]);
        this.notes     = this._sortPinned(notesArr);
        this.habits    = this._sortPinned(habitsArr);
        this.memories  = this._sortPinned(memoriesArr);

        if (data.lang)  this.lang  = data.lang === 'ru' ? 'ru' : 'en';
        if (data.theme) { this.theme = data.theme === 'dark' ? 'dark' : 'orange'; this._themeExplicit = true; }
        else if (TGPlatform.colorScheme() === 'dark') this.theme = 'dark'; // first launch: follow Telegram until the person chooses
        // v9.3 null-guard: parseInt('garbage') is NaN, which would render "NaN" in the
        // header and poison every later `fireStreak + 1`.
        this.fireStreak     = parseInt(data.fireStreak || '0', 10) || 0;
        this.lastActiveDate = data.lastActiveDate || '';
        try { this.streakLog = data.streakLog ? JSON.parse(data.streakLog) : []; } catch (e) { this.streakLog = []; }
        if (!Array.isArray(this.streakLog)) this.streakLog = [];

        // v9.3: freezes. Missing keys (first launch, or upgrading from v9.2) → initialised
        // to a full allowance for the current month; a stale month is refilled here too.
        let rawFreezeLog = [];
        try { rawFreezeLog = data.freezeLog ? JSON.parse(data.freezeLog) : []; } catch (e) { rawFreezeLog = []; }
        if (this._setFreezeState(data.freezeCount, data.freezeMonth, rawFreezeLog)) {
            this._saveFreezes().catch(e => DBLog.warn('Streak', 'Freeze allowance could not be saved.', e));
        }

        this._paintTheme();
        document.documentElement.lang = this.lang;
        try { localStorage.setItem('dbmix_lang_hint', this.lang); } catch (e) { /* storage blocked */ }

        this.applyTranslations();
        this._updateSheetChecks();
        this.renderAll();
        this.updateFooter();

        // Load tasks
        await TaskManager.load();
        TaskManager.render();
        DBLog.info('Storage', 'Local data loaded successfully.');
    },

    _sortPinned(arr) {
        return [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    },

    // BUG FIX: a habit used to be treated as "finished" the instant it had ANY
    // endDate at all — including a planned end date the person picked in the
    // FUTURE when creating the habit. That made the widget immediately
    // non-interactive (can't mark days) even though the tracking window
    // hadn't started yet, let alone ended.
    //
    // Correct rule: a habit is finished when (a) its goal has already been
    // reached, or (b) its planned end date has actually passed. The end date
    // itself is treated as INCLUSIVE — the last day it's still fully
    // interactive — so it only flips to "finished" starting the day AFTER
    // that date. (Chosen because "track this until March 31" reads as
    // including March 31 itself; the alternative, exclusive reading, would
    // silently cut a day off the goal the person set.)
    isHabitFinished(h) {
        if (h.completedDays.length >= h.goal) return true;
        return !!h.endDate && h.endDate < this.today();
    },

    // Each save* persists one collection, ALWAYS re-renders (so the screen matches memory), and returns
    // whether the write succeeded. A failed write is reported to the person and retried on the next save.
    _saveFailed(e) { DBLog.error('Storage', 'Changes could not be saved.', e); this.toast(this.t('err-save'), 'error'); },
    async _saveCollection(category, items, render) {
        try { await StorageManager.saveCollection(category, items); return true; }
        catch (e) { this._saveFailed(e); return false; }
        finally { render.call(this); this.updateFooter(); }
    },
    saveNotes()    { return this._saveCollection('notes',    this.notes,    this.renderNotes); },
    saveHabits()   { return this._saveCollection('habits',   this.habits,   this.renderHabits); },
    saveMemories() { return this._saveCollection('memories', this.memories, this.renderMemories); },

    TAB_BUTTONS: { notes: 'notesTab', habits: 'habitsTab', tasks: 'tasksTabBtn', memory: 'memoryTab' },
    switchTab(tab) {
        if (!this.TAB_BUTTONS[tab]) return;
        this._tab = tab;
        Object.keys(this.TAB_BUTTONS).forEach(t => {
            document.getElementById(t + 'Section').classList.toggle('hidden', t !== tab);
            const btn = document.getElementById(this.TAB_BUTTONS[t]);
            if (btn) { btn.classList.toggle('active', t === tab); btn.setAttribute('aria-selected', t === tab ? 'true' : 'false'); btn.tabIndex = t === tab ? 0 : -1; }
        });
        // Refresh tasks when switching to that tab
        if (tab === 'tasks') {
            // v9.1 BUG FIX: v9.0 called this.updateStreak() here, so merely
            // OPENING the Tasks tab extended the fire streak. That made the
            // streak trivially easy. Viewing the tab must never touch the
            // streak — it is now extended only by a real action, from
            // TaskManager.quickAdd() (task created) and
            // TaskManager.toggleTask() (task marked completed).
            TaskManager.render();
        }
        // Live habit countdowns only tick while the Habits tab is actually open
        if (tab === 'habits') this._startHabitTimers();
        else this._stopHabitTimers();
    },

    // ---------- live countdown timers for active habits (no endDate) ----------
    _startHabitTimers() {
        this._stopHabitTimers();
        if (document.visibilityState === 'hidden') return; // resumed by the visibility handler
        this._tickHabitTimers();
        this._habitTimerInterval = setInterval(() => this._tickHabitTimers(), 1000);
    },
    _stopHabitTimers() {
        if (this._habitTimerInterval) { clearInterval(this._habitTimerInterval); this._habitTimerInterval = null; }
    },
    _habitCountdownTarget(h) {
        // "planned end of the tracker": startDate + goal (days). If the goal is
        // already reached, there's nothing left to count down to.
        const plannedEndDate = Util.addDays(h.startDate, h.goal);
        // Count down to the END of that day (local midnight of the next day).
        return Util.parseLocalDate(plannedEndDate).getTime() + 86400000;
    },
    _tickHabitTimers() {
        document.querySelectorAll('.habit-countdown[data-target]').forEach(el => {
            const target = +el.dataset.target;
            const remaining = target - Date.now();
            const valueEl = el.querySelector('.habit-countdown-value');
            if (!valueEl) return;
            if (remaining <= 0) {
                el.classList.add('completed');
                valueEl.textContent = this.t('habit-countdown-completed');
                return;
            }
            const s = Math.floor(remaining / 1000);
            const days = Math.floor(s / 86400);
            const hours = Math.floor((s % 86400) / 3600);
            const mins = Math.floor((s % 3600) / 60);
            const secs = s % 60;
            const dU = this.t('habit-countdown-d'), hU = this.t('habit-countdown-h'), mU = this.t('habit-countdown-m'), sU = this.t('habit-countdown-s');
            valueEl.textContent = `${days}${dU} ${String(hours).padStart(2,'0')}${hU} ${String(mins).padStart(2,'0')}${mU} ${String(secs).padStart(2,'0')}${sU}`;
        });
    },
    _renderHabitCountdown(h) {
        if (h.endDate) return ''; // only "active" habits (no endDate) get a live timer
        const done = h.completedDays.length;
        if (done >= h.goal) {
            return `<div class="habit-countdown completed"><span class="habit-countdown-value">${this.t('habit-countdown-completed')}</span></div>`;
        }
        const target = this._habitCountdownTarget(h);
        if (target <= Date.now()) {
            return `<div class="habit-countdown completed"><span class="habit-countdown-value">${this.t('habit-countdown-completed')}</span></div>`;
        }
        return `<div class="habit-countdown" data-target="${target}">
                    <span class="habit-countdown-value">…</span>
                    <span class="habit-countdown-label">${this.t('habit-countdown-left')}</span>
                </div>`;
    },

    updateFooter() {
        document.getElementById('notesCount').textContent   = this.notes.length;
        document.getElementById('habitsCount').textContent  = this.habits.length;
        document.getElementById('activeHabitsCount').textContent = this.habits.filter(h => !this.isHabitFinished(h)).length;
        document.getElementById('memoriesCount').textContent = this.memories.length;
        document.getElementById('tasksCount').textContent   = TaskManager.totalTasks();
        document.getElementById('fireStreakHeader').textContent  = this.fireStreak;
        this._renderFreezeBadge();
        if (typeof AchievementsUI !== 'undefined') AchievementsUI.recalculate();
    },

    renderAll() {
        this.renderNotes();
        this.renderHabits();
        this.renderMemories();
        this.updateFooter();
    },

    // ---------- shared render helpers ----------
    _emptyState(icon, msg) {
        return `<div class="empty-state"><div class="empty-icon" aria-hidden="true">${icon}</div><p>${msg}</p></div>`;
    },
    /** Escapes text for innerHTML and wraps search matches in <mark>. */
    _hl(text, search, raw) {
        const esc = Util.escHtml(text);
        return search ? Util.highlightMatch(esc, raw) : esc;
    },
    /** Card entrance animation plays only when the visible set of cards changes — NOT when a
     *  card is merely expanded/collapsed (which used to replay the animation on every card). */
    _setListKey(container, key) {
        const changed = container._key !== key;
        container._key = key;
        container.classList.toggle('list-enter', changed);
    },
    _onSearch: {},
    /** Debounced search-as-you-type: one re-render per pause instead of one per keystroke. */
    onSearch(kind) {
        if (!this._onSearch[kind]) {
            const fn = { notes: () => this.renderNotes(), habits: () => this.renderHabits(), memories: () => this.renderMemories(), tasks: () => TaskManager.render() }[kind];
            this._onSearch[kind] = Util.debounce(fn, 120);
        }
        this._onSearch[kind]();
    },

    async togglePin(type, id, event) {
        if (event) event.stopPropagation();
        const list = type === 'note' ? this.notes : type === 'habit' ? this.habits : this.memories;
        const item = list.find(x => x.id === id);
        if (!item) return;
        item.pinned = !item.pinned;
        const sorted = this._sortPinned(list);
        let ok;
        if (type === 'note')   { this.notes    = sorted; ok = await this.saveNotes(); }
        if (type === 'habit')  { this.habits   = sorted; ok = await this.saveHabits(); }
        if (type === 'memory') { this.memories = sorted; ok = await this.saveMemories(); }
        if (ok) this.toast(item.pinned ? this.t('toast-pinned') : this.t('toast-unpinned'));
    },

    toggleNoteDetail(id)   { this.openNoteDetail   = this.openNoteDetail   === id ? null : id; this.renderNotes(); },
    toggleHabitDetail(id)  { this.openHabitDetail  = this.openHabitDetail  === id ? null : id; this.renderHabits(); },
    toggleMemoryDetail(id) { this.openMemoryDetail = this.openMemoryDetail === id ? null : id; this.renderMemories(); },

    async saveNote(e) {
        e.preventDefault();
        if (this._submitting.note) return;
        const idRaw   = document.getElementById('noteId').value;
        const id      = idRaw ? +idRaw : Date.now();
        const title   = document.getElementById('noteTitle').value.trim();
        const category= document.getElementById('noteCategory').value;
        const content = document.getElementById('noteContent').value.trim();
        if (!title || !content) return this.toast(this.t('toast-fill-fields'), 'error');

        this._submitting.note = true;
        const prev = this.notes.slice();
        try {
            const note = {
                id, title, category: this.NOTE_CATS.includes(category) ? category : 'personal', content,
                date: new Date().toLocaleString(this.lang === 'ru' ? 'ru-RU' : 'en-GB'),
                pinned: false
            };
            const existing = this.notes.findIndex(n => n.id === id);
            const isNewNote = existing < 0;
            if (existing >= 0) { note.pinned = this.notes[existing].pinned; this.notes[existing] = note; }
            else this.notes.unshift(note);

            this.notes = this._sortPinned(this.notes);
            if (!(await this.saveNotes())) { this.notes = prev; this.renderNotes(); this.updateFooter(); return; }
            ActionLog.record(isNewNote ? 'note_created' : 'note_updated');
            this.updateStreak();
            this._resetNoteForm();
            this.toast(this.t('toast-note-saved'));
            DBLog.info('Diary', 'Changes saved successfully.');
        } finally { this._submitting.note = false; }
    },

    _submitting: {},

    _loadNoteToForm(note) {
        if (!note) return;
        document.getElementById('noteId').value      = note.id;
        document.getElementById('noteTitle').value   = note.title;
        document.getElementById('noteCategory').value= note.category;
        document.getElementById('noteContent').value = note.content;
        document.getElementById('noteFormTitle').textContent = this.t('noteFormTitle-edit');
        document.getElementById('noteFormIcon').textContent  = '✏️';
        document.getElementById('notesSection').scrollIntoView({ behavior: this._motion(), block: 'start' });
    },
    editNote(id, e) {
        if (e) e.stopPropagation();
        this._loadNoteToForm(this.notes.find(n => n.id === id));
        this.openNoteDetail = null; this.renderNotes();
    },
    /** 'smooth' unless the person prefers reduced motion. */
    _motion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; },

    async deleteNote(id, e) {
        if (e) e.stopPropagation();
        if (!(await this.ask('confirm-delete-note'))) return;
        const prev = this.notes;
        this.notes = this.notes.filter(n => n.id !== id);
        if (!(await this.saveNotes())) { this.notes = prev; this.renderNotes(); this.updateFooter(); return; }
        ActionLog.record('note_deleted');
        this.toast(this.t('toast-note-deleted'));
    },

    renderNotes() {
        const container  = document.getElementById('notesList');
        const searchRaw  = document.getElementById('notesSearch').value || '';
        const search     = searchRaw.trim().toLowerCase();
        const cat        = document.getElementById('filterCategory').value || 'all';

        let list = this.notes;
        if (cat !== 'all') list = list.filter(n => n.category === cat);
        // Search matches title, content, category label and the saved date.
        if (search) list = list.filter(n =>
            n.title.toLowerCase().includes(search) ||
            n.content.toLowerCase().includes(search) ||
            this.t('cat-' + n.category).toLowerCase().includes(search) ||
            (n.date || '').toLowerCase().includes(search));

        if (!list.length) {
            container._key = null;
            container.innerHTML = search ? this._emptyState('🔍', this.t('search-empty')) : this._emptyState('📝', this.t('notes-empty'));
            return;
        }
        this._setListKey(container, list.map(n => n.id).join(',') + '|' + search + '|' + cat);

        container.innerHTML = list.map((note, i) => {
            const id       = Number(note.id);
            const isOpen   = this.openNoteDetail === note.id;
            const catKey   = this.NOTE_CATS.includes(note.category) ? note.category : 'personal';
            const pinLabel = note.pinned ? this.t('lbl-unpin') : this.t('lbl-pin');
            return `
            <div class="record-card ${note.pinned ? 'pinned' : ''}" style="--i:${Math.min(i, 8)}" role="button" tabindex="0" aria-expanded="${isOpen}" onclick="diary.toggleNoteDetail(${id})">
                ${note.pinned ? '<span class="pin-badge" aria-hidden="true">📌</span>' : ''}
                <div class="rc-head">
                    <span class="cat-pill cat-${catKey}">${this.t('cat-' + catKey)}</span>
                    <span class="rc-date">${Util.escHtml(note.date)}</span>
                </div>
                <h3 class="rc-title">${this._hl(note.title, search, searchRaw)}</h3>
                <div class="rc-text${isOpen ? ' open' : ''}">${this._hl(note.content, search, searchRaw)}</div>
                ${isOpen ? `
                <div class="detail-panel" onclick="event.stopPropagation()">
                    <div class="action-row">
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.editNote(${id},event)">${this.t('lbl-edit')}</button>
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.togglePin('note',${id},event)">${pinLabel}</button>
                        <button type="button" class="btn-ghost btn-sm btn-danger" onclick="diary.deleteNote(${id},event)">${this.t('lbl-delete')}</button>
                    </div>
                </div>` : ''}
            </div>`;
        }).join('');
    },

    _resetNoteForm() {
        document.getElementById('noteForm').reset();
        document.getElementById('noteId').value = '';
        document.getElementById('noteFormTitle').textContent = this.t('noteFormTitle-new');
        document.getElementById('noteFormIcon').textContent  = '✍️';
    },

    async saveHabit(e) {
        e.preventDefault();
        if (this._submitting.habit) return;
        const idRaw= document.getElementById('habitId').value;
        const id   = idRaw ? +idRaw : Date.now();
        const name = document.getElementById('habitName').value.trim();
        const start= document.getElementById('habitStartDate').value;
        const end  = document.getElementById('habitEndDate').value || null;
        const goal = Math.floor(+document.getElementById('habitGoal').value);
        const desc = document.getElementById('habitDescription').value.trim();
        if (!name || !start || !(goal >= 1)) return this.toast(this.t('toast-fill-fields'), 'error');
        if (end && end < start) return this.toast(this.t('toast-bad-dates'), 'error');

        this._submitting.habit = true;
        const prev = this.habits.slice();
        try {
            const existing = this.habits.find(h => h.id === id);
            const habit = {
                id, name, startDate: start, endDate: end, goal, description: desc,
                completedDays: existing ? existing.completedDays : [],
                pinned: existing ? existing.pinned : false
            };
            const idx = this.habits.findIndex(h => h.id === id);
            const isNewHabit = idx < 0;
            if (idx >= 0) this.habits[idx] = habit;
            else this.habits.unshift(habit);

            this.habits = this._sortPinned(this.habits);
            if (!(await this.saveHabits())) { this.habits = prev; this.renderHabits(); this.updateFooter(); return; }
            ActionLog.record(isNewHabit ? 'habit_created' : 'habit_updated');
            this.updateStreak();
            this._resetHabitForm();
            this.toast(this.t('toast-habit-added'));
        } finally { this._submitting.habit = false; }
    },

    _loadHabitToForm(habit) {
        document.getElementById('habitId').value          = habit.id;
        document.getElementById('habitName').value        = habit.name;
        document.getElementById('habitStartDate').value   = habit.startDate;
        document.getElementById('habitEndDate').value     = habit.endDate || '';
        document.getElementById('habitGoal').value        = habit.goal;
        document.getElementById('habitDescription').value = habit.description || '';
        document.getElementById('habitFormTitle').textContent = this.t('habitFormTitle-edit');
        document.getElementById('habitsSection').scrollIntoView({ behavior:'smooth', block:'start' });
    },

    editHabit(id, e) {
        if (e) e.stopPropagation();
        this._loadHabitToForm(this.habits.find(h => h.id === id));
        this.openHabitDetail = null; this.renderHabits();
    },

    async deleteHabit(id, e) {
        if (e) e.stopPropagation();
        if (!(await this.ask('confirm-delete-habit'))) return;
        const prev = this.habits;
        this.habits = this.habits.filter(h => h.id !== id);
        if (!(await this.saveHabits())) { this.habits = prev; this.renderHabits(); this.updateFooter(); return; }
        ActionLog.record('habit_deleted');
        this.toast(this.t('toast-habit-deleted'));
    },

    async toggleDay(id, date, e) {
        if (e) e.stopPropagation();
        const h = this.habits.find(h => h.id === id);
        if (!h || this.isHabitFinished(h)) return;
        const prevDays = h.completedDays.slice(), prevEnd = h.endDate;
        const s = new Set(h.completedDays);
        const wasChecked = s.has(date);
        wasChecked ? s.delete(date) : s.add(date);
        h.completedDays = Array.from(s);
        if (h.completedDays.length >= h.goal) h.endDate = date;
        const ok = await this.saveHabits();
        if (!ok) { h.completedDays = prevDays; h.endDate = prevEnd; this.renderHabits(); this.updateFooter(); }
        else { ActionLog.record(wasChecked ? 'habit_unchecked' : 'habit_checked'); this.updateStreak(); }
        if (this._calHabitId === id && document.getElementById('calendarModal').classList.contains('open')) this._renderHabitCalendar();
    },

    endHabit(id, e) {
        if (e) e.stopPropagation();
        const h = this.habits.find(h => h.id === id);
        if (!h) return;
        this.tempEndHabitId = id;
        document.getElementById('endHabitName').textContent = h.name;
        document.getElementById('endHabitDate').value = h.endDate || this.today();
        document.getElementById('endHabitModal').classList.add('open');
    },

    async confirmEndHabit() {
        const h = this.habits.find(h => h.id === this.tempEndHabitId);
        const date = document.getElementById('endHabitDate').value || this.today();
        if (!h) return this.closeModals();
        if (date < h.startDate) return this.toast(this.t('toast-bad-dates'), 'error');
        const prev = h.endDate;
        h.endDate = date;
        if (!(await this.saveHabits())) { h.endDate = prev; this.renderHabits(); return; }
        this.closeModals();
    },

    // Month/year-navigable calendar for one habit; lets the person review and toggle any month.
    showCalendar(id, e) {
        if (e) e.stopPropagation();
        const habit = this.habits.find(h => h.id === id);
        if (!habit) return;
        this._calHabitId = id;
        const start = Util.parseLocalDate(habit.startDate);
        this._calYear = start.getFullYear();
        this._calMonth = start.getMonth();
        // If the habit already has history, land on the month of its most
        // recent completed day (or today, whichever is more useful) instead
        // of always starting back at month one.
        const todayStr = this.today();
        const mostRecent = habit.completedDays.length ? habit.completedDays.slice().sort().pop() : null;
        const landOn = habit.endDate || mostRecent || (habit.startDate <= todayStr ? todayStr : habit.startDate);
        const landDate = Util.parseLocalDate(landOn);
        this._calYear = landDate.getFullYear();
        this._calMonth = landDate.getMonth();
        this._renderHabitCalendar();
        document.getElementById('calendarModal').classList.add('open');
    },
    calHabitPrevMonth() {
        this._calMonth -= 1;
        if (this._calMonth < 0) { this._calMonth = 11; this._calYear -= 1; }
        this._renderHabitCalendar();
    },
    calHabitNextMonth() {
        this._calMonth += 1;
        if (this._calMonth > 11) { this._calMonth = 0; this._calYear += 1; }
        this._renderHabitCalendar();
    },
    calHabitToday() {
        const t = Util.parseLocalDate(this.today());
        this._calYear = t.getFullYear();
        this._calMonth = t.getMonth();
        this._renderHabitCalendar();
    },
    _renderHabitCalendar() {
        const habit = this.habits.find(h => h.id === this._calHabitId);
        if (!habit) return;
        const finished = this.isHabitFinished(habit);
        const statusText = finished ? '✅ ' + this.t('lbl-completed') : this.t('habit-cal-status-progress');
        document.getElementById('calendarTitle').textContent = `${habit.name} — ${statusText}`;

        const todayBtn = document.getElementById('calHabitTodayBtn');
        if (todayBtn) todayBtn.textContent = this.t('habit-cal-today-btn');
        const hint = document.getElementById('calendar-hint');
        if (hint) hint.textContent = this.t('habit-cal-hint');

        const year = this._calYear, month = this._calMonth;
        const label = document.getElementById('calMonthYearLabel');
        if (label) {
            const monthName = new Date(year, month, 1).toLocaleDateString(this.lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long', year: 'numeric' });
            label.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
        }

        const dayLabels = this.lang === 'ru' ? ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'] : ['Mo','Tu','We','Th','Fr','Sa','Su'];
        const table  = document.getElementById('calendarTable');
        const header = `<tr>${dayLabels.map(d=>`<th>${d}</th>`).join('')}</tr>`;

        const firstOfMonth = new Date(year, month, 1);
        const offset = (firstOfMonth.getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const todayStr = this.today();

        let html = '<tr>';
        for (let i = 0; i < offset; i++) html += '<td class="empty"></td>';
        for (let d = 1; d <= daysInMonth; d++) {
            const col = (offset + d - 1) % 7;
            if (col === 0 && d !== 1) html += '</tr><tr>';
            const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const done = habit.completedDays.includes(ds);
            const inRange = ds >= habit.startDate && (!habit.endDate || ds <= habit.endDate);
            // BUG FIX: this used to gate on `!habit.endDate`, so simply having
            // a (possibly future) planned end date made every day non-
            // clickable immediately. Now gated on the habit actually being
            // finished (goal reached, or the end date has passed).
            const clickable = inRange && !finished;
            const cls = [done ? 'done' : '', ds === todayStr ? 'today' : ''].filter(Boolean).join(' ');
            html += clickable
                ? `<td class="${cls}"><button type="button" class="cal-cell" aria-pressed="${done}" aria-label="${ds}" onclick="diary.toggleDay(${habit.id},'${ds}',event);diary._renderHabitCalendar()">${d}</button></td>`
                : `<td class="${cls} off"><span class="cal-cell">${d}</span></td>`;
        }
        html += '</tr>';
        table.innerHTML = header + html;
    },

    renderHabits() {
        const container = document.getElementById('habitsList');
        const searchRaw = document.getElementById('habitsSearch').value || '';
        const search    = searchRaw.trim().toLowerCase();
        // Search matches name, description, start/end date and the "completed" status label.
        const list = this.habits.filter(h => {
            if (!search) return true;
            if (h.name.toLowerCase().includes(search)) return true;
            if ((h.description || '').toLowerCase().includes(search)) return true;
            if ((h.startDate || '').toLowerCase().includes(search)) return true;
            if ((h.endDate || '').toLowerCase().includes(search)) return true;
            if (this.isHabitFinished(h) && this.t('lbl-completed').toLowerCase().includes(search)) return true;
            return false;
        });

        if (!list.length) {
            container._key = null;
            container.innerHTML = search ? this._emptyState('🔍', this.t('search-empty')) : this._emptyState('🔥', this.t('habits-empty'));
            return;
        }
        this._setListKey(container, list.map(h => h.id).join(',') + '|' + search);

        const todayStr = this.today();
        container.innerHTML = list.map((h, i) => {
            const id        = Number(h.id);
            const done      = h.completedDays.length;
            const progress  = Math.min(Math.round(done / h.goal * 100), 100);
            const ended     = this.isHabitFinished(h);
            const todayDone = h.completedDays.includes(todayStr);
            const isOpen    = this.openHabitDetail === h.id;
            const pinLabel  = h.pinned ? this.t('lbl-unpin') : this.t('lbl-pin');

            return `
            <div class="record-card ${h.pinned ? 'pinned' : ''} ${ended ? 'is-finished' : ''}" style="--i:${Math.min(i, 8)}" role="button" tabindex="0" aria-expanded="${isOpen}" onclick="diary.toggleHabitDetail(${id})">
                ${h.pinned ? '<span class="pin-badge" aria-hidden="true">📌</span>' : ''}
                <div class="rc-head">
                    <div class="hb-heading">
                        <h3 class="rc-title">${this._hl(h.name, search, searchRaw)}</h3>
                        ${h.description ? `<div class="hb-desc">${this._hl(h.description, search, searchRaw)}</div>` : ''}
                    </div>
                    ${ended ? `<span class="chip green">${this.t('lbl-completed')}</span>` : ''}
                </div>
                <div class="hb-stats">
                    <div class="hb-stat"><div class="hb-stat-val is-done">${done}</div><div class="hb-stat-lbl">${this.t('lbl-done')}</div></div>
                    <div class="hb-stat"><div class="hb-stat-val">${h.goal}</div><div class="hb-stat-lbl">${this.t('lbl-goal')}</div></div>
                    <div class="hb-stat"><div class="hb-stat-val is-pct">${progress}%</div><div class="hb-stat-lbl">${this.t('lbl-progress')}</div></div>
                </div>
                <div class="prog-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><div class="prog-fill" style="width:${progress}%"></div></div>
                ${this._renderHabitCountdown(h)}
                ${isOpen ? `
                <div class="detail-panel" onclick="event.stopPropagation()">
                    <div class="action-row">
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.showCalendar(${id},event)">${this.t('lbl-calendar')}</button>
                        ${!ended ? `
                        <button type="button" class="btn-ghost btn-sm ${todayDone ? 'btn-success' : ''}" onclick="diary.toggleDay(${id},'${todayStr}',event)">
                            ${todayDone ? this.t('lbl-done-today') : this.t('lbl-mark-today')}
                        </button>` : `
                        <button type="button" class="btn-ghost btn-sm" disabled>${this.t('habit-countdown-ended')}</button>`}
                    </div>
                    <div class="action-row">
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.editHabit(${id},event)">${this.t('lbl-edit')}</button>
                        ${!ended ? `<button type="button" class="btn-ghost btn-sm" onclick="diary.endHabit(${id},event)">${this.t('lbl-end-habit')}</button>` : ''}
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.togglePin('habit',${id},event)">${pinLabel}</button>
                        <button type="button" class="btn-ghost btn-sm btn-danger" onclick="diary.deleteHabit(${id},event)">${this.t('lbl-delete')}</button>
                    </div>
                </div>` : ''}
            </div>`;
        }).join('');
        if (this._tab === 'habits') this._tickHabitTimers();
    },

    _resetHabitForm() {
        document.getElementById('habitForm').reset();
        document.getElementById('habitId').value = '';
        document.getElementById('habitStartDate').value = this.today();
        document.getElementById('habitFormTitle').textContent = this.t('habitFormTitle-new');
    },

    async saveMemory(e) {
        e.preventDefault();
        if (this._submitting.memory) return;
        const idRaw  = document.getElementById('memoryId').value;
        const id     = idRaw ? +idRaw : Date.now();
        const title  = document.getElementById('memoryTitle').value.trim();
        const type   = document.getElementById('memoryType').value;
        const start  = document.getElementById('memoryStartDate').value;
        const end    = type === 'relations' ? null : (document.getElementById('memoryEndDate').value || null);
        const notes  = document.getElementById('memoryNotes').value.trim();
        const partner= type === 'relations' ? document.getElementById('partnerName').value.trim() : '';
        if (!title || !start) return this.toast(this.t('toast-fill-fields'), 'error');
        if (end && end < start) return this.toast(this.t('toast-bad-dates'), 'error');

        this._submitting.memory = true;
        const prev = this.memories.slice();
        try {
            const existing = this.memories.find(m => m.id === id);
            const memory = {
                id, title, type: this.MEMORY_TYPES.includes(type) ? type : 'other', startDate: start,
                // A relationship's end date is set through "We broke up", not this form: keep what is stored.
                endDate: type === 'relations' ? (existing ? existing.endDate || null : null) : end,
                notes, partnerName: partner,
                events: existing ? existing.events : [],
                date: new Date().toLocaleString(this.lang === 'ru' ? 'ru-RU' : 'en-GB'),
                pinned: existing ? existing.pinned : false
            };
            const idx = this.memories.findIndex(m => m.id === id);
            const isNewMemory = idx < 0;
            if (idx >= 0) this.memories[idx] = memory;
            else this.memories.unshift(memory);

            this.memories = this._sortPinned(this.memories);
            // An active type filter must not hide the entry that was just saved (it would look like the save failed).
            if (this.memoryFilter !== 'all' && this.memoryFilter !== memory.type) this._syncMemoryFilterUI('all');
            if (!(await this.saveMemories())) { this.memories = prev; this.renderMemories(); this.updateFooter(); return; }
            ActionLog.record(isNewMemory ? 'memory_created' : 'memory_updated');
            this.updateStreak();
            this._resetMemoryForm();
            this.toast(this.t('toast-memory-saved'));
        } finally { this._submitting.memory = false; }
    },

    _loadMemoryToForm(mem) {
        document.getElementById('memoryId').value         = mem.id;
        document.getElementById('memoryTitle').value      = mem.title;
        document.getElementById('memoryType').value       = mem.type;
        document.getElementById('memoryStartDate').value  = mem.startDate;
        document.getElementById('memoryEndDate').value    = mem.endDate || '';
        document.getElementById('memoryNotes').value      = mem.notes || '';
        if (mem.type === 'relations') document.getElementById('partnerName').value = mem.partnerName || '';
        this.onMemoryTypeChange();
        document.getElementById('memoryFormTitle').textContent = this.t('memoryFormTitle-edit');
        document.getElementById('memorySection').scrollIntoView({ behavior:'smooth', block:'start' });
    },

    onMemoryTypeChange() {
        const isRel = document.getElementById('memoryType').value === 'relations';
        document.getElementById('relationsFields').classList.toggle('hidden', !isRel);
        document.getElementById('endDateField').classList.toggle('hidden', isRel);
    },

    editMemory(id, e) {
        if (e) e.stopPropagation();
        this._loadMemoryToForm(this.memories.find(m => m.id === id));
        this.openMemoryDetail = null; this.renderMemories();
    },

    async deleteMemory(id, e) {
        if (e) e.stopPropagation();
        if (!(await this.ask('confirm-delete-memory'))) return;
        const prev = this.memories;
        this.memories = this.memories.filter(m => m.id !== id);
        if (!(await this.saveMemories())) { this.memories = prev; this.renderMemories(); this.updateFooter(); return; }
        ActionLog.record('memory_deleted');
        this.toast(this.t('toast-memory-deleted'));
    },

    showAddEvent(memId, editIdx, e) {
        if (e) e.stopPropagation();
        document.getElementById('eventMemoryId').value = memId;
        document.getElementById('editEventIdx').value  = editIdx !== undefined ? editIdx : '';
        const mem = this.memories.find(m => m.id === memId);
        const ev = (editIdx !== undefined && editIdx !== '' && mem && mem.events) ? mem.events[editIdx] : null;
        if (ev) {
            document.getElementById('eventDate').value = ev.date;
            document.getElementById('eventDesc').value = ev.desc;
            document.getElementById('add-event-title').textContent = this.t('lbl-edit');
        } else {
            document.getElementById('editEventIdx').value = '';
            document.getElementById('eventDate').value = this.today();
            document.getElementById('eventDesc').value = '';
            document.getElementById('add-event-title').textContent = this.t('add-event-title');
        }
        document.getElementById('eventModal').classList.add('open');
    },

    async saveEvent(e) {
        e.preventDefault();
        if (this._submitting.event) return;
        const memId   = +document.getElementById('eventMemoryId').value;
        const editIdx = document.getElementById('editEventIdx').value;
        const date    = document.getElementById('eventDate').value;
        const desc    = document.getElementById('eventDesc').value.trim();
        const mem     = this.memories.find(m => m.id === memId);
        if (!mem) return;
        if (!date || !desc) return this.toast(this.t('toast-fill-fields'), 'error');

        this._submitting.event = true;
        const prev = (mem.events || []).slice();
        try {
            if (!mem.events) mem.events = [];
            if (editIdx !== '' && mem.events[+editIdx]) mem.events[+editIdx] = { date, desc };
            else mem.events.push({ date, desc });
            mem.events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // YYYY-MM-DD sorts lexically
            if (!(await this.saveMemories())) { mem.events = prev; this.renderMemories(); return; }
            this.updateStreak();
            this.closeModals();
            this.toast(this.t('toast-event-saved'));
        } finally { this._submitting.event = false; }
    },

    async deleteEvent(memId, idx, e) {
        if (e) e.stopPropagation();
        const mem = this.memories.find(m => m.id === memId);
        if (!mem || !mem.events || !mem.events[idx]) return;
        if (!(await this.ask('confirm-delete-event'))) return;
        const removed = mem.events.splice(idx, 1);
        if (!(await this.saveMemories())) { mem.events.splice(idx, 0, ...removed); this.renderMemories(); return; }
        this.toast(this.t('toast-event-deleted'));
    },

    endRelations(id, e) {
        if (e) e.stopPropagation();
        const m = this.memories.find(m => m.id === id);
        if (!m) return;
        this.tempEndRelationsId = id;
        document.getElementById('endRelationsDate').value = m.endDate || this.today();
        document.getElementById('endRelationsModal').classList.add('open');
    },

    async confirmEndRelations() {
        const m = this.memories.find(m => m.id === this.tempEndRelationsId);
        const date = document.getElementById('endRelationsDate').value || this.today();
        if (!m) return this.closeModals();
        if (m.startDate && date < m.startDate) return this.toast(this.t('toast-bad-dates'), 'error');
        const prev = m.endDate;
        m.endDate = date;
        if (!(await this.saveMemories())) { m.endDate = prev; this.renderMemories(); return; }
        this.closeModals();
    },

    // ---------- v9.5: Archive type filter ----------
    // Builds the chip row. Called from applyTranslations() (language switch / first load) only;
    // a chip tap goes through setMemoryFilter(), which just toggles classes so the row keeps its
    // horizontal scroll position.
    _renderMemoryFilter() {
        const el = document.getElementById('memoriesTypeFilter');
        if (!el) return;
        el.setAttribute('aria-label', this.t('mem-filter-label'));
        el.innerHTML = ['all', ...this.MEMORY_TYPES].map(v => {
            const label = v === 'all' ? this.t('mem-filter-all') : this.t('type-' + v);
            const on    = this.memoryFilter === v;
            return `<button type="button" class="type-chip${on ? ' active' : ''}" data-type="${v}" aria-pressed="${on}" onclick="diary.setMemoryFilter('${v}')">${label}</button>`;
        }).join('');
    },

    // Sets the filter value and mirrors it onto the chips (no re-render of the list).
    _syncMemoryFilterUI(v) {
        if (v !== 'all' && !this.MEMORY_TYPES.includes(v)) v = 'all';
        this.memoryFilter = v;
        document.querySelectorAll('#memoriesTypeFilter .type-chip').forEach(b => {
            const on = b.dataset.type === v;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            // keep the chosen chip in view inside the scrollable row (no page scroll: block 'nearest')
            if (on) { try { b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old WebView */ } }
        });
    },

    setMemoryFilter(v) {
        this._syncMemoryFilterUI(v);
        this.renderMemories();
    },

    renderMemories() {
        const container = document.getElementById('memoriesList');
        const searchRaw = document.getElementById('memoriesSearch').value || '';
        const search    = searchRaw.trim().toLowerCase();
        const typeFilter = this.memoryFilter;
        // The type filter is applied first (cheap equality), then the text query — one pass.
        const list = this.memories.filter(m => {
            if (typeFilter !== 'all' && m.type !== typeFilter) return false;
            if (!search) return true;
            if (m.title.toLowerCase().includes(search)) return true;
            if ((m.notes || '').toLowerCase().includes(search)) return true;
            if ((m.partnerName || '').toLowerCase().includes(search)) return true;
            if (this.t('type-' + m.type).toLowerCase().includes(search)) return true;
            if ((m.startDate || '').toLowerCase().includes(search)) return true;
            if ((m.endDate || '').toLowerCase().includes(search)) return true;
            return false;
        });

        if (!list.length) {
            // Three different "nothing to show" situations, three messages.
            let icon = '🔍', msg = this.t('search-empty');
            if (!this.memories.length)                { icon = '📦';  msg = this.t('memories-empty'); }
            else if (!search && typeFilter !== 'all') { icon = '🗂️'; msg = this.t('mem-filter-empty'); }
            container._key = null;
            container.innerHTML = this._emptyState(icon, msg);
            return;
        }
        this._setListKey(container, list.map(m => m.id).join(',') + '|' + search + '|' + typeFilter);

        container.innerHTML = list.map((m, i) => {
            const id       = Number(m.id);
            const isOpen   = this.openMemoryDetail === m.id;
            const pinLabel = m.pinned ? this.t('lbl-unpin') : this.t('lbl-pin');
            if (m.type === 'relations') return this._renderRelCard(m, isOpen, Math.min(i, 8), pinLabel, search, searchRaw);

            const type     = this.MEMORY_TYPES.includes(m.type) ? m.type : 'other';
            const title    = this._hl(m.title, search, searchRaw);
            const notes    = m.notes ? this._hl(m.notes, search, searchRaw) : '';
            // Start and (optional) end date as one labelled block: From → To.
            const dateBox = (lblKey, d) => `<div class="mem-date"><span class="mem-date-lbl">${this.t(lblKey)}</span><time class="mem-date-val" datetime="${Util.escHtml(d)}">${Util.escHtml(this.fmtDate(d))}</time></div>`;
            const dates = (m.startDate || m.endDate) ? `
                <div class="mem-dates${m.endDate ? ' has-end' : ''}">
                    ${m.startDate ? dateBox('mem-date-from', m.startDate) : ''}
                    ${m.startDate && m.endDate ? '<span class="mem-date-arrow" aria-hidden="true">→</span>' : ''}
                    ${m.endDate ? dateBox('mem-date-to', m.endDate) : ''}
                </div>` : '';
            return `
            <div class="record-card mem-card mem-t-${type} ${m.pinned ? 'pinned' : ''}" style="--i:${Math.min(i, 8)}" role="button" tabindex="0" aria-expanded="${isOpen}" onclick="diary.toggleMemoryDetail(${id})">
                ${m.pinned ? '<span class="pin-badge" aria-hidden="true">📌</span>' : ''}
                <div class="mem-top"><span class="mem-chip">${this.t('type-' + type)}</span></div>
                <h3 class="mem-title">${title}</h3>
                ${dates}
                ${notes ? `<div class="mem-notes${isOpen ? ' open' : ''}">${notes}</div>` : ''}
                ${isOpen ? `
                <div class="detail-panel" onclick="event.stopPropagation()">
                    <div class="action-row">
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.editMemory(${id},event)">${this.t('lbl-edit')}</button>
                        <button type="button" class="btn-ghost btn-sm" onclick="diary.togglePin('memory',${id},event)">${pinLabel}</button>
                        <button type="button" class="btn-ghost btn-sm btn-danger" onclick="diary.deleteMemory(${id},event)">${this.t('lbl-delete')}</button>
                    </div>
                </div>` : ''}
            </div>`;
        }).join('');
    },

    _renderRelCard(m, isOpen, idx, pinLabel, search, searchRaw) {
        const id       = Number(m.id);
        const isEnded  = !!m.endDate;
        // Whole local calendar days, inclusive. (Parsing 'YYYY-MM-DD' with new Date() would be UTC and
        // miscount by a day depending on the timezone.)
        const days     = m.startDate ? Math.max(1, Util.daysBetween(m.startDate, m.endDate || this.today()) + 1) : 1;
        const events   = m.events || [];
        const title       = this._hl(m.title, search, searchRaw);
        const notes       = m.notes ? this._hl(m.notes, search, searchRaw) : '';
        const partnerName = m.partnerName ? this._hl(m.partnerName, search, searchRaw) : '';

        const eventsHtml = events.length
            ? events.map((ev, i) => `
                <div class="rel-event-item">
                    <div class="rel-event-date">${Util.escHtml(this.fmtDate(ev.date))}</div>
                    <div class="rel-event-desc">${Util.escHtml(ev.desc)}</div>
                    <div class="rel-event-actions">
                        <button type="button" class="rel-event-btn" aria-label="${Util.escHtml(this.t('lbl-edit'))}" onclick="diary.showAddEvent(${id},${i},event)">✏️</button>
                        <button type="button" class="rel-event-btn" aria-label="${Util.escHtml(this.t('lbl-delete'))}" onclick="diary.deleteEvent(${id},${i},event)">🗑️</button>
                    </div>
                </div>`).join('')
            : `<div class="rel-empty">${this.t('lbl-no-events')}</div>`;

        return `
        <div class="rel-card ${m.pinned ? 'pinned' : ''}" style="--i:${idx}" role="button" tabindex="0" aria-expanded="${isOpen}" onclick="diary.toggleMemoryDetail(${id})">
            ${m.pinned ? '<span class="pin-badge pin-on-hero" aria-hidden="true">📌</span>' : ''}
            <div class="rel-card-header">
                <div class="rel-top">
                    <div class="rel-main">
                        <div class="rel-kicker">${this.t('type-relations')}</div>
                        <h3 class="rel-title">${title}</h3>
                        ${partnerName ? `<div class="rel-partner">👤 ${partnerName}</div>` : ''}
                    </div>
                    <div class="rel-days">
                        <div class="rel-days-num">${days}</div>
                        <div class="rel-days-lbl">${this.t('rel-days-together')}</div>
                    </div>
                </div>
                <div class="rel-chips">
                    <span class="rel-chip">${this.t('rel-since')} ${Util.escHtml(this.fmtDate(m.startDate))}</span>
                    ${isEnded
                        ? `<span class="rel-chip is-ended">💔 ${Util.escHtml(this.fmtDate(m.endDate))}</span>`
                        : `<span class="rel-chip is-alive">✨ ${this.t('rel-still-together')}</span>`}
                </div>
            </div>
            <div class="rel-card-body" onclick="event.stopPropagation()">
                ${notes ? `<div class="rel-note">${notes}</div>` : ''}
                <div class="rel-events-title">${this.t('lbl-events')}</div>
                ${eventsHtml}
                <div class="action-row">
                    <button type="button" class="btn-ghost btn-sm" onclick="diary.showAddEvent(${id},undefined,event)">${this.t('lbl-add-event')}</button>
                    ${!isEnded ? `<button type="button" class="btn-ghost btn-sm btn-danger" onclick="diary.endRelations(${id},event)">${this.t('lbl-broke-up')}</button>` : ''}
                </div>
                ${isOpen ? `
                <div class="divider"></div>
                <div class="action-row">
                    <button type="button" class="btn-ghost btn-sm" onclick="diary.editMemory(${id},event)">${this.t('lbl-edit')}</button>
                    <button type="button" class="btn-ghost btn-sm" onclick="diary.togglePin('memory',${id},event)">${pinLabel}</button>
                    <button type="button" class="btn-ghost btn-sm btn-danger" onclick="diary.deleteMemory(${id},event)">${this.t('lbl-delete')}</button>
                </div>` : ''}
            </div>
        </div>`;
    },

    _resetMemoryForm() {
        document.getElementById('memoryForm').reset();
        document.getElementById('memoryId').value = '';
        document.getElementById('relationsFields').classList.add('hidden');
        document.getElementById('endDateField').classList.remove('hidden');
        document.getElementById('memoryStartDate').value = this.today();
        document.getElementById('memoryFormTitle').textContent = this.t('memoryFormTitle-new');
    },

    // ---------- v9.3: Day Streak Freezes ----------
    _curMonthStr() { return this.today().slice(0, 7); }, // local 'YYYY-MM' (same local-date helper as everything else)

    /** Freezes the person can use RIGHT NOW. Pure (no mutation): if the stored allowance
     *  belongs to an earlier month, the new month has already refilled it. */
    _freezesLeft() {
        const MAX = this.FREEZES_PER_MONTH;
        if (!this.freezeMonth || this.freezeMonth < this._curMonthStr()) return MAX;
        return Math.min(MAX, Math.max(0, this.freezeCount));
    },

    /** Brings freezeMonth/freezeCount up to date. Returns true if anything changed (caller persists).
     *   - never initialised (first launch / old backup / v9.2 upgrade) → full allowance
     *   - stored month is EARLIER than now (incl. Dec→Jan: '2026-12' < '2027-01') → refill once
     *   - stored month is LATER than now (device clock moved back / timezone shift) → re-anchor to
     *     now but KEEP the count, so a clock glitch can never mint extra freezes mid-month. */
    _syncFreezeMonth() {
        const MAX = this.FREEZES_PER_MONTH, cur = this._curMonthStr();
        if (!this.freezeMonth || this.freezeMonth < cur) {
            this.freezeCount = MAX; this.freezeMonth = cur; return true;
        }
        if (this.freezeMonth > cur) {
            this.freezeCount = Math.min(MAX, Math.max(0, this.freezeCount)); this.freezeMonth = cur; return true;
        }
        return false;
    },

    /** Validates raw freeze values (from storage or an imported backup) then syncs the month.
     *  Anything missing/garbled falls back to a safe default instead of throwing. */
    _setFreezeState(count, month, log) {
        const MAX = this.FREEZES_PER_MONTH, n = parseInt(count, 10);
        this.freezeCount = Number.isFinite(n) ? Math.min(MAX, Math.max(0, n)) : MAX;
        this.freezeMonth = typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : '';
        this.freezeLog = (Array.isArray(log) ? log : [])
            .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
            .slice(-this.FREEZE_LOG_MAX);
        return this._syncFreezeMonth();
    },

    _freezeLabel() {
        return this.t('freeze-left-label')
            .replace('{n}', this._freezesLeft()).replace('{max}', this.FREEZES_PER_MONTH);
    },

    _renderFreezeBadge() {
        const left = this._freezesLeft();
        const num = document.getElementById('freezeCountHeader');
        if (num) num.textContent = left;
        const chip = document.getElementById('freezeChip');
        if (chip) { chip.classList.toggle('empty', left === 0); chip.title = this._freezeLabel(); }
        const badge = document.getElementById('streakBadge');
        if (badge) badge.setAttribute('aria-label', this.t('streak-cal-title') + '. ' + this._freezeLabel());
    },

    /**
     * Extends the fire streak for today (idempotent per calendar day). Called only on real
     * user actions — never on open / viewing a tab (see v9.1 note in switchTab).
     *
     * FREEZE RULES (v9.3) — evaluated when the person's next action arrives:
     *   lastActiveDate == yesterday          → normal +1, no freeze used.
     *   lastActiveDate == 2 days ago         → EXACTLY ONE missed day (yesterday). If a freeze is
     *                                          left, spend 1, mark yesterday in freezeLog and
     *                                          continue the streak (+1 for today's real action; the
     *                                          frozen day protects the chain but is not itself counted).
     *   anything older / no freeze left      → streak restarts at 1. A freeze is NEVER spent on a gap of
     *                                          2+ missed days, so it can't be wasted on a lost cause.
     * The allowance is refilled (_syncFreezeMonth) BEFORE this decision, so the first action of a
     * new month can already draw on the new month's freezes. A freeze is charged to the month in
     * which it is applied (i.e. when the person comes back), not the month of the missed day.
     */
    updateStreak() {
        const todayStr = this.today();
        if (this.lastActiveDate === todayStr) return;
        // Timezone guard: after travelling west the local date can be one day BEHIND the date we
        // stored. That is the same moment in time, not a break — leave the streak untouched
        // (and never burn a freeze) instead of resetting it.
        if (this.lastActiveDate === Util.addDays(todayStr, 1)) return;

        this._syncFreezeMonth();
        const yestStr = Util.addDays(todayStr, -1);
        const old = this.fireStreak;
        let restarted = false, frozenDay = '';

        if (this.lastActiveDate === yestStr) {
            this.fireStreak += 1;
        } else if (this.fireStreak > 0 && this.freezeCount > 0 &&
                   this.lastActiveDate === Util.addDays(todayStr, -2)) {
            this.freezeCount -= 1;               // guarded above: can't go negative
            frozenDay = yestStr;
            this.freezeLog.push(frozenDay);
            this.freezeLog = this.freezeLog.slice(-this.FREEZE_LOG_MAX);
            this.fireStreak += 1;
        } else {
            this.fireStreak = 1;
            restarted = true;
        }
        this.lastActiveDate = todayStr;

        // Keep a small rolling log of the exact days that kept the streak alive,
        // so the mini calendar can show real history rather than just a count.
        // If the streak was just broken and restarted, drop the old run first
        // (frozen days belonged to that old run, so they go with it).
        if (restarted) { this.streakLog = []; this.freezeLog = []; }
        if (!this.streakLog.includes(todayStr)) this.streakLog.push(todayStr);
        this.streakLog = this.streakLog.slice(-90); // cap growth; plenty for any heatmap view

        this._saveStreak().catch(e => DBLog.warn('Streak', 'Streak could not be saved.', e));
        if (this.fireStreak > old) {
            const hdr = document.getElementById('fireStreakHeader');
            const emj = document.getElementById('fireEmoji');
            // v9.1: null-guard — updateStreak() can now be reached from
            // TaskManager, so never assume the header nodes exist.
            if (hdr && emj) {
                hdr.classList.remove('fire-anim'); emj.classList.remove('fire-anim');
                void hdr.offsetWidth;
                hdr.classList.add('fire-anim'); emj.classList.add('fire-anim');
                setTimeout(() => { hdr.classList.remove('fire-anim'); emj.classList.remove('fire-anim'); }, 700);
            }
        }
        if (frozenDay) {
            const chip = document.getElementById('freezeChip');
            if (chip) {
                chip.classList.remove('freeze-anim'); void chip.offsetWidth; chip.classList.add('freeze-anim');
                setTimeout(() => chip.classList.remove('freeze-anim'), 800);
            }
            // Delayed so it follows (instead of instantly replacing) the "Note saved" /
            // "Task added" toast that callers show right around updateStreak().
            setTimeout(() => this.toast(this.t('toast-freeze-used'), 'freeze'), 1000);
        }
        this.updateFooter();
    },

    // v9.3: all streak/freeze writes go through ONE queue. Before, _saveStreak() did three
    // sequential awaits with no ordering guarantee between calls, so two overlapping saves
    // (e.g. a streak update racing a backup import) could interleave and leave mixed state.
    // Entries are read when the job RUNS, so the newest in-memory state always wins.
    _queueStreakSave(getEntries) {
        const run = async () => {
            await Promise.all(getEntries().map(([k, v]) => StorageManager.setItem(k, v)));
        };
        const p = this._streakSaveChain.then(run, run); // run even if the previous job failed
        this._streakSaveChain = p.catch(() => {});
        return p;
    },
    _freezeEntries() {
        return [
            ['freezeCount', String(this.freezeCount)],
            ['freezeMonth', this.freezeMonth],
            ['freezeLog',   JSON.stringify(this.freezeLog)],
        ];
    },
    _saveStreak() {
        return this._queueStreakSave(() => [
            ['fireStreak',     this.fireStreak.toString()],
            ['lastActiveDate', this.lastActiveDate],
            ['streakLog',      JSON.stringify(this.streakLog)],
            ...this._freezeEntries(),
        ]);
    },
    /** Freeze keys only — used at load so a refill never rewrites (and risks clobbering) streak keys. */
    _saveFreezes() { return this._queueStreakSave(() => this._freezeEntries()); },

    // ---------- fire streak calendar ----------
    // Full month/year-navigable calendar, same UX/visual language as the habit
    // and task calendars (replaces the old fixed 35-day, non-navigable
    // heatmap that only ever showed the most recent 5 weeks with no month or
    // year context).
    showStreakCalendar() {
        const countEl = document.getElementById('streakCalCount');
        if (countEl) countEl.textContent = this.fireStreak;
        const titleEl = document.getElementById('streak-cal-title');
        if (titleEl) titleEl.textContent = '🔥 ' + this.t('streak-cal-title');
        const curLabel = document.getElementById('streak-cal-current');
        if (curLabel) curLabel.textContent = this.t('streak-cal-current');
        const hint = document.getElementById('streak-cal-hint');
        if (hint) hint.textContent = this.t('streak-cal-hint');
        const fHint = document.getElementById('streak-cal-hint-freeze');
        if (fHint) fHint.textContent = '❄️ ' + this.t('streak-cal-hint-freeze');
        const fSum = document.getElementById('streakFreezeSummary');
        if (fSum) fSum.textContent = '❄️ ' + this._freezeLabel();
        const todayBtn = document.getElementById('streakCalTodayBtn');
        if (todayBtn) todayBtn.textContent = this.t('streak-cal-today-btn');

        // Land on the month of the most recent streak day (or today, if the
        // streak log is empty), same "land somewhere useful" logic as the
        // habit calendar.
        const mostRecent = this.streakLog.length ? this.streakLog.slice().sort().pop() : this.today();
        const landDate = Util.parseLocalDate(mostRecent);
        this._streakCalYear  = landDate.getFullYear();
        this._streakCalMonth = landDate.getMonth();
        this._renderStreakCalendar();
        document.getElementById('streakCalendarModal').classList.add('open');
    },
    streakCalPrevMonth() {
        this._streakCalMonth -= 1;
        if (this._streakCalMonth < 0) { this._streakCalMonth = 11; this._streakCalYear -= 1; }
        this._renderStreakCalendar();
    },
    streakCalNextMonth() {
        this._streakCalMonth += 1;
        if (this._streakCalMonth > 11) { this._streakCalMonth = 0; this._streakCalYear += 1; }
        this._renderStreakCalendar();
    },
    streakCalToday() {
        const t = Util.parseLocalDate(this.today());
        this._streakCalYear  = t.getFullYear();
        this._streakCalMonth = t.getMonth();
        this._renderStreakCalendar();
    },
    _renderStreakCalendar() {
        const year = this._streakCalYear, month = this._streakCalMonth;
        const label = document.getElementById('streakCalMonthYearLabel');
        if (label) {
            const monthName = new Date(year, month, 1).toLocaleDateString(this.lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long', year: 'numeric' });
            label.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
        }

        const dayLabels = this.lang === 'ru' ? ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'] : ['Mo','Tu','We','Th','Fr','Sa','Su'];
        const table  = document.getElementById('streakCalTable');
        const header = `<tr>${dayLabels.map(d=>`<th>${d}</th>`).join('')}</tr>`;

        const firstOfMonth = new Date(year, month, 1);
        const offset = (firstOfMonth.getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const todayStr = this.today();
        const activeSet = new Set(this.streakLog);
        const freezeSet = new Set(this.freezeLog); // v9.3: missed days a freeze covered

        let html = '<tr>';
        for (let i = 0; i < offset; i++) html += '<td class="empty"></td>';
        for (let d = 1; d <= daysInMonth; d++) {
            const col = (offset + d - 1) % 7;
            if (col === 0 && d !== 1) html += '</tr><tr>';
            const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const active = activeSet.has(ds);
            const frozen = !active && freezeSet.has(ds); // a real active day always wins over a freeze mark
            const isToday = ds === todayStr;
            const cls = [active ? 'streak-fire' : '', frozen ? 'streak-freeze' : '', isToday ? 'today' : ''].filter(Boolean).join(' ');
            const title = frozen ? `${ds} — ${this.t('streak-freeze-day')}` : ds;
            // Purely a history view — nothing to toggle here, unlike the
            // habit/task calendars — so no onclick handler.
            html += `<td class="${cls}" style="cursor:default" title="${title}">${active ? '🔥' : frozen ? '❄️' : d}</td>`;
        }
        html += '</tr>';
        if (table) table.innerHTML = header + html;
    },

    // ---------- overlays: Escape, Telegram BackButton ----------
    // Top-most first. Each entry: [element id, close function].
    _overlayStack() {
        return [
            ['dataConfirmModal',      () => DataDialog.onCancel()],
            ['customAchModal',        () => AchievementsUI.closeCustomForm()],
            ['actionHistoryModal',    () => ActionHistoryUI.close()],
            ['recoveryModal',         () => SidebarUI.closeRecoveryModal()],
            ['deleteAccountModal',    () => SidebarUI.cancelDeleteAccount()],
            ['achievementsModal',     () => AchievementsUI.close()],
            ['calendarModal',         () => this.closeModals()],
            ['streakCalendarModal',   () => this.closeModals()],
            ['endHabitModal',         () => this.closeModals()],
            ['endRelationsModal',     () => this.closeModals()],
            ['eventModal',            () => this.closeModals()],
            ['bottomSheet',           () => this.closeSheet()],
            ['sidebarPanel',          () => SidebarUI.close()],
        ];
    },
    _isOpen(id) { const el = document.getElementById(id); return !!el && el.classList.contains('open'); },
    hasOpenOverlay() { return this._overlayStack().some(([id]) => this._isOpen(id)); },
    /** Closes the top-most open overlay. @returns {boolean} whether anything was closed */
    closeTopOverlay() {
        const lock = document.getElementById('encryptionLock');
        if (lock && lock.classList.contains('open')) return false; // lock screens are not dismissible
        for (const [id, close] of this._overlayStack()) {
            if (this._isOpen(id)) { close(); return true; }
        }
        return false;
    },
    _syncBackButton() {
        TGPlatform.setBackButton(this.hasOpenOverlay(), () => this.closeTopOverlay());
    },

    // ---------- app lifecycle ----------
    /** Runs when the Mini App returns to the foreground. A backgrounded Mini App can stay alive across
     *  midnight, so "today" is re-evaluated here — otherwise tasks (including ones carried over to
     *  tomorrow) would stay hidden and the next save could overwrite them. */
    _onResume() {
        if (!this._inited) return;
        if (this._tab === 'habits') this._startHabitTimers();
        const now = this.today();
        if (now !== this._lastToday) {
            this._lastToday = now;
            DBLog.info('App', 'A new day started. Refreshing today\'s data.');
            TaskManager.onDateRollover().catch(e => DBLog.warn('Tasks', 'Could not refresh tasks for the new day.', e));
            this.renderHabits();
            this.updateFooter();
        }
    },

    // ---------- one-time event wiring ----------
    _bindEvents() {
        if (this._inited) return;
        this._inited = true;
        const $ = (id) => document.getElementById(id);

        $('noteForm').addEventListener('submit',   e => this.saveNote(e));
        $('habitForm').addEventListener('submit',  e => this.saveHabit(e));
        $('memoryForm').addEventListener('submit', e => this.saveMemory(e));
        $('eventForm').addEventListener('submit',  e => this.saveEvent(e));

        const qi = $('taskQuickInput');
        if (qi) qi.addEventListener('keydown', e => TaskManager.onInputKeydown(e));
        const taskAddBtn = $('taskAddBtn');
        if (taskAddBtn) taskAddBtn.addEventListener('click', e => { e.preventDefault(); TaskManager.quickAdd(); });

        $('clearAll').addEventListener('click', async () => {
            if (!this.notes.length) return;
            if (!(await this.ask('confirm-clear-all', { confirmKey: 'clear-all-txt' }))) return;
            const prev = this.notes;
            this.notes = [];
            if (!(await this.saveNotes())) { this.notes = prev; this.renderNotes(); this.updateFooter(); return; }
            this.toast(this.t('toast-all-deleted'));
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', e => { if (e.target === overlay) this.closeTopOverlay(); });
        });

        // Swipe down on the bottom sheet to dismiss it (only from the top of its scroll position).
        const sheet = $('bottomSheet');
        let sheetStartY = 0;
        sheet.addEventListener('touchstart', e => { sheetStartY = e.touches[0].clientY; }, { passive: true });
        sheet.addEventListener('touchend', e => {
            if (sheet.scrollTop <= 0 && e.changedTouches[0].clientY - sheetStartY > 60) this.closeSheet();
        }, { passive: true });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') { this.closeTopOverlay(); return; }
            // Cards are role="button" divs: make Enter / Space behave like a click when the card itself is focused.
            if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('.record-card, .rel-card, .sheet-option, .sidebar-item, .lock-link')) {
                e.preventDefault(); e.target.click();
            }
        });

        // Menu rows are clickable divs: expose them to keyboards and assistive tech as buttons.
        document.querySelectorAll('.sheet-option, .sidebar-item, .lock-link').forEach(el => { el.setAttribute('role', 'button'); el.tabIndex = 0; });

        // Keep Telegram's native BackButton in step with whatever overlay is open.
        const observer = new MutationObserver(() => this._syncBackButton());
        this._overlayStack().forEach(([id]) => { const el = $(id); if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] }); });

        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this._stopHabitTimers(); });
        TGPlatform.onResume(() => this._onResume());
        TGPlatform.onThemeChanged(() => {
            const cs = TGPlatform.colorScheme();
            if (!this._themeExplicit && cs) this.applyTheme(cs === 'dark' ? 'dark' : 'orange', { silent: true });
        });
    },

    /** Entry point after unlock. Safe to call more than once (e.g. after "start fresh"): data is
     *  reloaded every time, but event listeners are attached only once. */
    async init() {
        TGPlatform.initApp(); // normally done at boot; idempotent
        StorageManager.init();
        await this.load();
        this._lastToday = this.today();
        ActionLog.init().catch(e => DBLog.warn('ActionLog', 'Action history could not be loaded.', e)); // never blocks startup
        this._bindEvents();

        const todayStr = this.today();
        ['habitStartDate', 'memoryStartDate', 'eventDate'].forEach(id => {
            const el = document.getElementById(id);
            if (el && !el.value) el.value = todayStr;
        });

        SidebarUI.init();
        AchievementsUI.init();
        this.switchTab(this._tab);
        this._syncBackButton();
    }
};
