// @ts-check
// ================================================================
//  TASK MANAGER v6 — Daily Tasks
//
//  WHAT CHANGED FROM v5 AND WHY (this tab had the worst bugs):
//   1. v5 stored EVERY day you'd ever used the app in one ever-
//      growing object, serialized whole and re-uploaded on every
//      single checkbox tap. Once that blob crossed CloudStorage's
//      per-value cap, every future save started silently failing —
//      "I check a task and it un-checks itself a moment later" was
//      this bug. v6 stores one small shard per DAY (`task_day_X`),
//      so a single save only ever touches the day that changed.
//   2. v5 computed "today" with `toISOString()`, which is UTC — so
//      for anyone not in UTC, tasks/streaks/mood got filed under the
//      wrong calendar day for hours around their local midnight.
//      v6 uses `Util.localDateStr()` everywhere.
//   3. v5 never pruned old days, so storage grew forever. v6 keeps a
//      rolling window of raw day-shards (`_retentionDays`) and tracks
//      lifetime achievement stats in a small separate aggregate
//      (`task_stats`) that's updated incrementally on every change —
//      so pruning old days never loses streaks/totals/achievements.
//   4. The 30-day archive scroller used to require every day to be
//      loaded into memory. It now reads from a tiny per-day summary
//      index (`task_index`, just {done,total} per date) so opening
//      the app only ever fetches *today's* shard, not 30 of them.
// ================================================================
const TaskManager = {
    _data: {},          // cache of LOADED day objects: { 'YYYY-MM-DD': {tasks, mood, countedActive, countedPerfect} }
    _summary: {},        // lightweight {done,total} per date, drives the archive scroller without loading full days
    _stats: {
        totalCompletedAllTime: 0, totalTasksAddedAllTime: 0, maxCompletedInSingleDay: 0,
        activeDaysCount: 0, hadPerfectDay: false, currentStreak: 0, longestStreak: 0, lastStreakDate: ''
    },
    _viewDate: null,
    _calCursor: null,   // Date at the 1st of the month currently shown in the archive calendar
    _newTaskImp: false,
    _retentionDays: 120, // raw day-shards older than this get pruned; lifetime stats are unaffected

    today() { return Util.localDateStr(); },
    dateOf(daysAgo) { return Util.addDays(this.today(), -daysAgo); },

    // ---------- loading / migration ----------
    async load() {
        const [summaryRaw, statsRaw] = await Promise.all([
            StorageManager.getItem('task_index'),
            StorageManager.getItem('task_stats'),
        ]);
        try { this._summary = summaryRaw ? JSON.parse(summaryRaw) : {}; } catch (e) { this._summary = {}; }
        try { this._stats = statsRaw ? JSON.parse(statsRaw) : this._stats; } catch (e) {}

        if (summaryRaw === null) await this._migrateFromLegacyBlob();

        await this._loadDay(this.today());
        this._prune().catch(() => {}); // best-effort, never blocks the UI
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
            this._data[ds] = day;
            this._recomputeSummaryFor(ds);
            this._bumpAchievementFlags(ds);
            await StorageManager.setItem('task_day_' + ds, JSON.stringify(day));
        }
        await StorageManager.setItem('task_index', JSON.stringify(this._summary));
        await StorageManager.setItem('task_stats', JSON.stringify(this._stats));
        await StorageManager.removeItem('tasks_v1');
    },

    async _loadDay(dateStr) {
        if (this._data[dateStr]) return this._data[dateStr];
        const raw = await StorageManager.getItem('task_day_' + dateStr);
        let day;
        try { day = raw ? JSON.parse(raw) : null; } catch (e) { day = null; }
        if (!day) day = { tasks: [], mood: '', countedActive: false, countedPerfect: false };
        this._data[dateStr] = day;
        return day;
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
        stale.forEach(d => { delete this._summary[d]; delete this._data[d]; });
        await StorageManager.setItem('task_index', JSON.stringify(this._summary));
    },

    async wipeAll() {
        const dates = Object.keys(this._summary);
        await Promise.all(dates.map(d => StorageManager.removeItem('task_day_' + d)));
        await StorageManager.removeItem('task_index');
        await StorageManager.removeItem('task_stats');
        await StorageManager.removeItem('tasks_v1');
        this._data = {}; this._summary = {};
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
        if (btn) btn.classList.toggle('active', this._newTaskImp);
    },

    async quickAdd() {
        const input = document.getElementById('taskQuickInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;

        const addBtn = document.getElementById('taskAddBtn');
        if (addBtn) addBtn.disabled = true;

        const dateStr = this._viewDate || this.today();
        const snap = this._snapshotFor(dateStr);
        const day = this.dayData(dateStr);

        const newTask = {
            id: Date.now(), text, important: this._newTaskImp, completed: false,
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
            diary.toast(diary.t('tasks-toast-added'));
            AchievementsUI.recalculate();
        } catch (e) {
            this._restoreSnapshot(dateStr, snap);
            input.value = text;
            this.render();
            diary.toast(diary.t('err-task-save'), 'error');
            console.error('[TaskManager] quickAdd save failed:', e);
        } finally {
            if (addBtn) addBtn.disabled = false;
        }
    },

    onInputKeydown(e) {
        if (e.key === 'Enter') { e.preventDefault(); this.quickAdd(); }
    },

    async toggleTask(dateStr, taskId) {
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
            AchievementsUI.recalculate();
        } catch (e) {
            this._restoreSnapshot(dateStr, snap);
            this.render();
            diary.toast(diary.t('err-save'), 'error');
        }
    },

    async deleteTask(dateStr, taskId) {
        const day = this.dayData(dateStr);
        const removed = day.tasks.find(t => t.id === taskId);
        const snap = this._snapshotFor(dateStr);
        day.tasks = day.tasks.filter(t => t.id !== taskId);
        if (removed && removed.completed) this._stats.totalCompletedAllTime = Math.max(0, this._stats.totalCompletedAllTime - 1);
        this._recomputeSummaryFor(dateStr);
        this.render();
        try {
            await this._persistDay(dateStr);
            diary.toast(diary.t('tasks-toast-deleted'));
        } catch (e) {
            this._restoreSnapshot(dateStr, snap);
            this.render();
            diary.toast(diary.t('err-delete'), 'error');
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
        const day = this.dayData(dateStr);
        const prevMood = day.mood;
        day.mood = (day.mood === mood) ? '' : mood;
        this.render();
        try {
            await this._persistDay(dateStr);
        } catch (e) {
            day.mood = prevMood;
            this.render();
            diary.toast(diary.t('err-mood-save'), 'error');
        }
    },

    async carryOver() {
        const todayStr = this.today();
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
            diary.toast(diary.t('err-carryover'), 'error');
        }
    },

    // ---------- stats surface used by the footer + AchievementsUI ----------
    completionStreak() { return this._stats.currentStreak; },
    totalCompleted() { return this._stats.totalCompletedAllTime; },
    todayCompleted() {
        const day = this._data[this.today()];
        return day ? day.tasks.filter(t => t.completed).length : 0;
    },
    totalTasks() { return this._stats.totalTasksAddedAllTime; },
    getStats() { return { ...this._stats }; },

    // ---------- rendering (same markup/behavior as v5) ----------
    render() {
        const lang = diary.lang || 'en';
        const dateStr = this._viewDate || this.today();
        const today = this.today();
        const isToday = (dateStr === today);

        const inp = document.getElementById('taskQuickInput');
        if (inp) inp.placeholder = diary.t('tasks-quick-ph');

        this._syncCalCursor(dateStr);
        this._renderMonthCal(lang, dateStr, today);

        const statsBar = document.getElementById('taskStatsBar');
        if (statsBar) {
            const sum = this._summary[dateStr] || { done: 0, total: 0 };
            const streak = this.completionStreak();
            statsBar.innerHTML = `
                <div class="task-stat-chip">✅ <b>${sum.done}</b> ${diary.t('tasks-stat-done')}</div>
                <div class="task-stat-chip">📋 <b>${sum.total}</b> ${diary.t('tasks-stat-total')}</div>
                <div class="task-stat-chip">🔥 <b>${streak}</b> ${diary.t('tasks-stat-streak-days')} ${diary.t('tasks-stat-streak')}</div>
            `;
        }

        const list = document.getElementById('tasksList');
        const dayData = this.dayData(dateStr);
        const tasks = dayData.tasks;

        if (list) {
            if (!tasks.length) {
                list.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><p>${diary.t('tasks-empty')}</p></div>`;
            } else {
                list.innerHTML = tasks.map((task, i) => {
                    const delay = Math.min(i * 0.03, 0.2);
                    return `
                    <div class="task-item ${task.important ? 'important' : ''} ${task.completed ? 'completed' : ''}"
                         style="animation-delay:${delay}s">
                        <div class="task-check" onclick="TaskManager.toggleTask('${dateStr}',${task.id})">
                            <span class="task-check-inner">✓</span>
                        </div>
                        <span class="task-text">${this._escHtml(task.text)}</span>
                        ${task.important ? '<span class="task-star">⭐</span>' : ''}
                        <button class="task-del-btn" onclick="TaskManager.deleteTask('${dateStr}',${task.id})">✕</button>
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
                <button class="mood-btn ${curMood === m.key ? 'selected' : ''}"
                        onclick="TaskManager.setMood('${dateStr}','${m.key}')">
                    ${m.icon}<span class="mood-label">${m.label}</span>
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
        this._calCursor = new Date(y, m - 1, 1);
        this.render();
    },

    _syncCalCursor(dateStr) {
        if (this._calCursor) return;
        const [y, m] = (dateStr || this.today()).split('-').map(Number);
        this._calCursor = new Date(y, m - 1, 1);
    },

    shiftCalendar(deltaMonths) {
        this._syncCalCursor(this._viewDate || this.today());
        this._calCursor.setMonth(this._calCursor.getMonth() + deltaMonths);
        this.render();
    },

    onMonthInput(ym) {
        if (!ym || ym.length < 7) return;
        const [y, m] = ym.split('-').map(Number);
        this._calCursor = new Date(y, m - 1, 1);
        this.render();
    },

    goToday() {
        this._calCursor = null;
        this.viewDate(this.today());
    },

    _renderMonthCal(lang, selectedStr, todayStr) {
        const host = document.getElementById('taskMonthCal');
        if (!host) return;
        const cursor = this._calCursor;
        const year = cursor.getFullYear();
        const month = cursor.getMonth();
        const locale = lang === 'ru' ? 'ru-RU' : 'en-GB';
        const label = cursor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
        const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
        const dayLabels = lang === 'ru' ? ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'] : ['Mo','Tu','We','Th','Fr','Sa','Su'];

        const first = new Date(year, month, 1);
        const startOffset = (first.getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevDays = new Date(year, month, 0).getDate();

        let cells = '';
        for (let i = 0; i < startOffset; i++) {
            const d = prevDays - startOffset + i + 1;
            const ds = Util.localDateStr(new Date(year, month - 1, d));
            cells += this._calDayCell(ds, d, selectedStr, todayStr, true);
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const ds = Util.localDateStr(new Date(year, month, d));
            cells += this._calDayCell(ds, d, selectedStr, todayStr, false);
        }
        const used = startOffset + daysInMonth;
        const extra = (7 - (used % 7)) % 7;
        for (let d = 1; d <= extra; d++) {
            const ds = Util.localDateStr(new Date(year, month + 1, d));
            cells += this._calDayCell(ds, d, selectedStr, todayStr, true);
        }

        host.innerHTML = `
            <div class="month-cal-nav">
                <button type="button" class="cal-nav-btn" onclick="TaskManager.shiftCalendar(-12)" aria-label="Previous year">«</button>
                <button type="button" class="cal-nav-btn" onclick="TaskManager.shiftCalendar(-1)" aria-label="Previous month">‹</button>
                <label class="cal-nav-label">
                    <span>${label}</span>
                    <input type="month" value="${ym}" onchange="TaskManager.onMonthInput(this.value)" aria-label="${label}">
                </label>
                <button type="button" class="cal-nav-btn" onclick="TaskManager.shiftCalendar(1)" aria-label="Next month">›</button>
                <button type="button" class="cal-nav-btn" onclick="TaskManager.shiftCalendar(12)" aria-label="Next year">»</button>
            </div>
            <button type="button" class="cal-today-btn" onclick="TaskManager.goToday()">${diary.t('cal-today')}</button>
            <div class="month-cal-weekdays">${dayLabels.map(d => `<span>${d}</span>`).join('')}</div>
            <div class="month-cal-grid">${cells}</div>
        `;
    },

    _calDayCell(ds, dayNum, selectedStr, todayStr, muted) {
        const sum = this._summary[ds];
        const tot = sum ? sum.total : 0;
        const cnt = sum ? sum.done : 0;
        const cls = [
            'cal-day',
            muted ? 'muted' : '',
            ds === selectedStr ? 'selected' : '',
            ds === todayStr ? 'today' : '',
            tot > 0 ? 'has-tasks' : '',
            tot > 0 && cnt === tot ? 'all-done' : '',
        ].filter(Boolean).join(' ');
        const badge = tot > 0 ? `<span class="cal-day-badge">${cnt}/${tot}</span>` : '';
        return `<button type="button" class="${cls}" onclick="TaskManager.viewDate('${ds}')"><span class="cal-day-num">${dayNum}</span>${badge}</button>`;
    },

    _escHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
};



