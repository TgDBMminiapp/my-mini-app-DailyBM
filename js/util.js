// @ts-check
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

    escHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    b64encode(buf) {
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
    },
    b64decode(str) {
        return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
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

    // Best-effort gzip compression for large JSON payloads before encryption.
    // Falls back to plain UTF-8 bytes when CompressionStream isn't available —
    // correctness over savings; decompress() mirrors the same fallback.
    async maybeCompress(str) {
        const bytes = new TextEncoder().encode(str);
        if (typeof CompressionStream === 'undefined') return { compressed: false, bytes };
        try {
            const cs = new CompressionStream('gzip');
            const writer = cs.writable.getWriter();
            writer.write(bytes); writer.close();
            const out = await new Response(cs.readable).arrayBuffer();
            return { compressed: true, bytes: new Uint8Array(out) };
        } catch (e) { return { compressed: false, bytes }; }
    },
    async maybeDecompress(bytes, compressed) {
        if (!compressed) return new TextDecoder().decode(bytes);
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes); writer.close();
        const out = await new Response(ds.readable).arrayBuffer();
        return new TextDecoder().decode(out);
    },

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
};


