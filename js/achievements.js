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
            // v9.0: Custom (user-created) achievements — kept in the same
            // per-language strings object as everything else in this file.
            customSectionTitle: 'My Achievements',
            customSectionHint: 'Your own achievements — mark them done yourself, whenever you feel like it.',
            customAddBtn: '+ Add achievement',
            customEmpty: 'No custom achievements yet. Create your own above!',
            customFormTitleNew: 'New achievement',
            customFormTitleEdit: 'Edit achievement',
            lblIcon: 'Icon (emoji)',
            iconPh: '🏅',
            lblTitle: 'Title',
            titlePh: 'e.g. Ran my first 5K',
            lblDesc: 'Description (optional)',
            descPh: 'Say a bit more about it...',
            saveCustomBtn: 'Save achievement',
            markComplete: '✅ Mark as completed',
            markIncomplete: '↩️ Mark as not completed',
            confirmDeleteCustom: 'Delete this achievement? This cannot be undone.',
            customSavedToast: 'Achievement saved ✅',
            customDeletedToast: 'Achievement deleted',
            customUnlockedPrefix: 'Achievement unlocked:',
            customBadgeLabel: 'Custom',
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
            // v9.0: Пользовательские достижения
            customSectionTitle: 'Мои достижения',
            customSectionHint: 'Твои собственные достижения — отмечай их выполненными сам(а), когда захочешь.',
            customAddBtn: '+ Добавить достижение',
            customEmpty: 'Пока нет своих достижений. Создай своё выше!',
            customFormTitleNew: 'Новое достижение',
            customFormTitleEdit: 'Изменить достижение',
            lblIcon: 'Иконка (эмодзи)',
            iconPh: '🏅',
            lblTitle: 'Название',
            titlePh: 'например: Пробежал(а) первые 5 км',
            lblDesc: 'Описание (необязательно)',
            descPh: 'Расскажи немного подробнее...',
            saveCustomBtn: 'Сохранить достижение',
            markComplete: '✅ Отметить выполненным',
            markIncomplete: '↩️ Снять отметку',
            confirmDeleteCustom: 'Удалить это достижение? Действие нельзя отменить.',
            customSavedToast: 'Достижение сохранено ✅',
            customDeletedToast: 'Достижение удалено',
            customUnlockedPrefix: 'Достижение получено:',
            customBadgeLabel: 'Своё',
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

    // v9.0: Custom (user-created) achievements — a completely separate list,
    // under its own dedicated storage key, from the built-in system
    // achievements above. Each entry: { id, icon, title, desc, completed,
    // earnedDate, createdAt }. Never touched by recalculate()/_unlock()/
    // _state, and never merged into achievements_v1.
    _custom: [],
    _customLoaded: false,

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

        this._initCustom();
    },

    // ---------- v9.0: Custom achievements — load / save ----------
    _initCustom() {
        StorageManager.getItem('custom_achievements_v1').then(raw => {
            try {
                this._custom = raw ? JSON.parse(raw) : [];
                if (!Array.isArray(this._custom)) this._custom = [];
            } catch (e) { this._custom = []; }
            this._customLoaded = true;
            if (document.getElementById('achievementsModal').classList.contains('open')) this._renderCustom();
        }).catch(() => { this._customLoaded = true; });
    },

    _saveCustom() {
        const data = JSON.stringify(this._custom);
        StorageManager.setItem('custom_achievements_v1', data).catch(() => {
            // Retry once, same durability pattern as system achievements' _save().
            setTimeout(() => StorageManager.setItem('custom_achievements_v1', data).catch(() => {}), 1500);
        });
    },

    _customStrings() {
        return this._strings[diary.lang] || this._strings.en;
    },

    // Opens the create/edit form. Pass an id to edit an existing custom
    // achievement, or omit it to create a new one.
    openCustomForm(id) {
        const strs = this._customStrings();
        const editing = id != null ? this._custom.find(a => a.id === id) : null;
        document.getElementById('customAchId').value          = editing ? editing.id : '';
        document.getElementById('customAchIcon').value        = editing ? editing.icon  : '';
        document.getElementById('customAchTitle').value       = editing ? editing.title : '';
        document.getElementById('customAchDesc').value        = editing ? (editing.desc || '') : '';
        document.getElementById('customAchFormTitle').textContent = editing ? strs.customFormTitleEdit : strs.customFormTitleNew;
        const delBtn = document.getElementById('customAchDeleteBtn');
        if (delBtn) delBtn.style.display = editing ? '' : 'none';
        document.getElementById('customAchModal').classList.add('open');
        setTimeout(() => { const el = document.getElementById('customAchIcon'); if (el) el.focus(); }, 50);
    },

    closeCustomForm() {
        document.getElementById('customAchModal').classList.remove('open');
    },

    saveCustomForm(e) {
        if (e) e.preventDefault();
        const idRaw = document.getElementById('customAchId').value;
        const icon  = document.getElementById('customAchIcon').value.trim();
        const title = document.getElementById('customAchTitle').value.trim();
        const desc  = document.getElementById('customAchDesc').value.trim();

        // Icon + title are required (description is optional, per spec); this
        // mirrors the same validation pattern used by notes/habits/memories.
        if (!icon || !title) { diary.toast(diary.t('toast-fill-fields'), 'error'); return; }

        if (idRaw) {
            const id = +idRaw;
            const existing = this._custom.find(a => a.id === id);
            if (existing) { existing.icon = icon; existing.title = title; existing.desc = desc; }
        } else {
            this._custom.unshift({
                id: Date.now(), icon, title, desc,
                completed: false, earnedDate: null,
                createdAt: diary.today ? diary.today() : Util.localDateStr(),
            });
        }
        this._saveCustom();
        this._renderCustom();
        this.closeCustomForm();
        diary.toast(this._customStrings().customSavedToast);
    },

    deleteCustom(id, e) {
        if (e) e.stopPropagation();
        if (!confirm(this._customStrings().confirmDeleteCustom)) return;
        this._custom = this._custom.filter(a => a.id !== id);
        this._saveCustom();
        this._renderCustom();
        diary.toast(this._customStrings().customDeletedToast);
    },

    // Delete button inside the edit form itself — only closes the form if the
    // deletion was actually confirmed (deleteCustom() returns silently if the
    // person cancels the confirm() dialog, leaving the form open).
    deleteCustomFromForm() {
        const idRaw = document.getElementById('customAchId').value;
        if (!idRaw) return;
        const id = +idRaw;
        const before = this._custom.length;
        this.deleteCustom(id);
        if (this._custom.length < before) this.closeCustomForm();
    },

    // Users mark their own custom achievements complete/incomplete manually —
    // there is no automatic progress tracking for these, by design (spec).
    // earnedDate is set only the FIRST time an achievement is completed and
    // is preserved across any later toggle off/on, mirroring how system
    // achievements never overwrite an already-recorded earnedDate.
    toggleCustomComplete(id, e) {
        if (e) e.stopPropagation();
        const ach = this._custom.find(a => a.id === id);
        if (!ach) return;
        const wasCompleted = !!ach.completed;
        ach.completed = !wasCompleted;
        if (ach.completed && !ach.earnedDate) {
            ach.earnedDate = diary.today ? diary.today() : Util.localDateStr();
        }
        this._saveCustom();
        this._renderCustom();
        if (!wasCompleted && ach.completed) this._announceCustomUnlock(ach);
    },

    // Celebratory toast for a custom achievement, matching the look/feel of
    // the system achievements' unlock toast (same 'achievement' toast style).
    _announceCustomUnlock(ach) {
        const strs = this._customStrings();
        // NOTE: diary.toast() sets textContent (not innerHTML), so the title
        // is used as-is here — no HTML escaping needed/wanted for a toast.
        diary.toast(`${ach.icon} ${strs.customUnlockedPrefix} ${ach.title}`.trim(), 'achievement');
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
        // v9.0 FIX: the fallback here used `new Date().toISOString()`, which is
        // UTC — the exact class of bug the rest of the app deliberately avoids
        // (see Util.localDateStr's comment). diary.today() is always available
        // in practice, but if it somehow isn't, fall back to the same LOCAL
        // date logic instead of a UTC one so an achievement earned right
        // around local midnight doesn't get filed under the wrong day.
        const today = diary.today ? diary.today() : (typeof Util !== 'undefined' ? Util.localDateStr() : new Date().toISOString().split('T')[0]);
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
        this._renderCustom();
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
        // v9.0: custom achievements section + its create/edit form.
        const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
        const setPh = (id, txt) => { const e = document.getElementById(id); if (e) e.placeholder = txt; };
        set('ach-custom-section-title', strs.customSectionTitle);
        set('ach-custom-section-hint',  strs.customSectionHint);
        set('customAchAddBtnTxt',       strs.customAddBtn);
        set('lbl-custom-ach-icon',      strs.lblIcon);
        set('lbl-custom-ach-title',     strs.lblTitle);
        set('lbl-custom-ach-desc',      strs.lblDesc);
        set('customAchSaveBtnTxt',      strs.saveCustomBtn);
        set('customAchCancelBtnTxt',    diary.t('lbl-cancel'));
        set('customAchDeleteBtnTxt',    diary.t('lbl-delete'));
        setPh('customAchIcon',  strs.iconPh);
        setPh('customAchTitle', strs.titlePh);
        setPh('customAchDesc',  strs.descPh);
        const formTitleEl = document.getElementById('customAchFormTitle');
        if (formTitleEl) formTitleEl.textContent = document.getElementById('customAchId').value ? strs.customFormTitleEdit : strs.customFormTitleNew;
        if (document.getElementById('achievementsModal').classList.contains('open')) { this._render(); this._renderCustom(); }
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
                    // v9.0 FIX: `new Date('YYYY-MM-DD')` parses as UTC midnight while
                    // toLocaleDateString() reads it back in LOCAL time — for anyone
                    // west of UTC this could silently display the day BEFORE the one
                    // actually recorded. Same bug class Util.parseLocalDate already
                    // exists to prevent elsewhere in the app; use it here too.
                    const earnedDateObj = (typeof Util !== 'undefined') ? Util.parseLocalDate(st.earnedDate) : new Date(st.earnedDate);
                    dateText = strs.earnedOn + ': ' + earnedDateObj.toLocaleDateString(
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
    },

    // ---------- v9.0: Custom achievements — rendering ----------
    // Rendered into its own grid (#customAchGrid), completely separate from
    // the system achievements grid above — different data, different empty
    // state, different card styling (`.ach-card.custom`) so the two are
    // visually distinguishable at a glance, per spec.
    _renderCustom() {
        const strs = this._customStrings();
        const grid = document.getElementById('customAchGrid');
        if (!grid) return; // markup not present in this build — no-op

        const emptyEl = document.getElementById('customAchEmpty');
        if (!this._custom.length) {
            grid.innerHTML = '';
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = strs.customEmpty; }
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        grid.innerHTML = this._custom.map((ach, i) => {
            const delay = Math.min(i * 0.05, 0.35);
            const unlocked = !!ach.completed;

            let dateText = strs.locked;
            if (unlocked && ach.earnedDate) {
                try {
                    const d = Util.parseLocalDate(ach.earnedDate);
                    dateText = strs.earnedOn + ': ' + d.toLocaleDateString(
                        (diary.lang === 'ru') ? 'ru-RU' : 'en-GB',
                        { day: 'numeric', month: 'short', year: 'numeric' }
                    );
                } catch (e) { dateText = strs.earnedOn; }
            }

            // Icon/title/desc are free user text — always escaped before
            // going into innerHTML (see Util.escHtml).
            const icon  = Util.escHtml(ach.icon);
            const title = Util.escHtml(ach.title);
            const desc  = ach.desc ? Util.escHtml(ach.desc) : '';

            return `
            <div class="ach-card custom ${unlocked ? 'unlocked' : 'locked'}" style="animation-delay:${delay}s">
                <div class="ach-icon-wrap custom-icon">
                    <span>${icon}</span>
                    ${!unlocked ? '<div class="ach-lock-overlay">🔒</div>' : ''}
                </div>
                <div class="ach-card-body">
                    <div class="ach-card-title">${title}</div>
                    ${desc ? `<div class="ach-card-desc">${desc}</div>` : ''}
                    <div class="ach-card-date">${dateText}</div>
                    <div class="ach-custom-actions">
                        <button class="ach-custom-btn" onclick="AchievementsUI.toggleCustomComplete(${ach.id},event)">${unlocked ? strs.markIncomplete : strs.markComplete}</button>
                        <button class="ach-custom-btn icon-only" title="${diary.t('lbl-edit')}" onclick="AchievementsUI.openCustomForm(${ach.id})">✏️</button>
                        <button class="ach-custom-btn icon-only danger" title="${diary.t('lbl-delete')}" onclick="AchievementsUI.deleteCustom(${ach.id},event)">🗑️</button>
                    </div>
                </div>
                <div class="ach-badge custom-badge" title="${strs.customBadgeLabel}">${unlocked ? '⭐' : '—'}</div>
            </div>`;
        }).join('');
    }
};


