// ================================================================
//  DIARY APP
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
    tempEndHabitId:    null,
    tempEndRelationsId: null,
    openNoteDetail:   null,
    openHabitDetail:  null,
    openMemoryDetail: null,
    _calHabitId:    null,  // which habit's calendar modal is currently open
    _calYear:       null,  // year shown in the habit calendar modal
    _calMonth:      null,  // 0-indexed month shown in the habit calendar modal
    _habitTimerInterval: null, // live countdown ticker, only runs while the Habits tab is open

    t(key) { return (T[this.lang] || T.en)[key] || key; },
    today() { return Util.localDateStr(); }, // FIX: was toISOString() (UTC) — see Util comment

    fmtDate(d) {
        if (!d) return '';
        return new Date(d).toLocaleDateString(
            this.lang === 'ru' ? 'ru-RU' : 'en-GB',
            { day: 'numeric', month: 'short', year: 'numeric' }
        );
    },

    toast(text, type = 'success') {
        document.querySelectorAll('.toast-msg').forEach(t => t.remove());
        const el = document.createElement('div');
        el.className = `toast-msg toast-${type}`;
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2700);
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

    applyTheme(theme) {
        this.theme = theme;
        document.body.classList.remove('theme-dark');
        if (theme === 'dark') document.body.classList.add('theme-dark');
        StorageManager.setItem('theme', theme);
        this._updateSheetChecks();
        this._updateSettingsBar();
        this.closeSheet();
    },

    applyLang(lang) {
        this.lang = lang;
        document.documentElement.lang = lang;
        StorageManager.setItem('lang', lang);
        this._updateSheetChecks();
        this.applyTranslations();
        this.renderAll();
        this.closeSheet();
        SidebarUI.applyTranslations(lang);
        AchievementsUI.applyTranslations(lang);
        EncryptionManager.applyLang(lang);
    },

    _updateSettingsBar() {
        const icons = { orange: '☀️', dark: '🌙' };
        document.getElementById('theme-icon').textContent = icons[this.theme] || '☀️';
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
        ph('eventDesc',        'eventDesc-ph');
        ph('taskQuickInput',   'tasks-quick-ph');

        const nc = document.getElementById('noteCategory');
        if (nc) nc.innerHTML = ['personal','work','ideas']
            .map(v => `<option value="${v}">${this.t('cat-'+v)}</option>`).join('');

        const fc = document.getElementById('filterCategory');
        if (fc) fc.innerHTML = `<option value="all">${this.t('cat-all')}</option>` +
            ['personal','work','ideas'].map(v => `<option value="${v}">${this.t('cat-'+v)}</option>`).join('');

        const mt = document.getElementById('memoryType');
        if (mt) mt.innerHTML = ['book','movie','series','game','relations','other']
            .map(v => `<option value="${v}">${this.t('type-'+v)}</option>`).join('');

        this._updateSettingsBar();
    },

    async load() {
        const data = await StorageManager.getItems([
            'lang','theme','fireStreak','lastActiveDate','streakLog'
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

        if (data.lang)  this.lang  = data.lang;
        if (data.theme) this.theme = data.theme;
        this.fireStreak     = parseInt(data.fireStreak    || '0');
        this.lastActiveDate = data.lastActiveDate || '';
        try { this.streakLog = data.streakLog ? JSON.parse(data.streakLog) : []; } catch (e) { this.streakLog = []; }

        document.body.classList.remove('theme-dark');
        if (this.theme === 'dark') document.body.classList.add('theme-dark');
        document.documentElement.lang = this.lang;

        this.applyTranslations();
        this._updateSheetChecks();
        this.renderAll();
        this.updateFooter();

        // Load tasks
        await TaskManager.load();
        TaskManager.render();
    },

    _sortPinned(arr) {
        return [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    },

    async saveNotes()    { await StorageManager.saveCollection('notes',    this.notes);    this.renderNotes();    this.updateFooter(); },
    async saveHabits()   { await StorageManager.saveCollection('habits',   this.habits);   this.renderHabits();   this.updateFooter(); },
    async saveMemories() { await StorageManager.saveCollection('memories', this.memories); this.renderMemories(); this.updateFooter(); },

    switchTab(tab) {
        ['notes','habits','tasks','memory'].forEach(t => {
            document.getElementById(t + 'Section').classList.toggle('hidden', t !== tab);
            const btn = document.getElementById(
                t === 'notes' ? 'notesTab' : t === 'habits' ? 'habitsTab' :
                t === 'tasks' ? 'tasksTabBtn' : 'memoryTab'
            );
            if (btn) btn.classList.toggle('active', t === tab);
        });
        // Refresh tasks when switching to that tab
        if (tab === 'tasks') TaskManager.render();
        // Live habit countdowns only tick while the Habits tab is actually open
        if (tab === 'habits') this._startHabitTimers();
        else this._stopHabitTimers();
    },

    // ---------- live countdown timers for active habits (no endDate) ----------
    _startHabitTimers() {
        this._stopHabitTimers();
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
        document.getElementById('activeHabitsCount').textContent = this.habits.filter(h => !h.endDate).length;
        document.getElementById('memoriesCount').textContent = this.memories.length;
        document.getElementById('tasksCount').textContent   = TaskManager.totalTasks();
        document.getElementById('fireStreakHeader').textContent  = this.fireStreak;
        if (typeof AchievementsUI !== 'undefined') AchievementsUI.recalculate();
    },

    renderAll() {
        this.renderNotes();
        this.renderHabits();
        this.renderMemories();
        this.updateFooter();
    },

    togglePin(type, id, event) {
        if (event) event.stopPropagation();
        const list = type === 'note' ? this.notes : type === 'habit' ? this.habits : this.memories;
        const item = list.find(x => x.id === id);
        if (!item) return;
        item.pinned = !item.pinned;
        const sorted = this._sortPinned(list);
        if (type === 'note')   { this.notes    = sorted; this.saveNotes(); }
        if (type === 'habit')  { this.habits   = sorted; this.saveHabits(); }
        if (type === 'memory') { this.memories = sorted; this.saveMemories(); }
        this.toast(item.pinned ? this.t('toast-pinned') : this.t('toast-unpinned'));
    },

    toggleNoteDetail(id)   { this.openNoteDetail   = this.openNoteDetail   === id ? null : id; this.renderNotes(); },
    toggleHabitDetail(id)  { this.openHabitDetail  = this.openHabitDetail  === id ? null : id; this.renderHabits(); },
    toggleMemoryDetail(id) { this.openMemoryDetail = this.openMemoryDetail === id ? null : id; this.renderMemories(); },

    async saveNote(e) {
        e.preventDefault();
        const id      = document.getElementById('noteId').value ? +document.getElementById('noteId').value : Date.now();
        const title   = document.getElementById('noteTitle').value.trim();
        const category= document.getElementById('noteCategory').value;
        const content = document.getElementById('noteContent').value.trim();
        if (!title || !content) return this.toast(this.t('toast-fill-fields'), 'error');

        const note = {
            id, title, category, content,
            date: new Date().toLocaleString(this.lang === 'ru' ? 'ru-RU' : 'en-GB'),
            pinned: false
        };
        const existing = this.notes.findIndex(n => n.id === id);
        if (existing >= 0) { note.pinned = this.notes[existing].pinned; this.notes[existing] = note; }
        else this.notes.unshift(note);

        this.notes = this._sortPinned(this.notes);
        await this.saveNotes();
        this.updateStreak();
        this._resetNoteForm();
        this.toast(this.t('toast-note-saved'));
    },

    _loadNoteToForm(note) {
        document.getElementById('noteId').value      = note.id;
        document.getElementById('noteTitle').value   = note.title;
        document.getElementById('noteCategory').value= note.category;
        document.getElementById('noteContent').value = note.content;
        document.getElementById('noteFormTitle').textContent = this.t('noteFormTitle-edit');
        document.getElementById('noteFormIcon').textContent  = '✏️';
        document.getElementById('notesSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    async deleteNote(id, e) {
        if (e) e.stopPropagation();
        if (!confirm(this.t('confirm-delete-note'))) return;
        this.notes = this.notes.filter(n => n.id !== id);
        await this.saveNotes();
        this.toast(this.t('toast-note-deleted'));
    },

    renderNotes() {
        const container = document.getElementById('notesList');
        const search    = (document.getElementById('notesSearch').value || '').toLowerCase();
        const cat       = document.getElementById('filterCategory').value;

        let list = [...this.notes];
        if (cat !== 'all') list = list.filter(n => n.category === cat);
        if (search) list = list.filter(n =>
            n.title.toLowerCase().includes(search) || n.content.toLowerCase().includes(search));

        if (!list.length) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">📝</div><p>${this.t('notes-empty')}</p></div>`;
            return;
        }

        const catClass = { personal:'cat-personal', work:'cat-work', ideas:'cat-ideas' };
        container.innerHTML = list.map((note, i) => {
            const isOpen   = this.openNoteDetail === note.id;
            const delay    = Math.min(i * 0.04, 0.25);
            const pinLabel = note.pinned ? this.t('lbl-unpin') : this.t('lbl-pin');
            return `
            <div class="record-card ${note.pinned ? 'pinned' : ''}" style="animation-delay:${delay}s" onclick="diary.toggleNoteDetail(${note.id})">
                ${note.pinned ? '<span class="pin-badge">📌</span>' : ''}
                <div class="flex items-start justify-between gap-3 mb-2">
                    <span class="cat-pill ${catClass[note.category] || 'cat-personal'}">${this.t('cat-' + note.category)}</span>
                    <span style="font-size:11px;color:var(--text-label);white-space:nowrap">${note.date}</span>
                </div>
                <div class="font-bold text-[16px] mb-1" style="color:var(--text-primary)">${note.title}</div>
                <div style="font-size:14px;color:var(--text-muted);display:-webkit-box;-webkit-line-clamp:${isOpen?'none':'3'};-webkit-box-orient:vertical;overflow:hidden">
                    ${note.content}
                </div>
                ${isOpen ? `
                <div class="detail-panel" style="margin-top:14px;padding:0" onclick="event.stopPropagation()">
                    <div class="flex gap-2 flex-wrap" style="padding:14px">
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px"
                            onclick="diary._loadNoteToForm(diary.notes.find(n=>n.id===${note.id}));diary.openNoteDetail=null;diary.renderNotes()">
                            ${this.t('lbl-edit')}
                        </button>
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.togglePin('note',${note.id},event)">
                            ${pinLabel}
                        </button>
                        <button class="btn-ghost btn-danger" style="flex:1;min-width:0;font-size:13px" onclick="diary.deleteNote(${note.id},event)">
                            ${this.t('lbl-delete')}
                        </button>
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
        const id   = document.getElementById('habitId').value ? +document.getElementById('habitId').value : Date.now();
        const name = document.getElementById('habitName').value.trim();
        const start= document.getElementById('habitStartDate').value;
        const end  = document.getElementById('habitEndDate').value || null;
        const goal = +document.getElementById('habitGoal').value;
        const desc = document.getElementById('habitDescription').value.trim();
        if (!name || !start || !goal) return this.toast(this.t('toast-fill-fields'), 'error');

        const existing = this.habits.find(h => h.id === id);
        const habit = {
            id, name, startDate: start, endDate: end, goal, description: desc,
            completedDays: existing ? existing.completedDays : [],
            pinned: existing ? existing.pinned : false
        };

        const idx = this.habits.findIndex(h => h.id === id);
        if (idx >= 0) this.habits[idx] = habit;
        else this.habits.unshift(habit);

        this.habits = this._sortPinned(this.habits);
        await this.saveHabits();
        this.updateStreak();
        this._resetHabitForm();
        this.toast(this.t('toast-habit-added'));
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

    async deleteHabit(id, e) {
        if (e) e.stopPropagation();
        if (!confirm(this.t('confirm-delete-habit'))) return;
        this.habits = this.habits.filter(h => h.id !== id);
        await this.saveHabits();
        this.toast(this.t('toast-habit-deleted'));
    },

    toggleDay(id, date, e) {
        if (e) e.stopPropagation();
        const h = this.habits.find(h => h.id === id);
        if (!h || h.endDate) return;
        const s = new Set(h.completedDays);
        s.has(date) ? s.delete(date) : s.add(date);
        h.completedDays = Array.from(s);
        if (h.completedDays.length >= h.goal) h.endDate = date;
        this.saveHabits();
        this.updateStreak();
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

    confirmEndHabit() {
        const h = this.habits.find(h => h.id === this.tempEndHabitId);
        if (h) h.endDate = document.getElementById('endHabitDate').value;
        this.saveHabits();
        this.closeModals();
    },

    // Full month/year-navigable calendar for a habit (replaces the old
    // start-date-to-now-only table). Lets the person browse any past or
    // future month/year while reviewing/toggling that habit's history.
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
        const statusText = habit.endDate ? '✅ ' + this.t('lbl-completed') : (this.lang === 'ru' ? 'в процессе' : 'in progress');
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

        let html = '<tr>';
        for (let i = 0; i < offset; i++) html += '<td class="empty"></td>';
        for (let d = 1; d <= daysInMonth; d++) {
            const col = (offset + d - 1) % 7;
            if (col === 0 && d !== 1) html += '</tr><tr>';
            const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const done = habit.completedDays.includes(ds);
            const inRange = ds >= habit.startDate && (!habit.endDate || ds <= habit.endDate);
            const cls = done ? 'done' : '';
            const clickable = inRange && !habit.endDate;
            html += `<td class="${cls}" ${clickable ? `onclick="diary.toggleDay(${habit.id},'${ds}',event);diary._renderHabitCalendar()"` : 'style="opacity:0.35;cursor:default"'}>${d}</td>`;
        }
        html += '</tr>';
        table.innerHTML = header + html;
    },

    renderHabits() {
        const container = document.getElementById('habitsList');
        const search    = (document.getElementById('habitsSearch').value || '').toLowerCase();
        const list      = this.habits.filter(h => h.name.toLowerCase().includes(search));

        if (!list.length) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">🔥</div><p>${this.t('habits-empty')}</p></div>`;
            return;
        }

        const todayStr = this.today();
        container.innerHTML = list.map((h, i) => {
            const done      = h.completedDays.length;
            const progress  = Math.min(Math.round(done / h.goal * 100), 100);
            const ended     = !!h.endDate;
            const todayDone = h.completedDays.includes(todayStr);
            const isOpen    = this.openHabitDetail === h.id;
            const delay     = Math.min(i * 0.04, 0.25);
            const pinLabel  = h.pinned ? this.t('lbl-unpin') : this.t('lbl-pin');

            return `
            <div class="record-card ${h.pinned ? 'pinned' : ''} ${ended ? 'opacity-80' : ''}" style="animation-delay:${delay}s" onclick="diary.toggleHabitDetail(${h.id})">
                ${h.pinned ? '<span class="pin-badge">📌</span>' : ''}
                <div class="flex items-start justify-between gap-2 mb-2">
                    <div>
                        <div class="font-bold text-[16px]" style="color:var(--text-primary)">${h.name}</div>
                        ${h.description ? `<div style="font-size:13px;color:var(--text-muted);margin-top:2px">${h.description}</div>` : ''}
                    </div>
                    ${ended ? `<span class="chip green">${this.t('lbl-completed')}</span>` : ''}
                </div>
                <div class="flex justify-between text-center mt-3 mb-2">
                    <div>
                        <div style="font-size:22px;font-weight:900;color:#34d399">${done}</div>
                        <div style="font-size:11px;color:var(--text-label)">${this.t('lbl-done')}</div>
                    </div>
                    <div>
                        <div style="font-size:22px;font-weight:900;color:var(--text-primary)">${h.goal}</div>
                        <div style="font-size:11px;color:var(--text-label)">${this.t('lbl-goal')}</div>
                    </div>
                    <div>
                        <div style="font-size:22px;font-weight:900;color:#fbbf24">${progress}%</div>
                        <div style="font-size:11px;color:var(--text-label)">${this.t('lbl-progress')}</div>
                    </div>
                </div>
                <div class="prog-track mb-3"><div class="prog-fill" style="width:${progress}%"></div></div>
                ${this._renderHabitCountdown(h)}
                ${isOpen ? `
                <div class="detail-panel" onclick="event.stopPropagation()">
                    <div class="flex gap-2 flex-wrap mb-3">
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.showCalendar(${h.id},event)">${this.t('lbl-calendar')}</button>
                        <button class="btn-ghost ${todayDone ? 'btn-success' : ''}" style="flex:1;min-width:0;font-size:13px" onclick="diary.toggleDay(${h.id},'${todayStr}',event)">
                            ${todayDone ? this.t('lbl-done-today') : this.t('lbl-mark-today')}
                        </button>
                    </div>
                    <div class="flex gap-2 flex-wrap">
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary._loadHabitToForm(diary.habits.find(h=>h.id===${h.id}));diary.openHabitDetail=null;diary.renderHabits()">${this.t('lbl-edit')}</button>
                        ${!ended ? `<button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.endHabit(${h.id},event)">${this.t('lbl-end-habit')}</button>` : ''}
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.togglePin('habit',${h.id},event)">${pinLabel}</button>
                        <button class="btn-ghost btn-danger" style="flex:1;min-width:0;font-size:13px" onclick="diary.deleteHabit(${h.id},event)">${this.t('lbl-delete')}</button>
                    </div>
                </div>` : ''}
            </div>`;
        }).join('');
    },

    _resetHabitForm() {
        document.getElementById('habitForm').reset();
        document.getElementById('habitId').value = '';
        document.getElementById('habitStartDate').value = this.today();
        document.getElementById('habitFormTitle').textContent = this.t('habitFormTitle-new');
    },

    async saveMemory(e) {
        e.preventDefault();
        const id     = document.getElementById('memoryId').value ? +document.getElementById('memoryId').value : Date.now();
        const title  = document.getElementById('memoryTitle').value.trim();
        const type   = document.getElementById('memoryType').value;
        const start  = document.getElementById('memoryStartDate').value;
        const end    = document.getElementById('memoryEndDate').value || null;
        const notes  = document.getElementById('memoryNotes').value.trim();
        const partner= type === 'relations' ? document.getElementById('partnerName').value.trim() : '';

        const existing = this.memories.find(m => m.id === id);
        const memory = {
            id, title, type, startDate: start, endDate: end, notes, partnerName: partner,
            events: existing ? existing.events : [],
            date: new Date().toLocaleString(this.lang === 'ru' ? 'ru-RU' : 'en-GB'),
            pinned: existing ? existing.pinned : false
        };

        const idx = this.memories.findIndex(m => m.id === id);
        if (idx >= 0) this.memories[idx] = memory;
        else this.memories.unshift(memory);

        this.memories = this._sortPinned(this.memories);
        await this.saveMemories();
        this.updateStreak();
        this._resetMemoryForm();
        this.toast(this.t('toast-memory-saved'));
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

    async deleteMemory(id, e) {
        if (e) e.stopPropagation();
        if (!confirm(this.t('confirm-delete-memory'))) return;
        this.memories = this.memories.filter(m => m.id !== id);
        await this.saveMemories();
        this.toast(this.t('toast-memory-deleted'));
    },

    showAddEvent(memId, editIdx, e) {
        if (e) e.stopPropagation();
        document.getElementById('eventMemoryId').value = memId;
        document.getElementById('editEventIdx').value  = editIdx !== undefined ? editIdx : '';
        const mem = this.memories.find(m => m.id === memId);
        if (editIdx !== undefined && editIdx !== '' && mem) {
            const ev = mem.events[editIdx];
            document.getElementById('eventDate').value = ev.date;
            document.getElementById('eventDesc').value = ev.desc;
            document.getElementById('add-event-title').textContent = this.t('lbl-edit');
        } else {
            document.getElementById('eventDate').value = this.today();
            document.getElementById('eventDesc').value = '';
            document.getElementById('add-event-title').textContent = this.t('add-event-title');
        }
        document.getElementById('eventModal').classList.add('open');
    },

    async saveEvent(e) {
        e.preventDefault();
        const memId   = +document.getElementById('eventMemoryId').value;
        const editIdx = document.getElementById('editEventIdx').value;
        const date    = document.getElementById('eventDate').value;
        const desc    = document.getElementById('eventDesc').value.trim();
        const mem     = this.memories.find(m => m.id === memId);
        if (!mem) return;
        if (editIdx !== '') { mem.events[+editIdx] = { date, desc }; }
        else {
            if (!mem.events) mem.events = [];
            mem.events.push({ date, desc });
            mem.events.sort((a,b) => new Date(a.date) - new Date(b.date));
        }
        await this.saveMemories();
        this.updateStreak();
        this.closeModals();
        this.toast(this.t('toast-event-saved'));
    },

    async deleteEvent(memId, idx, e) {
        if (e) e.stopPropagation();
        if (!confirm(this.t('confirm-delete-event'))) return;
        const mem = this.memories.find(m => m.id === memId);
        if (mem) { mem.events.splice(idx, 1); await this.saveMemories(); }
        this.toast(this.t('toast-event-deleted'));
    },

    endRelations(id, e) {
        if (e) e.stopPropagation();
        this.tempEndRelationsId = id;
        const m = this.memories.find(m => m.id === id);
        document.getElementById('endRelationsDate').value = m.endDate || this.today();
        document.getElementById('endRelationsModal').classList.add('open');
    },

    confirmEndRelations() {
        const m = this.memories.find(m => m.id === this.tempEndRelationsId);
        if (m) m.endDate = document.getElementById('endRelationsDate').value;
        this.saveMemories();
        this.closeModals();
    },

    renderMemories() {
        const container = document.getElementById('memoriesList');
        const search    = (document.getElementById('memoriesSearch').value || '').toLowerCase();
        const list      = this.memories.filter(m =>
            m.title.toLowerCase().includes(search) ||
            (m.notes || '').toLowerCase().includes(search) ||
            (m.partnerName || '').toLowerCase().includes(search)
        );

        if (!list.length) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><p>${this.t('memories-empty')}</p></div>`;
            return;
        }

        container.innerHTML = list.map((m, i) => {
            const delay    = Math.min(i * 0.04, 0.25);
            const isOpen   = this.openMemoryDetail === m.id;
            const pinLabel = m.pinned ? this.t('lbl-unpin') : this.t('lbl-pin');
            if (m.type === 'relations') return this._renderRelCard(m, isOpen, delay, pinLabel);

            const typeLabel = this.t('type-' + m.type);
            return `
            <div class="record-card ${m.pinned ? 'pinned' : ''}" style="animation-delay:${delay}s" onclick="diary.toggleMemoryDetail(${m.id})">
                ${m.pinned ? '<span class="pin-badge">📌</span>' : ''}
                <div class="flex items-start justify-between gap-2 mb-2">
                    <span class="chip">${typeLabel}</span>
                    <span style="font-size:11px;color:var(--text-label)">${this.fmtDate(m.startDate)}</span>
                </div>
                <div class="font-bold text-[16px] mb-1" style="color:var(--text-primary)">${m.title}</div>
                ${m.notes ? `<div style="font-size:13px;color:var(--text-muted);display:-webkit-box;-webkit-line-clamp:${isOpen?'none':'2'};-webkit-box-orient:vertical;overflow:hidden">${m.notes}</div>` : ''}
                ${m.endDate ? `<div style="margin-top:6px;font-size:12px;color:var(--text-label)">${this.t('rel-until')} ${this.fmtDate(m.endDate)}</div>` : ''}
                ${isOpen ? `
                <div class="detail-panel" style="margin-top:14px;padding:0" onclick="event.stopPropagation()">
                    <div class="flex gap-2 flex-wrap" style="padding:14px">
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary._loadMemoryToForm(diary.memories.find(m=>m.id===${m.id}));diary.openMemoryDetail=null;diary.renderMemories()">${this.t('lbl-edit')}</button>
                        <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.togglePin('memory',${m.id},event)">${pinLabel}</button>
                        <button class="btn-ghost btn-danger" style="flex:1;min-width:0;font-size:13px" onclick="diary.deleteMemory(${m.id},event)">${this.t('lbl-delete')}</button>
                    </div>
                </div>` : ''}
            </div>`;
        }).join('');
    },

    _renderRelCard(m, isOpen, delay, pinLabel) {
        const msPerDay = 86400000;
        const endMs    = m.endDate ? new Date(m.endDate).getTime() : Date.now();
        const days     = Math.max(1, Math.floor((endMs - new Date(m.startDate).getTime()) / msPerDay) + 1);
        const isEnded  = !!m.endDate;
        const events   = m.events || [];

        const eventsHtml = events.length
            ? events.map((ev, idx) => `
                <div class="rel-event-item">
                    <div class="rel-event-date">${this.fmtDate(ev.date)}</div>
                    <div class="rel-event-desc">${ev.desc}</div>
                    <div class="rel-event-actions">
                        <button class="rel-event-btn" onclick="diary.showAddEvent(${m.id},${idx},event)">✏️</button>
                        <button class="rel-event-btn" onclick="diary.deleteEvent(${m.id},${idx},event)">🗑️</button>
                    </div>
                </div>`).join('')
            : `<div style="font-size:13px;color:var(--text-label);padding:6px 0">${this.t('lbl-no-events')}</div>`;

        return `
        <div class="rel-card ${m.pinned ? 'pinned' : ''}" style="animation-delay:${delay}s" onclick="diary.toggleMemoryDetail(${m.id})">
            ${m.pinned ? '<span class="pin-badge" style="position:absolute;top:12px;right:12px;z-index:2">📌</span>' : ''}
            <div class="rel-card-header">
                <div class="flex items-start justify-between gap-2">
                    <div>
                        <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.75;margin-bottom:4px">❤️ ${this.t('type-relations')}</div>
                        <div style="font-size:20px;font-weight:900;font-family:'Syne',sans-serif">${m.title}</div>
                        ${m.partnerName ? `<div style="font-size:14px;opacity:.85;margin-top:2px">👤 ${m.partnerName}</div>` : ''}
                    </div>
                    <div style="text-align:right;flex-shrink:0">
                        <div style="font-size:28px;font-weight:900;line-height:1">${days}</div>
                        <div style="font-size:11px;opacity:.75">${this.t('rel-days-together')}</div>
                    </div>
                </div>
                <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
                    <span style="background:rgba(255,255,255,0.2);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700">${this.t('rel-since')} ${this.fmtDate(m.startDate)}</span>
                    ${isEnded
                        ? `<span style="background:rgba(0,0,0,0.2);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700">💔 ${this.fmtDate(m.endDate)}</span>`
                        : `<span style="background:rgba(255,255,255,0.15);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700">✨ ${this.t('rel-still-together')}</span>`
                    }
                </div>
            </div>
            <div class="rel-card-body" onclick="event.stopPropagation()">
                ${m.notes ? `<div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;font-style:italic">"${m.notes}"</div>` : ''}
                <div style="margin-bottom:10px">
                    <div style="font-size:12px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text-label);margin-bottom:8px">${this.t('lbl-events')}</div>
                    ${eventsHtml}
                </div>
                <div class="flex gap-2 flex-wrap" style="margin-top:10px">
                    <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.showAddEvent(${m.id},undefined,event)">${this.t('lbl-add-event')}</button>
                    ${!isEnded ? `<button class="btn-ghost btn-danger" style="flex:1;min-width:0;font-size:13px" onclick="diary.endRelations(${m.id},event)">${this.t('lbl-broke-up')}</button>` : ''}
                </div>
                ${isOpen ? `
                <div class="divider"></div>
                <div class="flex gap-2 flex-wrap">
                    <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary._loadMemoryToForm(diary.memories.find(m=>m.id===${m.id}));diary.openMemoryDetail=null;diary.renderMemories()">${this.t('lbl-edit')}</button>
                    <button class="btn-ghost" style="flex:1;min-width:0;font-size:13px" onclick="diary.togglePin('memory',${m.id},event)">${pinLabel}</button>
                    <button class="btn-ghost btn-danger" style="flex:1;min-width:0;font-size:13px" onclick="diary.deleteMemory(${m.id},event)">${this.t('lbl-delete')}</button>
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

    updateStreak() {
        const todayStr = this.today();
        if (this.lastActiveDate === todayStr) return;
        const yestStr = Util.addDays(todayStr, -1);
        const old = this.fireStreak;
        this.fireStreak     = (this.lastActiveDate === yestStr) ? this.fireStreak + 1 : 1;
        this.lastActiveDate = todayStr;

        // Keep a small rolling log of the exact days that kept the streak alive,
        // so the mini calendar can show real history rather than just a count.
        // If the streak was just broken and restarted, drop the old run first.
        if (this.fireStreak === 1) this.streakLog = [];
        if (!this.streakLog.includes(todayStr)) this.streakLog.push(todayStr);
        this.streakLog = this.streakLog.slice(-90); // cap growth; plenty for any heatmap view

        this._saveStreak().catch(e => console.warn('[diary] streak save failed:', e));
        if (this.fireStreak > old) {
            const hdr = document.getElementById('fireStreakHeader');
            const emj = document.getElementById('fireEmoji');
            hdr.classList.remove('fire-anim'); emj.classList.remove('fire-anim');
            void hdr.offsetWidth;
            hdr.classList.add('fire-anim'); emj.classList.add('fire-anim');
            setTimeout(() => { hdr.classList.remove('fire-anim'); emj.classList.remove('fire-anim'); }, 700);
        }
        this.updateFooter();
    },

    async _saveStreak() {
        await StorageManager.setItem('fireStreak',     this.fireStreak.toString());
        await StorageManager.setItem('lastActiveDate', this.lastActiveDate);
        await StorageManager.setItem('streakLog',      JSON.stringify(this.streakLog));
    },

    // ---------- fire streak mini calendar/heatmap ----------
    showStreakCalendar() {
        const countEl = document.getElementById('streakCalCount');
        if (countEl) countEl.textContent = this.fireStreak;
        const titleEl = document.getElementById('streak-cal-title');
        if (titleEl) titleEl.textContent = '🔥 ' + this.t('streak-cal-title');
        const curLabel = document.getElementById('streak-cal-current');
        if (curLabel) curLabel.textContent = this.t('streak-cal-current');
        const hint = document.getElementById('streak-cal-hint');
        if (hint) hint.textContent = this.t('streak-cal-hint');

        const grid = document.getElementById('streakCalGrid');
        if (grid) {
            const days = 35; // 5 full weeks, GitHub-style heatmap
            const todayStr = this.today();
            const activeSet = new Set(this.streakLog);
            let html = '';
            for (let i = days - 1; i >= 0; i--) {
                const ds = Util.addDays(todayStr, -i);
                const dayNum = Util.parseLocalDate(ds).getDate();
                const active = activeSet.has(ds);
                html += `<div class="streak-day ${active ? 'active' : ''}" title="${ds}">${active ? '🔥' : dayNum}</div>`;
            }
            grid.innerHTML = html;
        }
        document.getElementById('streakCalendarModal').classList.add('open');
    },

    async init() {
        try {
            if (window.Telegram && Telegram.WebApp) {
                Telegram.WebApp.ready();
                Telegram.WebApp.expand();
            }
        } catch(e) {}

        StorageManager.init();
        await this.load();

        document.getElementById('noteForm').addEventListener('submit',   e => this.saveNote(e));
        document.getElementById('habitForm').addEventListener('submit',  e => this.saveHabit(e));
        document.getElementById('memoryForm').addEventListener('submit', e => this.saveMemory(e));
        document.getElementById('eventForm').addEventListener('submit',  e => this.saveEvent(e));

        // Task quick-add: Enter key support + iOS-safe click handler
        const qi = document.getElementById('taskQuickInput');
        if (qi) {
            qi.addEventListener('keydown', e => TaskManager.onInputKeydown(e));
            // iOS Safari: also handle 'compositionend' for IME keyboards
            qi.addEventListener('compositionend', () => { /* allow IME to settle */ });
        }
        // Attach add button via JS (more reliable than inline onclick on iOS Safari)
        const taskAddBtn = document.getElementById('taskAddBtn');
        if (taskAddBtn) {
            // Use both click and touchend for maximum iOS compatibility
            taskAddBtn.addEventListener('click', e => { e.preventDefault(); TaskManager.quickAdd(); });
            taskAddBtn.addEventListener('touchend', e => { e.preventDefault(); TaskManager.quickAdd(); }, { passive: false });
        }

        document.getElementById('clearAll').addEventListener('click', async () => {
            if (!confirm(this.t('confirm-clear-all'))) return;
            this.notes = [];
            await this.saveNotes();
            this.toast(this.t('toast-all-deleted'));
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', e => { if (e.target === overlay) this.closeModals(); });
        });

        const sheet = document.getElementById('bottomSheet');
        let sheetStartY = 0;
        sheet.addEventListener('touchstart', e => { sheetStartY = e.touches[0].clientY; }, { passive: true });
        sheet.addEventListener('touchend', e => { if (e.changedTouches[0].clientY - sheetStartY > 60) this.closeSheet(); }, { passive: true });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                this.closeModals(); this.closeSheet();
                SidebarUI.close(); AchievementsUI.close();
            }
        });

        const todayStr = this.today();
        document.getElementById('habitStartDate').value  = todayStr;
        document.getElementById('memoryStartDate').value = todayStr;
        document.getElementById('eventDate').value       = todayStr;

        SidebarUI.init();
        AchievementsUI.init();

        console.log('%c✅ DailyBookimix v6 — Master-Key auth + sharded storage + Daily Tasks fixes!', 'color:#ff8c42;font-weight:900;font-size:16px');
    }
};


