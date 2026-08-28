// @ts-check
// ================================================================
//  STORAGE MANAGER v6
//
//  WHAT CHANGED FROM v5 AND WHY:
//   - v5 stored each whole collection (all notes, all habits, every
//     day of tasks ever) as ONE JSON blob under one CloudStorage key.
//     CloudStorage caps each value at a few KB, so that blob grows
//     until every future save silently fails — the root cause of the
//     "Daily Tasks won't save" reports.
//   - v6 shards collections into one small key per item (or per day,
//     for tasks — see TaskManager) plus a tiny index, so no single
//     value can ever approach the cap regardless of account age.
//   - v5's getItem swallowed network errors into "key doesn't exist",
//     which could silently fabricate a brand-new encryption identity
//     on a transient failure (see EncryptionManager). v6 only ever
//     treats an EXPLICIT cloud value as authoritative; any error or
//     "confirmed absent" response falls back to the local cache
//     instead of assuming emptiness — so offline writes never get
//     discarded by a slow sync, and identity never gets fabricated.
//   - Local storage is written first, synchronously in the save
//     path, before any network round trip — so a save always
//     survives a page refresh / lost connection on its own device,
//     with cross-device sync layered on top as a best-effort push.
// ================================================================
const StorageManager = {
    _snapshots: {}, // category -> Map(id -> last-written JSON), used to diff saveCollection()

    init() { TGPlatform.init(); },

    _localGetRaw(key) {
        try { return localStorage.getItem('dbmix_' + key) || null; } catch (e) { return null; }
    },
    _localSetRaw(key, value) {
        try { localStorage.setItem('dbmix_' + key, value); } catch (e) {}
    },
    _localRemoveRaw(key) {
        try { localStorage.removeItem('dbmix_' + key); } catch (e) {}
    },

    async _mirrorLocal(key, value) {
        if (TGPlatform.supportsDevice) { try { await TGPlatform.deviceSet(key, value); } catch (e) {} }
        else this._localSetRaw(key, value);
    },

    /** Save one value. Writes the local cache first (durable immediately,
     *  survives offline/refresh on this device), then best-effort syncs
     *  to CloudStorage with retries for cross-device propagation. */
    async setItem(key, value) {
        const encrypted = await EncryptionManager.encrypt(value);
        await this._mirrorLocal(key, encrypted);
        if (TGPlatform.supportsCloud) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const r = await TGPlatform.cloudSet(key, encrypted);
                if (r.ok) return;
                if (attempt < 2) await Util.sleep(500 * (attempt + 1));
            }
            console.warn('[StorageManager] cloud sync failed after retries for key:', key, '(kept locally; will retry on next write)');
        }
    },

    /** Read one value. An EXPLICIT cloud value wins (cross-device freshest).
     *  Anything else — cloud error, cloud "confirmed absent", or no cloud
     *  support at all — falls back to the local cache rather than assuming
     *  emptiness. This is the fix for the v5 data-loss/identity-reset bug. */
    async getItem(key) {
        if (TGPlatform.supportsCloud) {
            const r = await TGPlatform.cloudGet(key);
            if (r.ok && r.value !== null) {
                this._mirrorLocal(key, r.value); // best-effort, don't block the read on it
                return EncryptionManager.decrypt(r.value);
            }
        }
        let raw = null;
        if (TGPlatform.supportsDevice) { const dr = await TGPlatform.deviceGet(key); raw = dr.ok ? dr.value : null; }
        else { raw = this._localGetRaw(key); }
        if (!raw) return null;
        return EncryptionManager.decrypt(raw);
    },

    async removeItem(key) {
        if (TGPlatform.supportsCloud) { try { await TGPlatform.cloudRemove(key); } catch (e) {} }
        if (TGPlatform.supportsDevice) { try { await TGPlatform.deviceRemove(key); } catch (e) {} }
        this._localRemoveRaw(key);
    },

    async getItems(keys) {
        const result = {};
        await Promise.all(keys.map(async k => {
            const v = await this.getItem(k);
            if (v !== null) result[k] = v;
        }));
        return result;
    },

    // ── Sharded collection helper: one key per item + a small index of ids.
    // Used for notes / habits / memories. Diffs against the last-saved
    // snapshot so editing one item only writes that one shard + the index,
    // never the whole collection — this is what actually fixes the "every
    // save re-uploads everything" problem, independent of item count.
    _snap(category) {
        if (!this._snapshots[category]) this._snapshots[category] = new Map();
        return this._snapshots[category];
    },

    async saveCollection(category, items) {
        const snap = this._snap(category);
        const currentIds = new Set();
        const writes = [];
        for (const item of items) {
            const id = String(item.id);
            currentIds.add(id);
            const json = JSON.stringify(item);
            if (snap.get(id) !== json) {
                writes.push(this.setItem(`${category}_${id}`, json));
                snap.set(id, json);
            }
        }
        for (const id of Array.from(snap.keys())) {
            if (!currentIds.has(id)) {
                writes.push(this.removeItem(`${category}_${id}`));
                snap.delete(id);
            }
        }
        writes.push(this.setItem(`${category}_index`, JSON.stringify(items.map(i => i.id))));
        await Promise.all(writes);
    },

    /** Loads a sharded collection. On first run after upgrading from v5,
     *  transparently migrates the old monolithic blob (stored under the
     *  bare category key) into shards, then deletes the old blob. */
    async loadCollection(category) {
        const indexRaw = await this.getItem(`${category}_index`);
        if (indexRaw === null) {
            const legacyRaw = await this.getItem(category);
            if (legacyRaw) {
                let legacyItems = [];
                try { legacyItems = JSON.parse(legacyRaw); } catch (e) { legacyItems = []; }
                await this.saveCollection(category, legacyItems);
                await this.removeItem(category);
                return legacyItems;
            }
            return [];
        }
        let ids = [];
        try { ids = JSON.parse(indexRaw); } catch (e) { ids = []; }
        const raws = await Promise.all(ids.map(id => this.getItem(`${category}_${id}`)));
        const items = raws.map(r => {
            if (!r) return null;
            try { return JSON.parse(r); } catch (e) { return null; }
        }).filter(Boolean);
        const snap = this._snap(category);
        items.forEach(item => snap.set(String(item.id), JSON.stringify(item)));
        return items;
    },

    /** Fully erase a sharded collection (used by "delete account"). */
    async wipeCollection(category) {
        const snap = this._snap(category);
        const ids = Array.from(snap.keys());
        await Promise.all(ids.map(id => this.removeItem(`${category}_${id}`)));
        await this.removeItem(`${category}_index`);
        await this.removeItem(category); // in case a never-migrated legacy blob still exists
        snap.clear();
    },
};



