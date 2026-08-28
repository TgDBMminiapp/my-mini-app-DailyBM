// ================================================================
//  ACHIEVEMENTS SYSTEM
//  FIX: earnedDate is saved permanently on first unlock only.
//  FIX: _loaded flag prevents recalculate() from running before
//       the persisted state is loaded — eliminating the race that
//       caused dates to reset and achievements to disappear.
//  FIX: _save() now retries on failure to prevent data loss.
// ================================================================
const AchievementsUI = {

    _strings: {
        en: {
            title: 'Achievements', progressLabel: 'Unlocked achievements',
            locked: 'Locked', earnedOn: 'Earned', unlockedToastPrefix: 'Achievement unlocked:',
            achs: [
                { id: 'first_note',      icon: '📝', title: 'First Note',            desc: 'Created your very first note' },
                { id: 'notes_10',        icon: '📚', title: '10 Notes Written',       desc: 'Wrote 10 notes in total' },
                { id: 'first_habit',     icon: '🔥', title: 'First Habit',            desc: 'Started tracking your first habit' },
                { id: 'streak_7',        icon: '⚡', title: '7-Day Streak',           desc: 'Used the app 7 days in a row' },
                { id: 'streak_30',       icon: '🌟', title: '30-Day Streak',          desc: 'Used the app 30 days in a row' },
                { id: 'tasks_5_day',     icon: '✅', title: 'Power Day',              desc: 'Completed 5 tasks in a single day' },
                { id: 'days_14',         icon: '📅', title: '14 Days Active',         desc: 'Used the planner for 14 days' },
                { id: 'profile_custom',  icon: '👤', title: 'Personalised',           desc: 'Customized your profile nickname' },
                { id: 'tasks_50',        icon: '🎯', title: 'Task Master',            desc: 'Completed 50 tasks in total' },
                { id: 'tasks_100',       icon: '🏆', title: 'Master Planner',         desc: 'Completed 100 tasks in total' },
                { id: 'first_task',      icon: '🌱', title: 'First Step',             desc: 'Added your very first daily task' },
                { id: 'tasks_3_streak',  icon: '🔁', title: '3-Day Task Streak',      desc: 'Completed at least one task for 3 days in a row' },
                { id: 'tasks_all_day',   icon: '💯', title: 'Perfect Day',            desc: 'Completed all tasks in a single day (min. 3 tasks)' },
            ]
        },
        ru: {
            title: 'Достижения', progressLabel: 'Разблокировано достижений',
            locked: 'Закрыто', earnedOn: 'Получено', unlockedToastPrefix: 'Достижение получено:',
            achs: [
                { id: 'first_note',      icon: '📝', title: 'Первая запись',          desc: 'Создал свою первую заметку' },
                { id: 'notes_10',        icon: '📚', title: '10 записей',             desc: 'Написал 10 заметок всего' },
                { id: 'first_habit',     icon: '🔥', title: 'Первая привычка',        desc: 'Начал отслеживать первую привычку' },
                { id: 'streak_7',        icon: '⚡', title: 'Серия 7 дней',           desc: 'Использовал приложение 7 дней подряд' },
                { id: 'streak_30',       icon: '🌟', title: 'Серия 30 дней',          desc: 'Использовал приложение 30 дней подряд' },
                { id: 'tasks_5_day',     icon: '✅', title: 'Ударный день',           desc: 'Выполнил 5 задач за один день' },
                { id: 'days_14',         icon: '📅', title: '14 дней активности',     desc: 'Использовал планнер 14 дней' },
                { id: 'profile_custom',  icon: '👤', title: 'Персонализация',         desc: 'Настроил никнейм профиля' },
                { id: 'tasks_50',        icon: '🎯', title: 'Мастер задач',           desc: 'Выполнил 50 задач всего' },
                { id: 'tasks_100',       icon: '🏆', title: 'Мастер планирования',    desc: 'Выполнил 100 задач всего' },
                { id: 'first_task',      icon: '🌱', title: 'Первый шаг',             desc: 'Добавил свою первую ежедневную задачу' },
                { id: 'tasks_3_streak',  icon: '🔁', title: 'Серия задач 3 дня',      desc: 'Выполнял хотя бы одну задачу 3 дня подряд' },
                { id: 'tasks_all_day',   icon: '💯', title: 'Идеальный день',         desc: 'Выполнил все задачи за день (мин. 3 задачи)' },
            ]
        }
    },

    // Persistent state: { [id]: { earned: bool, earnedDate: 'YYYY-MM-DD' } }
    // NEVER mutated until _loaded = true
    _state: {},
    _loaded: false,   // guard: do not recalculate until state is restored from storage

    init() {
        StorageManager.getItem('achievements_v1').then(raw => {
            try {
                const parsed = raw ? JSON.parse(raw) : {};
                // Merge: preserve any already-earned entries (safety net)
                const merged = {};
                const allIds = [
                    ...Object.keys(this._state),
                    ...Object.keys(parsed)
                ];
                for (const id of allIds) {
                    const existing = this._state[id];
                    const loaded   = parsed[id];
                    // Keep whichever source shows the achievement as earned
                    if (loaded && loaded.earned) {
                        merged[id] = loaded;
                    } else if (existing && existing.earned) {
                        merged[id] = existing;
                    }
                }
                this._state = merged;
            } catch(e) { /* keep current _state unchanged */ }
            this._loaded = true;
            this.recalculate();
        }).catch(() => {
            this._loaded = true;
            this.recalculate();
        });
    },

    _save() {
        // Persist achievements state — retry once on failure to prevent data loss
        const data = JSON.stringify(this._state);
        StorageManager.setItem('achievements_v1', data).catch(() => {
            setTimeout(() => StorageManager.setItem('achievements_v1', data).catch(() => {}), 1500);
        });
    },

    // ONLY sets earnedDate on FIRST unlock — never overwrites it
    _unlock(id) {
        if (this._state[id] && this._state[id].earned) return false; // already earned, preserve date
        const today = diary.today ? diary.today() : new Date().toISOString().split('T')[0];
        this._state[id] = { earned: true, earnedDate: today };
        (this._newlyUnlocked || (this._newlyUnlocked = [])).push(id);
        return true; // newly unlocked
    },

    // NEW: celebratory toast + burst animation the moment an achievement is
    // actually earned, instead of it only becoming visible next time the
    // achievements modal happens to be opened.
    _announceNewlyUnlocked() {
        const ids = this._newlyUnlocked || [];
        this._newlyUnlocked = [];
        if (!ids.length) return;
        const lang = diary.lang || 'en';
        const strs = this._strings[lang] || this._strings.en;
        ids.forEach((id, i) => {
            const ach = (strs.achs || []).find(a => a.id === id);
            if (!ach) return;
            setTimeout(() => {
                if (typeof diary.toast === 'function') {
                    diary.toast(`${ach.icon} ${(strs.unlockedToastPrefix || '')} ${ach.title}`.trim(), 'achievement');
                }
            }, i * 1600);
        });
    },

    recalculate() {
        // Guard: never run before persisted state is loaded (prevents date resets)
        if (!this._loaded) return;

        let changed = false;

        // 1. First note
        if ((diary.notes || []).length >= 1  && this._unlock('first_note'))   changed = true;
        // 2. 10 notes
        if ((diary.notes || []).length >= 10 && this._unlock('notes_10'))     changed = true;
        // 3. First habit
        if ((diary.habits || []).length >= 1 && this._unlock('first_habit'))  changed = true;
        // 4. 7-day streak
        if ((diary.fireStreak || 0) >= 7     && this._unlock('streak_7'))     changed = true;
        // 5. 30-day streak
        if ((diary.fireStreak || 0) >= 30    && this._unlock('streak_30'))    changed = true;

        // 6. 5 tasks completed in a single day
        // (FIX: previously scanned TaskManager._data directly, which only ever
        // held whatever days happened to be loaded. Now backed by a prune-safe
        // lifetime aggregate that's updated incrementally on every change.)
        const taskStats = TaskManager.getStats ? TaskManager.getStats() : {};
        const maxInDay = taskStats.maxCompletedInSingleDay || 0;
        if (maxInDay >= 5 && this._unlock('tasks_5_day')) changed = true;

        // 7. 14 distinct active days (habits + tasks).
        // Habit completedDays are never pruned, so that side stays exact.
        // Old task days DO get pruned for storage efficiency, so the exact
        // union is only guaranteed within the still-retained summary window;
        // outside that window we fall back to the lifetime task-active-days
        // counter (ignores overlap with habit days, so it's a slightly looser
        // bound — in practice this only matters for very sparse usage spread
        // past the retention window, since 14 active days is a low bar).
        const habitDaySet = new Set();
        (diary.habits || []).forEach(h => (h.completedDays || []).forEach(d => habitDaySet.add(d)));
        const unionWithinWindow = new Set(habitDaySet);
        Object.keys(TaskManager._summary || {}).forEach(d => {
            if (TaskManager._summary[d].done > 0) unionWithinWindow.add(d);
        });
        const days14 = unionWithinWindow.size >= 14 || habitDaySet.size >= 14 || (taskStats.activeDaysCount || 0) >= 14;
        if (days14 && this._unlock('days_14')) changed = true;

        // 8. Profile nickname set
        if (SidebarUI.profile && SidebarUI.profile.nickname && SidebarUI.profile.nickname.length > 0) {
            if (this._unlock('profile_custom')) changed = true;
        }

        // 9. 50 total completed tasks
        const totalCompleted = TaskManager.totalCompleted ? TaskManager.totalCompleted() : 0;
        if (totalCompleted >= 50  && this._unlock('tasks_50'))  changed = true;
        // 10. 100 total completed tasks
        if (totalCompleted >= 100 && this._unlock('tasks_100')) changed = true;

        // ── NEW TASK ACHIEVEMENTS ──

        // 11. First task ever added (lifetime counter, survives pruning)
        const totalTasks = TaskManager.totalTasks ? TaskManager.totalTasks() : 0;
        if (totalTasks >= 1 && this._unlock('first_task')) changed = true;

        // 12. 3-day task completion streak
        if ((TaskManager.completionStreak ? TaskManager.completionStreak() : 0) >= 3 &&
            this._unlock('tasks_3_streak')) changed = true;

        // 13. All tasks completed in a single day (at least 3 tasks)
        const hadPerfectDay = !!taskStats.hadPerfectDay;
        if (hadPerfectDay && this._unlock('tasks_all_day')) changed = true;

        if (changed) {
            this._save();
            const modal = document.getElementById('achievementsModal');
            if (modal && modal.classList.contains('open')) {
                this._render();
            }
            // FIX (micro-interaction): previously a newly-earned achievement was
            // silent unless the person happened to open the Achievements modal.
            // Now it's announced immediately with a toast.
            this._announceNewlyUnlocked();
        }
    },

    open() {
        this.recalculate();
        this._render();
        document.getElementById('achievementsModal').classList.add('open');
        document.getElementById('achievementsModal').scrollTop = 0;
    },

    close() {
        document.getElementById('achievementsModal').classList.remove('open');
    },

    applyTranslations(lang) {
        const strs = this._strings[lang] || this._strings.en;
        const el = document.getElementById('ach-modal-title');
        if (el) el.textContent = strs.title;
        const pl = document.getElementById('ach-progress-label');
        if (pl) pl.textContent = strs.progressLabel;
        if (document.getElementById('achievementsModal').classList.contains('open')) this._render();
    },

    _render() {
        const lang  = diary.lang || 'en';
        const strs  = this._strings[lang] || this._strings.en;
        const achs  = strs.achs;

        const unlockedCount = achs.filter(a => this._state[a.id] && this._state[a.id].earned).length;
        const pct = Math.round((unlockedCount / achs.length) * 100);

        const countEl = document.getElementById('ach-unlocked-count');
        const fillEl  = document.getElementById('ach-prog-fill');
        if (countEl) countEl.textContent = unlockedCount;
        if (fillEl)  fillEl.style.width  = pct + '%';

        const plEl = document.getElementById('ach-progress-label');
        if (plEl) plEl.textContent = strs.progressLabel;

        const grid = document.getElementById('achGrid');
        if (!grid) return;

        grid.innerHTML = achs.map((ach, i) => {
            const st       = this._state[ach.id];
            const unlocked = st && st.earned;
            const delay    = Math.min(i * 0.05, 0.35);

            let dateText = '';
            if (unlocked && st.earnedDate) {
                try {
                    dateText = strs.earnedOn + ': ' + new Date(st.earnedDate).toLocaleDateString(
                        lang === 'ru' ? 'ru-RU' : 'en-GB',
                        { day: 'numeric', month: 'short', year: 'numeric' }
                    );
                } catch(e) { dateText = strs.earnedOn; }
            } else {
                dateText = strs.locked;
            }

            return `
            <div class="ach-card ${unlocked ? 'unlocked' : 'locked'}" style="animation-delay:${delay}s">
                <div class="ach-icon-wrap">
                    <span>${ach.icon}</span>
                    ${!unlocked ? '<div class="ach-lock-overlay">🔒</div>' : ''}
                </div>
                <div class="ach-card-body">
                    <div class="ach-card-title">${ach.title}</div>
                    <div class="ach-card-desc">${ach.desc}</div>
                    <div class="ach-card-date">${dateText}</div>
                </div>
                <div class="ach-badge">${unlocked ? '⭐' : '—'}</div>
            </div>`;
        }).join('');
    }
};


