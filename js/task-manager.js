// @ts-check
// ================================================================
//  TASK MANAGER — Daily Tasks
//
//  Storage layout: one small shard per DAY (`task_day_YYYY-MM-DD`), a tiny
//  per-day summary index (`task_index`, {done,total}) that drives the calendar
//  without loading every day, and lifetime aggregates (`task_stats`) updated
//  incrementally so pruning old day-shards never loses streaks/totals.
//  Dates are LOCAL calendar dates (Util.localDateStr), never UTC.
//
//  The FIRE streak (diary.updateStreak) is extended from exactly two places,
//  and only after the save succeeded: quickAdd() and toggleTask() (when a task
//  becomes completed). updateStreak() is idempotent per calendar day.
// ================================================================
const TaskManager = {
    _data: {},          // cache of day objects: { 'YYYY-MM-DD': {tasks, mood, countedActive, countedPerfect} }
    _loaded: new Set(), // days whose stored shard has really been read (dayData() may create an empty placeholder that is NOT in here)
    _summary: {},        // lightweight {done,total} per date, drives the archive scroller without loading full days
    _stats: {
        totalCompletedAllTime: 0, totalTasksAddedAllTime: 0, maxCompletedInSingleDay: 0,
        activeDaysCount: 0, hadPerfectDay: false, currentStreak: 0, longestStreak: 0, lastStreakDate: ''
    },
    _viewDate: null,
    _newTaskImp: false,
    _adding: false,      // v9.1: re-entrancy guard (Enter key could double-submit while a save was in flight)
    _retentionDays: 120, // raw day-shards older than this get pruned; lifetime stats are unaffected
    _calYear: null,       // year currently shown in the monthly calendar (defaults to today's)
    _calMonth: null,      // 0-indexed month currently shown in the monthly calendar

    today() { return Util.localDateStr(); },

    // ---------- loading / migration ----------
    async load() {
        const [summaryRaw, statsRaw] = await Promise.all([
            StorageManager.getItem('task_index'),
            StorageManager.getItem('task_stats'),
        ]);
        try { this._summary = summaryRaw ? JSON.parse(summaryRaw) : {}; } catch (e) { this._summary = {}; }
        try { if (statsRaw) this._stats = { ...this._stats, ...JSON.parse(statsRaw) }; } catch (e) { /* keep defaults */ }

        if (summaryRaw === null) await this._migrateFromLegacyBlob();

        await this._loadDay(this.today());
        this._prune().catch(e => DBLog.warn('Tasks', 'Old task days could not be cleaned up.', e)); // best-effort, never blocks the UI
    },

    async _migrateFromLegacyBlob() {
        const raw = await StorageManager.getItem('tasks_v1');
        if (!raw) return;
        let legacy = {};
        try { legacy = JSON.parse(raw); } catch (e) { return; }
        const dates = Object.keys(legacy).sort();
        for (const ds of dates) {
            const day = legacy[ds] || { tasks: [], mood: '' };
            day.countedActive = false; day.countedPerfect = false;
            this._setDay(ds, day);
            this._recomputeSummaryFor(ds);
            this._bumpAchievementFlags(ds);
            await StorageManager.setItem('task_day_' + ds, JSON.stringify(day));
        }
        await StorageManager.setItem('task_index', JSON.stringify(this._summary));
        await StorageManager.setItem('task_stats', JSON.stringify(this._stats));
        await StorageManager.removeItem('tasks_v1');
    },

    async _loadDay(dateStr) {
        if (this._loaded.has(dateStr) && this._data[dateStr]) return this._data[dateStr];
        const raw = await StorageManager.getItem('task_day_' + dateStr);
        let day;
        try { day = raw ? JSON.parse(raw) : null; } catch (e) { day = null; }
        if (!day || !Array.isArray(day.tasks)) day = { tasks: [], mood: '', countedActive: false, countedPerfect: false };
        // Never replace a day object the UI already mutated while the read was in flight.
        if (!this._loaded.has(dateStr)) this._data[dateStr] = day;
        this._loaded.add(dateStr);
        return this._data[dateStr];
    },
    /** Installs a day object that is authoritative in memory (backup import / migration). */
    _setDay(dateStr, day) { this._data[dateStr] = day; this._loaded.add(dateStr); },

    /** Called when the app comes back after midnight: load the new "today" from storage (it may hold
     *  tasks carried over yesterday), then redraw. Without this the stored shard would stay invisible. */
    async onDateRollover() {
        await this._loadDay(this.today());
        if (!this._viewDate) { this._calYear = null; this._calMonth = null; }
        this.render();
    },

    // Synchronous accessor — safe for already-loaded days (today is always
    // loaded by load(); any other day is loaded by viewDate() before render()).
    dayData(dateStr) {
        if (!this._data[dateStr]) this._data[dateStr] = { tasks: [], mood: '', countedActive: false, countedPerfect: false };
        return this._data[dateStr];
    },

    async _prune() {
        const cutoff = Util.addDays(this.today(), -this._retentionDays);
        const stale = Object.keys(this._summary).filter(d => d < cutoff);
        if (!stale.length) return;
        await Promise.all(stale.map(d => StorageManager.removeItem('task_day_' + d)));
        stale.forEach(d => { delete this._summary[d]; delete this._data[d]; this._loaded.delete(d); });
        await StorageManager.setItem('task_index', JSON.stringify(this._summary));
    },

    async wipeAll() {
        const dates = Object.keys(this._summary);
        await Promise.all(dates.map(d => StorageManager.removeItem('task_day_' + d)));
        await StorageManager.removeItem('task_index');
        await StorageManager.removeItem('task_stats');
        await StorageManager.removeItem('tasks_v1');
        this._data = {}; this._summary = {}; this._loaded = new Set();
        this._stats = { totalCompletedAllTime: 0, totalTasksAddedAllTime: 0, maxCompletedInSingleDay: 0, activeDaysCount: 0, hadPerfectDay: false, currentStreak: 0, longestStreak: 0, lastStreakDate: '' };
    },

    // ---------- incremental summary / lifetime-stats bookkeeping ----------
    _recomputeSummaryFor(dateStr) {
        const day = this._data[dateStr];
        const done = day.tasks.filter(t => t.completed).length;
        this._summary[dateStr] = { done, total: day.tasks.length };
    },
    _bumpAchievementFlags(dateStr) {
        const day = this._data[dateStr];
        const { done, total } = this._summary[dateStr];
        if (done > 0 && !day.countedActive) { day.countedActive = true; this._stats.activeDaysCount += 1; }
        if (total >= 3 && done === total && !day.countedPerfect) { day.countedPerfect = true; this._stats.hadPerfectDay = true; }
        this._stats.maxCompletedInSingleDay = Math.max(this._stats.maxCompletedInSingleDay, done);
        this._updateStreak(dateStr, done > 0);
    },
    _updateStreak(dateStr, hasCompletion) {
        if (!hasCompletion || this._stats.lastStreakDate === dateStr) return;
        if (this._stats.lastStreakDate && Util.addDays(this._stats.lastStreakDate, 1) === dateStr) {
            this._stats.currentStreak += 1;
        } else {
            this._stats.currentStreak = 1;
        }
        this._stats.lastStreakDate = dateStr;
        this._stats.longestStreak = Math.max(this._stats.longestStreak, this._stats.currentStreak);
    },
    _snapshotFor(dateStr) {
        return {
            day: JSON.parse(JSON.stringify(this._data[dateStr] || { tasks: [], mood: '', countedActive: false, countedPerfect: false })),
            summary: this._summary[dateStr] ? { ...this._summary[dateStr] } : null,
            stats: { ...this._stats },
        };
    },
    _restoreSnapshot(dateStr, snap) {
        this._data[dateStr] = snap.day;
        if (snap.summary) this._summary[dateStr] = snap.summary; else delete this._summary[dateStr];
        this._stats = snap.stats;
    },
    async _persistDay(dateStr) {
        await Promise.all([
            StorageManager.setItem('task_day_' + dateStr, JSON.stringify(this._data[dateStr])),
            StorageManager.setItem('task_index', JSON.stringify(this._summary)),
            StorageManager.setItem('task_stats', JSON.stringify(this._stats)),
        ]);
    },

    // ---------- UI actions (same behavior as v5, new persistence underneath) ----------
    toggleNewImp() {
        this._newTaskImp = !this._newTaskImp;
        const btn = document.getElementById('taskImpToggle');
        if (btn) { btn.classList.toggle('active', this._newTaskImp); btn.setAttribute('aria-pressed', String(this._newTaskImp)); }
    },

    async quickAdd() {
        const input = document.getElementById('taskQuickInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text || this._adding) return;
        this._adding = true;

        const addBtn = document.getElementById('taskAddBtn');
        if (addBtn) addBtn.disabled = true;

        const dateStr = this._viewDate || this.today();
        await this._loadDay(dateStr); // never build on an empty placeholder: a save would overwrite stored tasks
        const snap = this._snapshotFor(dateStr);
        const day = this.dayData(dateStr);

        const newTask = {
            id: this._uniqueId(day), text, important: this._newTaskImp, completed: false,
            completedAt: null, createdAt: new Date().toISOString()
        };
        day.tasks.unshift(newTask);
        this._sortTasks(day);
        this._stats.totalTasksAddedAllTime += 1;
        this._recomputeSummaryFor(dateStr);
        this._bumpAchievementFlags(dateStr);

        input.value = '';
        this._newTaskImp = false;
        const impBtn = document.getElementById('taskImpToggle');
        if (impBtn) impBtn.classList.remove('active');

        this.render();

        try {
            await this._persistDay(dateStr);
            ActionLog.record('task_created');
            diary.toast(diary.t('tasks-toast-added'));
            // v9.1: creating a task is a real action → extend the fire streak
            // (before recalculate so streak achievements see the new value).
            diary.updateStreak();
            AchievementsUI.recalculate();
        } catch (e) {
            this._restoreSnapshot(dateStr, snap);
            input.value = text;
            this.render();
            diary.toast(diary.t('err-task-save'), 'error');
            DBLog.error('Tasks', 'A new task could not be saved.', e);
        } finally {
            this._adding = false;
            if (addBtn) addBtn.disabled = false;
        }
    },

    // v9.1: Date.now() alone can collide if two tasks are created in the
    // same millisecond (or after a carry-over copy), which would make
    // toggle/delete hit the wrong task. Bump until unique within the day.
    _uniqueId(day) {
        let id = Date.now();
        const used = new Set(day.tasks.map(t => t.id));
        while (used.has(id)) id += 1;
        return id;
    },

    onInputKeydown(e) {
        if (e.key === 'Enter') { e.preventDefault(); this.quickAdd(); }
    },

    async toggleTask(dateStr, taskId) {
        await this._loadDay(dateStr);
        const day = this.dayData(dateStr);
        const task = day.tasks.find(t => t.id === taskId);
        if (!task) return;
        const snap = this._snapshotFor(dateStr);

        task.completed = !task.completed;
        task.completedAt = task.completed ? new Date().toISOString() : null;
        this._stats.totalCompletedAllTime = Math.max(0, this._stats.totalCompletedAllTime + (task.completed ? 1 : -1));
        this._sortTasks(day);
        this._recomputeSummaryFor(dateStr);
        this._bumpAchievementFlags(dateStr);
        this.render();

        try {
            await this._persistDay(dateStr);
            // v9.1: only a task becoming COMPLETED extends the fire streak;
            // un-completing must not.
            if (task.completed) { ActionLog.record('task_completed'); diary.updateStreak(); }
            AchievementsUI.recalculate();
        } catch (e) {
            this._restoreSnapshot(dateStr, snap);
            this.render();
            diary.toast(diary.t('err-save'), 'error');
            DBLog.error('Tasks', 'A task change could not be saved.', e);
        }
    },

    async deleteTask(dateStr, taskId) {
        await this._loadDay(dateStr);
        const day = this.dayData(dateStr);
        const removed = day.tasks.find(t => t.id === taskId);
        const snap = this._snapshotFor(dateStr);
        day.tasks = day.tasks.filter(t => t.id !== taskId);
        if (removed && removed.completed) this._stats.totalCompletedAllTime = Math.max(0, this._stats.totalCompletedAllTime - 1);
        this._recomputeSummaryFor(dateStr);
        this.render();
        try {
            await this._persistDay(dateStr);
            ActionLog.record('task_deleted');
            diary.toast(diary.t('tasks-toast-deleted'));
        } catch (e) {
            this._restoreSnapshot(dateStr, snap);
            this.render();
            diary.toast(diary.t('err-delete'), 'error');
            DBLog.error('Tasks', 'A task could not be deleted.', e);
        }
    },

    _sortTasks(day) {
        day.tasks.sort((a, b) => {
            if (a.completed !== b.completed) return a.completed ? 1 : -1;
            if (a.important !== b.important) return a.important ? -1 : 1;
            return 0;
        });
    },

    async setMood(dateStr, mood) {
        await this._loadDay(dateStr);
        const day = this.dayData(dateStr);
        const prevMood = day.mood;
        day.mood = (day.mood === mood) ? '' : mood;
        this.render();
        try {
            await this._persistDay(dateStr);
        } catch (e) {
            day.mood = prevMood;
            this.render();
            DBLog.error('Tasks', 'The mood could not be saved.', e);
            diary.toast(diary.t('err-mood-save'), 'error');
        }
    },

    async carryOver() {
        const todayStr = this.today();
        await this._loadDay(todayStr);
        const day = this.dayData(todayStr);
        const incomplete = day.tasks.filter(t => !t.completed);
        if (!incomplete.length) return;

        const tomorrowStr = Util.addDays(todayStr, 1);
        await this._loadDay(tomorrowStr);
        const snap = this._snapshotFor(tomorrowStr);
        const nextDay = this.dayData(tomorrowStr);

        const existingIds = new Set(nextDay.tasks.map(t => t.id));
        const added = [];
        incomplete.forEach(t => {
            if (!existingIds.has(t.id)) {
                const copy = { ...t, completedAt: null, completed: false, createdAt: new Date().toISOString() };
                nextDay.tasks.push(copy);
                added.push(copy.id);
            }
        });
        this._sortTasks(nextDay);
        this._stats.totalTasksAddedAllTime += added.length;
        this._recomputeSummaryFor(tomorrowStr);

        try {
            await this._persistDay(tomorrowStr);
            diary.toast(diary.t('tasks-toast-carried'));
        } catch (e) {
            this._restoreSnapshot(tomorrowStr, snap);
            DBLog.error('Tasks', 'Unfinished tasks could not be carried over.', e);
            diary.toast(diary.t('err-carryover'), 'error');
        }
    },

    // ---------- stats surface used by the footer + AchievementsUI ----------
    completionStreak() { return this._stats.currentStreak; },
    totalCompleted() { return this._stats.totalCompletedAllTime; },
    totalTasks() { return this._stats.totalTasksAddedAllTime; },
    getStats() { return { ...this._stats }; },

    // ---------- rendering (same markup/behavior as v5) ----------
    render() {
        const dateStr = this._viewDate || this.today();
        const today = this.today();
        const isToday = (dateStr === today);

        const inp = document.getElementById('taskQuickInput');
        if (inp) inp.placeholder = diary.t('tasks-quick-ph');

        this._renderCalendar(dateStr);

        // The streak itself lives in the header (diary.updateStreak); this bar shows only the selected day.
        const statsBar = document.getElementById('taskStatsBar');
        if (statsBar) {
            const sum = this._summary[dateStr] || { done: 0, total: 0 };
            statsBar.innerHTML = `
                <div class="task-stat-chip"><span aria-hidden="true">✅</span> <b>${sum.done}</b> ${diary.t('tasks-stat-done')}</div>
                <div class="task-stat-chip"><span aria-hidden="true">📋</span> <b>${sum.total}</b> ${diary.t('tasks-stat-total')}</div>
            `;
        }

        const list = document.getElementById('tasksList');
        const dayData = this.dayData(dateStr);
        const tasks = dayData.tasks;

        // Real-time search: task text, plus localized status keywords (done / pending / important).
        const searchInput = document.getElementById('tasksSearch');
        const searchRaw   = searchInput ? (searchInput.value || '') : '';
        const search      = searchRaw.trim().toLowerCase();
        const visibleTasks = search ? tasks.filter(t => this._matchesTaskSearch(t, search)) : tasks;

        if (list) {
            if (!tasks.length) {
                list._key = null;
                list.innerHTML = diary._emptyState('✅', diary.t('tasks-empty'));
            } else if (!visibleTasks.length) {
                list._key = null;
                list.innerHTML = diary._emptyState('🔍', diary.t('search-empty'));
            } else {
                // Entrance animation only when the set of tasks changes, not on every tick/toggle.
                diary._setListKey(list, dateStr + '|' + search + '|' + visibleTasks.map(t => t.id).sort().join(','));
                const delLabel = Util.escHtml(diary.t('aria-del-task'));
                list.innerHTML = visibleTasks.map((task, i) => {
                    const id = Number(task.id);
                    const text = diary._hl(task.text, search, searchRaw);
                    return `
                    <div class="task-item ${task.important ? 'important' : ''} ${task.completed ? 'completed' : ''}" style="--i:${Math.min(i, 8)}">
                        <div class="task-check" role="checkbox" tabindex="0" aria-checked="${task.completed ? 'true' : 'false'}"
                             onclick="TaskManager.toggleTask('${dateStr}',${id})"
                             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();TaskManager.toggleTask('${dateStr}',${id});}">
                            <span class="task-check-inner" aria-hidden="true">✓</span>
                        </div>
                        <span class="task-text">${text}</span>
                        ${task.important ? '<span class="task-star" aria-hidden="true">⭐</span>' : ''}
                        <button type="button" class="task-del-btn" aria-label="${delLabel}" onclick="TaskManager.deleteTask('${dateStr}',${id})"><span aria-hidden="true">✕</span></button>
                    </div>`;
                }).join('');
            }
        }

        const moodSection = document.getElementById('taskMoodSection');
        if (moodSection) moodSection.style.display = isToday ? '' : 'none';
        const moodLabel = document.getElementById('tasks-mood-label');
        if (moodLabel) moodLabel.textContent = diary.t('tasks-mood-label');

        const moodRow = document.getElementById('moodRow');
        if (moodRow && isToday) {
            const moods = [
                { key: 'great', icon: '😄', label: diary.t('tasks-mood-great') },
                { key: 'normal', icon: '🙂', label: diary.t('tasks-mood-normal') },
                { key: 'meh', icon: '😐', label: diary.t('tasks-mood-meh') },
                { key: 'hard', icon: '😞', label: diary.t('tasks-mood-hard') },
            ];
            const curMood = dayData.mood || '';
            moodRow.innerHTML = moods.map(m => `
                <button type="button" class="mood-btn ${curMood === m.key ? 'selected' : ''}" aria-pressed="${curMood === m.key}"
                        onclick="TaskManager.setMood('${dateStr}','${m.key}')">
                    <span class="mood-emoji" aria-hidden="true">${m.icon}</span><span class="mood-label">${m.label}</span>
                </button>`).join('');
        }

        const qaRow = document.getElementById('taskQuickAddRow');
        if (qaRow) qaRow.style.display = isToday ? '' : 'none';

        const carrySection = document.getElementById('taskCarryoverSection');
        if (carrySection && isToday) {
            const hasIncomplete = tasks.some(t => !t.completed);
            carrySection.style.display = hasIncomplete ? '' : 'none';
            const btn = document.getElementById('carryover-btn-txt');
            if (btn) btn.textContent = diary.t('tasks-carryover');
        } else if (carrySection) {
            carrySection.style.display = 'none';
        }
    },

    async viewDate(dateStr) {
        await this._loadDay(dateStr);
        this._viewDate = dateStr;
        const [y, m] = dateStr.split('-').map(Number);
        this._calYear = y; this._calMonth = m - 1;
        this.render();
    },

    // ---------- monthly calendar (replaces the old fixed 30-day scroller) ----------
    // Supports navigating to any past or future month/year. Day badges come
    // from `_summary` (task_index), which already holds {done,total} for
    // every non-pruned day — no extra loads needed just to draw the grid.
    calPrevMonth() {
        this._ensureCalDate();
        this._calMonth -= 1;
        if (this._calMonth < 0) { this._calMonth = 11; this._calYear -= 1; }
        this.render();
    },
    calNextMonth() {
        this._ensureCalDate();
        this._calMonth += 1;
        if (this._calMonth > 11) { this._calMonth = 0; this._calYear += 1; }
        this.render();
    },
    calToday() {
        this.viewDate(this.today());
    },
    _ensureCalDate() {
        if (this._calYear === null || this._calMonth === null) {
            const dateStr = this._viewDate || this.today();
            const [y, m] = dateStr.split('-').map(Number);
            this._calYear = y; this._calMonth = m - 1;
        }
    },
    _renderCalendar(selectedDateStr) {
        this._ensureCalDate();
        const lang = diary.lang || 'en';
        const year = this._calYear, month = this._calMonth;
        const today = this.today();

        const label = document.getElementById('taskCalMonthYearLabel');
        if (label) {
            const monthName = new Date(year, month, 1).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long', year: 'numeric' });
            label.textContent = monthName.charAt(0).toUpperCase() + monthName.slice(1);
        }
        const todayBtn = document.getElementById('taskCalTodayBtn');
        if (todayBtn) todayBtn.textContent = diary.t('tasks-cal-today-btn');

        const weekdaysEl = document.getElementById('taskCalWeekdays');
        if (weekdaysEl) {
            const dayLabels = lang === 'ru' ? ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'] : ['Mo','Tu','We','Th','Fr','Sa','Su'];
            weekdaysEl.innerHTML = dayLabels.map(d => `<div class="task-cal-weekday">${d}</div>`).join('');
        }

        const grid = document.getElementById('taskCalGrid');
        if (!grid) return;

        const firstOfMonth = new Date(year, month, 1);
        const offset = (firstOfMonth.getDay() + 6) % 7; // Monday-first grid
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        let html = '';
        for (let i = 0; i < offset; i++) html += '<div class="task-cal-day empty"></div>';
        for (let d = 1; d <= daysInMonth; d++) {
            const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const sum = this._summary[ds];
            const done = sum ? sum.done : 0;
            const total = sum ? sum.total : 0;
            const classes = ['task-cal-day'];
            if (ds === today) classes.push('is-today');
            if (ds === selectedDateStr) classes.push('selected');
            if (total > 0) classes.push(done >= total ? 'has-tasks-done' : 'has-tasks');
            const badge = total > 0 ? `<span class="task-cal-badge">${done}/${total}</span>` : '';
            html += `<button type="button" class="${classes.join(' ')}" aria-label="${ds}${total ? ' (' + done + '/' + total + ')' : ''}" aria-pressed="${ds === selectedDateStr}" onclick="TaskManager.viewDate('${ds}')">
                        <span class="task-cal-daynum">${d}</span>${badge}
                     </button>`;
        }
        grid.innerHTML = html;
    },

    // ---------- v8.1: real-time task search ----------
    // `query` is already trimmed + lower-cased by the caller. Matches the
    // task's own text first (the common case), then falls back to a small
    // set of localized status keywords so typing "done"/"important" (or
    // their Russian equivalents) filters by status too.
    _matchesTaskSearch(task, query) {
        if (!query) return true;
        if (task.text.toLowerCase().includes(query)) return true;

        const kw = (key) => (diary.t(key) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const fuzzyIncludes = (words) => words.some(w => w && (query.includes(w) || w.includes(query)));

        if (task.completed  && fuzzyIncludes(kw('tasks-search-kw-done')))      return true;
        if (!task.completed && fuzzyIncludes(kw('tasks-search-kw-pending')))   return true;
        if (task.important  && fuzzyIncludes(kw('tasks-search-kw-important'))) return true;
        return false;
    }
};



