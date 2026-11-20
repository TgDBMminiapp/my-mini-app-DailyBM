# DailyBookimix — changelog

## v10.0 — audit, stability and redesign
Fixes
- Event listeners were attached again every time `diary.init()` re-ran (retry, "start fresh"), so one tap could save a note twice. Listeners are now attached once; data is reloaded on every init.
- `Util.b64encode` spread the whole buffer into `String.fromCharCode(...)`, which throws "Maximum call stack size exceeded" for large payloads (JavaScriptCore caps arguments near 64k). Now chunked.
- Stored text interpolated into HTML without escaping (`note.date`, avatar initials/photo URL): a crafted backup could inject markup. All now escaped / built with DOM APIs.
- A Mini App left open past midnight never loaded the new day's stored tasks, and the next save could overwrite tasks carried over to "tomorrow". Days are now tracked as "really loaded", every mutation loads first, and a resume handler refreshes "today".
- A failed storage write was reported as success (local write errors were swallowed, and the diff snapshot was updated before the write finished, so the change was never retried). Writes now throw, the UI reports it, and the next save retries.
- Relationship day counts parsed `YYYY-MM-DD` as UTC and could be off by one day. Now whole local days.
- Unawaited saves caused unhandled promise rejections (pin, habit toggle, end habit/relationship, theme/language/nickname).
- Missing validation: habit/memory end date before start date, empty event fields, habit goal < 1.
- Native `confirm()` replaced by the in-app dialog (some WebViews suppress it); fixed dialog stacking above the custom-achievement form.
- Recovery-code copy now has a fallback when the Clipboard API is blocked.
- "Start fresh" now also clears the in-memory action log and nickname.
- Card entrance animation replayed on every expand/toggle; it now plays only when the visible set changes.

Telegram
- `ready()` / `expand()` now run at boot (before unlock), not after.
- Viewport height, safe-area insets and theme parameters are exposed as CSS variables and kept in sync with Telegram events.
- Native BackButton closes the top-most overlay; header/background/bottom-bar colours follow the theme; first launch follows Telegram's colour scheme until the person chooses.
- All native calls are guarded by version checks and try/catch.

Performance and delivery
- Removed the Tailwind Play CDN runtime (≈300 KB script compiled in the browser on every launch); the 40 utility classes actually used are plain CSS.
- Release notes moved out of index.html (≈17 KB less per load). Fonts load without blocking first paint. Search inputs are debounced.
- Added `vercel.json` (security headers + Content-Security-Policy). No server functions.

Design
- New token-based light and dark themes, flat surfaces instead of gradients/glass, consistent components and states, 44px touch targets, reduced-motion support.

Compatibility
- Storage keys, backup format (`format: 1`) and encryption (PBKDF2 / AES-GCM parameters) are unchanged. `appVersion` in new backups reads 10.0.

---

## v9.5 and earlier — historical release notes

Moved out of index.html so it is no longer downloaded on every launch.

```
<!-- ============================================================
     DailyBookimix v9.5 — ARCHIVE TYPE FILTER + CARD REFRESH + iOS DATE FIX

     WHAT CHANGED (v9.3 → v9.5)
     1. NEW: Archive type filter. A row of compact chips (All / Book / Movie /
        Series / Game / Relationship / Other) sits under the Archive search
        bar. It combines with the text search (type AND query). The filter is
        view-only state — nothing is saved, nothing in storage changes.
        Empty states: truly empty archive, "nothing of this type yet", and
        "no results" for a text search are now three distinct messages.
     2. REDESIGN: non-relationship Archive cards. Type chip + coloured accent
        edge, a bigger title, and a clear date block (From -> To) that shows
        the end date as an equal partner of the start date instead of a tiny
        footnote. Notes clamp to 3 lines when collapsed and show in full
        (line breaks kept) when expanded. Pin badge, expand/collapse, action
        buttons and search highlighting are unchanged. Relationship cards are
        unchanged.
     3. FIX (iOS): on iOS Safari / Telegram iOS WebView the native
        <input type="date"> ignores width:100% and keeps its intrinsic width,
        so the End-date field collided with the Start-date field on the Habits
        and Archive forms. Both forms now use .date-row (CSS) with
        min-width:0 columns and a normalised date input; below 350px wide the
        two fields stack instead of squeezing.
     4. MINI-FIX: fmtDate() parsed 'YYYY-MM-DD' as UTC, so card dates could
        show one day early west of UTC. It now parses as a local date.
     5. New translation keys (en + ru): mem-filter-all, mem-filter-label,
        mem-filter-empty, mem-date-from, mem-date-to.
     No storage, encryption, backup-format, achievements or task changes.
     Cache-busting ?v= params on every asset are now 9.5.
     ============================================================
     (previous release notes follow)
-->
<!-- ============================================================
     DailyBookimix v9.3 — DAY STREAK FREEZES + LIGHT POLISH

     WHAT CHANGED (v9.2 → v9.3)
     1. NEW: Day Streak Freezes ("❄️"). Everyone gets 2 per calendar month
        (local time; refilled automatically on the 1st, incl. Dec→Jan).
        If exactly ONE day was missed, the next real action spends a
        freeze and the fire streak continues instead of resetting. Gaps
        of 2+ days still reset and never spend a freeze. The frozen day
        protects the chain but is not itself counted in the number.
        UI: "❄️ n" chip in the streak badge, a toast when a freeze is
        used, and ❄️ cells (distinct from 🔥) in the streak calendar.
        Stored as freezeCount / freezeMonth / freezeLog; included in
        export/import (older backups without them get safe defaults)
        and in delete-account / start-fresh wipes.
     2. POLISH: additive CSS block at the end of css/styles.css — larger
        touch targets (44px) for modal close, calendar nav, streak badge
        and hamburger; clearer placeholder / label / muted-text contrast;
        modal title hierarchy; safe-area-aware, wrapping toasts; press
        states. Colour system, themes and layout are unchanged.
     3. MINI-FIXES: fire-day cells in the streak calendar never showed
        their gradient (a more specific grey rule won) — fixed; streak
        save is now serialised (no interleaved writes) and NaN-guarded;
        a streak is no longer reset when the local date is one day
        behind the stored one (timezone travel); streak badge aria-label
        is now translated; cache-busting ?v= params were mixed 9.1/9.2 —
        every asset now uses 9.3.
     No encryption, achievements, task-manager or privacy changes.
     ============================================================
     (previous release notes follow)
-->
<!-- ============================================================
     DailyBookimix v9.1 — FIRE STREAK FIX + DESIGN POLISH

     WHAT CHANGED (v9.0 → v9.1)
     1. FIX (critical): the fire streak was extended just by OPENING the
        Daily Tasks tab (v9.0 added a updateStreak() call to
        diary.switchTab()). Removed. The streak is now extended only by a
        real task action — creating a task (TaskManager.quickAdd) or
        marking one completed (TaskManager.toggleTask) — and only after
        the save succeeded. Un-completing, deleting, carrying over and
        viewing the tab never touch it. updateStreak() itself is unchanged
        and stays idempotent per calendar day; every other call site
        (notes, habits, memories, events) is untouched.
     2. POLISH: short, transform/opacity-only micro-interactions (tab fade-in,
        hover lift on desktop, checkbox/button press states, streak-badge
        glow on extend), consistent radii and soft shadows, refined empty
        states, better dark-theme checkbox contrast, keyboard focus rings,
        larger delete hit-target, safe-area bottom padding. Additive CSS
        block at the end of css/styles.css; reduced-motion respected.
     3. QUALITY: double-submit guard on quick-add (Enter while saving),
        collision-proof task ids, null-guarded streak animation, error
        logging on failed task saves, task checkboxes are now keyboard
        accessible (role=checkbox, Enter/Space) and labelled.
     No data structures, storage keys, encryption or Telegram integration
     changed.
     ============================================================
     (previous release notes follow)
-->
<!-- ============================================================
     DailyBookimix v9.0 — FIRE STREAK + CUSTOM ACHIEVEMENTS EDITION

     WHAT CHANGED (v8.2 → v9.0)
     1. NEW: Custom (user-created) achievements. Inside the Achievements
        modal there is now a separate "My Achievements" section where
        anyone can create their own achievement — an emoji icon, a title,
        and an optional description — and mark it completed themselves
        whenever they like (no automatic progress tracking, by design).
        Custom achievements can be edited or deleted, are visually
        distinct (violet accent vs. the system achievements' gold), and
        are stored completely separately from the built-in system
        achievements under their own dedicated key (custom_achievements_v1
        — see js/achievements.js, js/storage.js). The existing system
        achievements (auto-unlock via AchievementsUI.recalculate()) are
        completely untouched. Full English + Russian translations.
     2. NEW: Opening the Daily Tasks tab now counts toward the fire streak
        the same way saving a note/habit/memory/event already did — see
        diary.switchTab()/updateStreak() in js/diary.js. updateStreak() was
        already a per-day-idempotent no-op once the streak had been
        updated for today, so this required no changes to the underlying
        streak-calculation logic, storage keys, or fire animation — only
        one additional call site.
     3. FIX: Notes/Habits/Archive rendered user-entered free text (titles,
        content, descriptions, partner names, event text) directly into
        innerHTML, unescaped — typing something like "<b>" or "a & b"
        broke the layout instead of showing literally. Daily Tasks already
        escaped its text for exactly this reason; the same escaping
        (Util.escHtml, js/util.js) is now applied everywhere free text is
        rendered, including the new custom achievements.
     4. FIX: switching language (applyLang()) never refreshed the Daily
        Tasks tab — its quick-add placeholder, mood labels, calendar month
        name, "Today" button, and stats chips stayed in the old language
        until the tab was closed and reopened. applyLang() now also calls
        TaskManager.render().
     5. FIX: an achievement's "earned on" date was parsed with
        `new Date('YYYY-MM-DD')`, which reads as UTC while the date is
        then displayed in local time — for anyone west of UTC this could
        silently show the day *before* the one actually recorded. Now
        parsed with the same local-date helper (Util.parseLocalDate) the
        rest of the app already uses to avoid exactly this bug.
     6. Deleting all data ("Delete everything" / "Start fresh") now also
        clears custom_achievements_v1, consistent with how it already
        clears the system achievements' state.
     7. FIX: the new custom-achievement create/edit modal (#customAchModal)
        is opened from inside the Achievements screen (#achievementsModal,
        z-index 10002) but only had the shared .modal-overlay z-index
        (8000) — the exact same layering bug already fixed once in v8.2 for
        #startFreshConfirmModal vs. #encryptionLock. Caught and fixed with
        the same kind of single targeted CSS rule before shipping, so it
        never reached a "dead button" state for anyone.
     No other behavior, data structures, encryption, storage, or Telegram
     integration changed.
     ============================================================
     DailyBookimix v8.2 — BUGFIX RELEASE

     WHAT CHANGED (v8.1 → v8.2)
     1. FIX: the "I forgot the password / I don't have my code — delete all
        data & start fresh" button on the lock screen appeared completely
        unresponsive (pressed state showed, nothing happened). Root cause:
        its confirmation dialog (#startFreshConfirmModal) uses the shared
        .modal-overlay z-index (8000), while #encryptionLock — the lock
        screen the button lives on — sits at z-index 99999. The modal WAS
        opening, just rendered invisibly behind the lock screen. Fixed with
        a single targeted CSS rule (#startFreshConfirmModal.open) raising
        only that modal above the lock screen; no JS logic was touched.

     ============================================================
     DailyBookimix v8.1 — GLOBAL SEARCH EDITION (previous release notes below)

     WHAT CHANGED (v8.0 → v8.1)
     1. Added a real-time, as-you-type search to the Daily Tasks section
        (js/task-manager.js, TaskManager._matchesTaskSearch/render) — the
        only section that didn't already have one. Notes, Habits, and
        Archive already had search bars; all four now share the same
        search-wrap look, and their filtering was broadened to also match
        category/type labels, dates, and (for habits) completion status —
        not just the title/name and body text.
     2. Search results are now visually highlighted (see Util.highlightMatch
        in js/util.js and the `.search-hl` style in css/styles.css) while
        staying fully interactive — every card's edit/delete/pin/complete
        controls work exactly as before, since only the *displayed* text is
        wrapped for highlighting; the underlying data is untouched.
     3. Removed the redundant secondary "🔥 streak" chip from the Daily
        Tasks stats bar. The app already has one fire-streak indicator (the
        main streak in the header) — this second one in Tasks was
        redundant and has been deleted. The streak *calculation* underneath
        it (TaskManager._stats.currentStreak) is kept as-is, since it also
        feeds the existing "3-day task streak" achievement — only the
        visual chip is gone.
     No other behavior, data structures, encryption, storage, achievements,
     translations, or Telegram integration changed.
     ============================================================
     DailyBookimix v8.0 — BRIDGE RELIABILITY EDITION

     WHAT CHANGED (v7.7 → v8.0)
     1. Fixed the iOS "stuck on Unlocking… forever" bug: TGPlatform's
        CloudStorage/DeviceStorage/SecureStorage calls had no timeout, so a
        native bridge callback that silently never fired (seen on some iOS
        Telegram client versions for the newer SecureStorage/DeviceStorage
        APIs) hung boot() indefinitely. Every bridge call is now bounded by
        TGPlatform.BRIDGE_TIMEOUT_MS and resolves as a normal failure instead
        of hanging — see js/tg-platform.js.
     2. Added a hard boot() watchdog (js/boot.js) as a second, independent
        safety net so no future unguarded await can strand anyone again.
     3. Cache-busting on all local script/style tags below, so a redeploy
        can no longer get stuck behind a stale cached bundle in Telegram's
        WebView (this was the actual cause of the "missing delete-my-data
        button" report — that button already existed in v7.7's code, it
        just wasn't reaching some users).
     ============================================================
     DailyBookimix v7.7 — AUTH REDESIGN + POLISH EDITION
     ============================================================

     WHY THIS VERSION EXISTS
     v7.6's authentication system had grown into five separate lock-
     screen tiers (Welcome → Show Recovery → Enter Recovery → Migrate
     v5 → Legacy Password → Error). That complexity directly caused two
     real bugs:
       • A brand-new Telegram account could be asked for a password or
         recovery code that never existed, because a single slow or
         ambiguous CloudStorage read on cold start was treated the same
         as "we truly cannot tell if this account is new."
       • A device that had just unlocked successfully with a recovery
         code could be asked for that same code again on its very next
         launch, because the Master Key was written to only one storage
         tier (SecureStorage) and that write's success was never
         verified.

     WHAT CHANGED (v7 → v7.7)
     1. AUTHENTICATION REDESIGNED FROM SCRATCH (see the big comment
        above `const EncryptionManager` further down for the full
        architecture write-up). In short:
          - Returning device with a locally-stored Master Key → instant,
            silent unlock. No screen, no typing, ever.
          - Confirmed brand-new account (nothing local, nothing in
            CloudStorage, no legacy password vault) → the vault is
            created SILENTLY and the app unlocks immediately; a
            dismissible one-time "save your recovery code" notice is
            shown on top of the already-unlocked app, not as a gate.
          - Genuinely new device on an account that already has a vault
            → the ONLY real credential prompt left: enter the recovery
            code once.
          - Existing password-only (legacy) accounts keep working via a
            one-time, transparent upgrade to the instant-unlock scheme.
          - Every ambiguous/flaky network condition is retried with
            backoff before any decision is made, and if Telegram's
            cloud/secure storage is genuinely unreachable the app
            degrades to a local-only vault instead of blocking the
            person behind a credential screen — it reconciles with the
            cloud automatically once connectivity returns.
          - The Master Key is now written to and verified against every
            available local storage tier (SecureStorage, DeviceStorage,
            localStorage), instead of a single unchecked write, so a
            partial failure can no longer strand a device on the
            recovery screen forever.
          - Recovery code can be re-viewed any time from Sidebar →
            Backup & recovery.
        Crypto itself is unchanged and still sound: one random 256-bit
        Master Key per account, AES-256-GCM via Web Crypto, the Master
        Key never leaves the device in plaintext, and CloudStorage only
        ever stores encrypted blobs + a recovery-code-wrapped copy of
        the key. Telegram cannot read plaintext notes, tasks, habits,
        or memories at any point.
     2. LANGUAGE SWITCHING pass: verified every visible surface (tabs,
        buttons, placeholders, toasts, empty states, modals, sidebar,
        achievements, lock screens, mood labels, archive labels) reads
        from a translation table and updates on `diary.applyLang()`
        instead of holding a hard-coded string.
     3. LIGHT THEME contrast pass: card borders, input borders, and
        text contrast were strengthened in the `:root` (orange) theme
        variables so content reads clearly without weakening the dark
        theme.
     4. Added extra micro-interactions (task-complete checkmark pop,
        achievement-unlock burst) alongside the existing button-press,
        card, tab, toast, streak, and modal animations, all built from
        CSS transforms/opacity and gated behind `prefers-reduced-motion`.
     5. General bug pass while rewriting (see inline `FIX:` comments).

     All functionality from v7.6 is preserved: Notes, Habits, Daily
     Tasks (quick-add, important flag, mood, 30-day archive, carry-
     over, streaks), Memory/Archive (books, movies, series, games,
     relationships), the 13-achievement system, sidebar (nickname,
     achievements, recovery code, delete all data), theme + language
     switchers, fire streak, and full end-to-end encryption.
============================================================ -->
```
