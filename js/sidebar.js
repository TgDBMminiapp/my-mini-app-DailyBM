// ================================================================
//  SIDEBAR UI CONTROLLER
// ================================================================
const SidebarUI = {
    _strings: {
        en: {
            nickname: 'Nickname', menu: 'Menu', privacy: 'Privacy',
            achievements: 'Achievements', deleteAccount: 'Delete account & all data',
            saveNick: 'Save nickname', nickPlaceholder: 'Set your nickname...',
            nickSaved: 'Nickname saved ✅',
            delTitle: 'Delete all data?',
            delDesc: 'This will permanently erase all your notes, habits, memories, and profile data. This action cannot be undone.',
            delCancel: 'Cancel', delConfirm: 'Delete everything', defaultUser: 'User',
        },
        ru: {
            nickname: 'Никнейм', menu: 'Меню', privacy: 'Конфиденциальность',
            achievements: 'Достижения', deleteAccount: 'Удалить аккаунт и все данные',
            saveNick: 'Сохранить никнейм', nickPlaceholder: 'Введи никнейм...',
            nickSaved: 'Никнейм сохранён ✅',
            delTitle: 'Удалить все данные?',
            delDesc: 'Это навсегда уничтожит все твои записи, привычки, воспоминания и данные профиля. Действие нельзя отменить.',
            delCancel: 'Отмена', delConfirm: 'Удалить всё', defaultUser: 'Пользователь',
        }
    },

    profile: { name: '', userId: '', photoUrl: '', nickname: '' },

    init() {
        try {
            if (window.Telegram && Telegram.WebApp && Telegram.WebApp.initDataUnsafe) {
                const u = Telegram.WebApp.initDataUnsafe.user;
                if (u) {
                    this.profile.name     = [u.first_name, u.last_name].filter(Boolean).join(' ') || '';
                    this.profile.userId   = String(u.id || '');
                    this.profile.photoUrl = u.photo_url || '';
                }
            }
        } catch(e) {}

        StorageManager.getItem('userNickname').then(nick => {
            if (nick) { this.profile.nickname = nick; this._updateHeaderDisplay(); }
        }).catch(() => {});

        StorageManager.getItem('userId').then(uid => {
            if (uid && !this.profile.userId) this.profile.userId = uid;
            this._updateHeaderDisplay();
        }).catch(() => {});

        this._updateHeaderDisplay();
        this.applyTranslations(diary.lang || 'en');
    },

    _updateHeaderDisplay() {
        const lang   = diary.lang || 'en';
        const strs   = this._strings[lang] || this._strings.en;
        const name   = this.profile.nickname || this.profile.name || strs.defaultUser;
        const uid    = this.profile.userId || '—';

        const set = (id, v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
        set('sidebarUsername', name);
        set('sidebarUserid',  'ID: ' + uid);
        const elNick = document.getElementById('sidebarNickInput');
        if (elNick) elNick.value = this.profile.nickname || '';

        const elAva = document.getElementById('sidebarAvatar');
        if (elAva) {
            if (this.profile.photoUrl) {
                elAva.innerHTML = `<img src="${this.profile.photoUrl}" alt="avatar" onerror="this.parentElement.textContent='👤'">`;
            } else if (name && name !== strs.defaultUser) {
                const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                elAva.innerHTML = `<span style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:white">${initials}</span>`;
            } else {
                elAva.textContent = '👤';
            }
        }
    },

    applyTranslations(lang) {
        const strs = this._strings[lang] || this._strings.en;
        const set  = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };
        const setPh= (id, txt) => { const el = document.getElementById(id); if(el) el.placeholder = txt; };
        set('sb-lbl-nickname',     strs.nickname);
        set('sb-lbl-menu',         strs.menu);
        set('sb-lbl-danger',       strs.privacy);
        set('sb-item-achievements',strs.achievements);
        set('sb-item-delete',      strs.deleteAccount);
        set('sidebarSaveNickBtn',  strs.saveNick);
        set('del-modal-title',     strs.delTitle);
        set('del-modal-desc',      strs.delDesc);
        set('del-cancel-btn',      strs.delCancel);
        set('del-confirm-btn',     strs.delConfirm);
        set('ach-modal-title', AchievementsUI._strings[lang]?.title || 'Achievements');
        setPh('sidebarNickInput',  strs.nickPlaceholder);
        this._updateHeaderDisplay();
    },

    open() {
        document.getElementById('sidebarBackdrop').classList.add('open');
        document.getElementById('sidebarPanel').classList.add('open');
        this._updateHeaderDisplay();
    },

    close() {
        document.getElementById('sidebarBackdrop').classList.remove('open');
        document.getElementById('sidebarPanel').classList.remove('open');
    },

    saveNickname() {
        const input = document.getElementById('sidebarNickInput');
        if (!input) return;
        const nick = input.value.trim();
        this.profile.nickname = nick;
        StorageManager.setItem('userNickname', nick).catch(() => {});
        this._updateHeaderDisplay();
        diary.toast((this._strings[diary.lang] || this._strings.en).nickSaved);
        AchievementsUI.recalculate(); // profile_custom achievement
    },

    confirmDeleteAccount() {
        this.close();
        setTimeout(() => { document.getElementById('deleteAccountModal').classList.add('open'); }, 320);
    },

    cancelDeleteAccount() {
        document.getElementById('deleteAccountModal').classList.remove('open');
    },

    async executeDeleteAccount() {
        const btn = document.getElementById('del-confirm-btn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        try {
            diary.notes = []; diary.habits = []; diary.memories = [];
            diary.fireStreak = 0; diary.lastActiveDate = '';

            // FIX: v5 wrote '' over each key instead of actually removing it,
            // which left every shard sitting in CloudStorage forever, slowly
            // eating the 1024-key-per-account budget. Properly remove
            // everything instead — including every sharded notes/habits/
            // memories/tasks key, not just the legacy monolithic ones.
            await Promise.all([
                StorageManager.wipeCollection('notes'),
                StorageManager.wipeCollection('habits'),
                StorageManager.wipeCollection('memories'),
                TaskManager.wipeAll(),
            ]);
            for (const key of ['fireStreak', 'lastActiveDate', 'userNickname', 'userId', 'achievements_v1']) {
                await StorageManager.removeItem(key);
            }
            // NOTE: deliberately NOT touching dbmix_sentinel / enc_mk_recovery /
            // recovery_salt / SecureStorage mk — "delete account" erases your
            // DATA, not your encryption identity. Your existing recovery code
            // keeps working against this now-empty vault.

            this.profile.nickname = '';
            this._updateHeaderDisplay();

            diary.renderAll();
            diary.updateFooter();
            TaskManager.render();
            AchievementsUI._state = {};
            AchievementsUI._save();

            document.getElementById('deleteAccountModal').classList.remove('open');
            diary.toast(diary.t('toast-all-data-deleted'));
        } catch (e) {
            console.error('[SidebarUI] executeDeleteAccount failed:', e);
            diary.toast(diary.t('err-delete-account'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = (this._strings[diary.lang] || this._strings.en).delConfirm; }
        }
    },

    openAchievements() {
        this.close();
        setTimeout(() => { AchievementsUI.open(); }, 300);
    },

    // ---------- Backup & Recovery: regenerate a fresh recovery code on demand ----------
    openRecoveryModal() {
        this.close();
        setTimeout(() => {
            const disp = document.getElementById('recoveryModalCode');
            if (disp) disp.textContent = '••••-••••-••••-••••-••••';
            document.getElementById('recoveryModal').classList.add('open');
        }, 300);
    },
    closeRecoveryModal() {
        document.getElementById('recoveryModal').classList.remove('open');
    },
    async generateNewRecoveryCode() {
        const lang = diary.lang || 'en';
        const msg = lang === 'ru'
            ? 'Это заменит твой текущий код восстановления — старый перестанет работать на новых устройствах. Продолжить?'
            : 'This replaces your current recovery code — the old one will stop working for setting up new devices. Continue?';
        if (!confirm(msg)) return;
        const btn = document.getElementById('recoveryModalGenerateBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
        const code = await EncryptionManager.regenerateRecoveryCode();
        if (btn) { btn.disabled = false; btn.textContent = lang === 'ru' ? 'Создать новый код' : 'Generate new code'; }
        const disp = document.getElementById('recoveryModalCode');
        if (code) {
            if (disp) disp.textContent = code;
            diary.toast(lang === 'ru' ? '✅ Новый код создан — сохрани его' : '✅ New code created — save it now');
        } else {
            diary.toast(diary.t('err-recovery-code'), 'error');
        }
    }
};


