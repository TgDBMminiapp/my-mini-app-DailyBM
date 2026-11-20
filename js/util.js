// @ts-check
// ================================================================
//  LOG — small, consistent logger.
//  Output format:  [Module] Human-readable message.
//  Levels: info / warn / error. Only a short, sanitised description of an
//  error is ever printed (its name and, for non-parse errors, a trimmed
//  message) — never stored data, keys, codes or note text. The last
//  LOG_KEEP entries are kept in memory (not persisted, not transmitted) so
//  `DBLog.history()` can be pasted from a console when troubleshooting.
// ================================================================
const DBLog = (() => {
    const KEEP = 60;
    const ring = [];
    const describe = (err) => {
        if (err == null) return '';
        if (typeof err === 'string') return err.slice(0, 80);
        const name = err.name || 'Error';
        // JSON.parse messages quote a fragment of the parsed text — never print those.
        if (name === 'SyntaxError') return name;
        return (name + (err.message ? ': ' + String(err.message).slice(0, 120) : '')).trim();
    };
    const emit = (level, mod, msg, err) => {
        const detail = describe(err);
        const line = `[${mod}] ${msg}${detail ? ' (' + detail + ')' : ''}`;
        ring.push({ t: Date.now(), level, line });
        if (ring.length > KEEP) ring.shift();
        try { console[level](line); } catch (e) { /* console unavailable */ }
    };
    return {
        info(mod, msg)       { emit('info', mod, msg); },
        warn(mod, msg, err)  { emit('warn', mod, msg, err); },
        error(mod, msg, err) { emit('error', mod, msg, err); },
        history()            { return ring.map(r => new Date(r.t).toISOString() + ' ' + r.line); },
        describe,
    };
})();

// Last-resort handlers so nothing fails silently. They only log a sanitised
// description; the default browser behaviour is left untouched.
window.addEventListener('unhandledrejection', (e) => DBLog.error('App', 'An operation failed unexpectedly.', e.reason));
window.addEventListener('error', (e) => { if (e && e.message) DBLog.error('App', 'A script error occurred.', { name: 'Error', message: e.message }); });

// ================================================================
//  UTIL — small shared helpers used across the app.
//  FIX: every date computation in v5 used `Date#toISOString()`, which
//  is UTC, not the user's local date. Anyone not in UTC got tasks,
//  mood, and streaks misfiled near midnight in their own timezone.
//  Everything below uses the device's LOCAL calendar date instead.
// ================================================================
const Util = {
    /** Local YYYY-MM-DD for a given Date (defaults to now). Local, NOT UTC. */
    localDateStr(d) {
        d = d || new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    },
    /** Local 'YYYY-MM-DD HH:mm' for an epoch-ms timestamp (or Date). Local, NOT UTC. */
    localDateTimeStr(ts) {
        const d = ts instanceof Date ? ts : new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return `${this.localDateStr(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    /** Add n local calendar days to a YYYY-MM-DD string, return YYYY-MM-DD. */
    addDays(dateStr, n) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() + n);
        return this.localDateStr(dt);
    },
    // FIX: `new Date('YYYY-MM-DD')` parses as UTC midnight, but Date#getDate()/
    // getDay() read LOCAL time — for negative UTC-offset users that silently
    // shifts every date back by one day (e.g. the habit calendar grid). Use
    // this whenever a YYYY-MM-DD string needs to become a local-midnight Date.
    parseLocalDate(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d);
    },

    // Chunked on purpose: String.fromCharCode(...bytes) throws RangeError once the
    // array is large (JavaScriptCore, used by Telegram iOS, caps arguments near 64k).
    b64encode(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    },
    b64decode(str) {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    },

    // ── Recovery code: Crockford base32 (excludes I, L, O, U — no ambiguous chars) ──
    // 13 random bytes (104 bits) trimmed to 20 symbols (100 bits of entropy),
    // grouped for readability: "XXXX-XXXX-XXXX-XXXX-XXXX".
    _CROCKFORD: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
    generateRecoveryCode() {
        const bytes = crypto.getRandomValues(new Uint8Array(13));
        let bits = '';
        for (const b of bytes) bits += b.toString(2).padStart(8, '0');
        let raw = '';
        for (let i = 0; i + 5 <= bits.length && raw.length < 20; i += 5) {
            raw += this._CROCKFORD[parseInt(bits.slice(i, i + 5), 2)];
        }
        return raw.match(/.{1,4}/g).join('-');
    },
    // Forgiving normalization so a mistyped O/I/L or stray spaces/case still work.
    normalizeRecoveryCode(input) {
        return String(input).toUpperCase().replace(/[^0-9A-Z]/g, '')
            .replace(/O/g, '0').replace(/I/g, '1').replace(/L/g, '1');
    },
    formatRecoveryInput(input) {
        const norm = this.normalizeRecoveryCode(input).slice(0, 20);
        return norm.match(/.{1,4}/g)?.join('-') || norm;
    },

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    /** Trailing-edge debounce (used for search-as-you-type so each keystroke doesn't re-render lists). */
    debounce(fn, ms) {
        let t = null;
        const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
        wrapped.cancel = () => { clearTimeout(t); t = null; };
        return wrapped;
    },

    /** Whole local calendar days between two YYYY-MM-DD strings (b - a). DST-safe. */
    daysBetween(a, b) {
        const da = this.parseLocalDate(a), db = this.parseLocalDate(b);
        return Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) -
                           Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000);
    },

    // HTML-escapes user-entered text before it is placed in innerHTML.
    // Every render path that interpolates stored text must go through this.
    escHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    // Search highlighting: wraps case-insensitive matches of `query` in an
    // already-escaped `text` with <mark class="search-hl">. Display-only —
    // handlers always read the original data. No-op for an empty query.
    highlightMatch(text, query) {
        const str = text == null ? '' : String(text);
        const q = (query == null ? '' : String(query)).trim();
        if (!q) return str;
        try {
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('(' + escaped + ')', 'ig');
            return str.replace(re, '<mark class="search-hl">$1</mark>');
        } catch (e) {
            return str;
        }
    },
};


