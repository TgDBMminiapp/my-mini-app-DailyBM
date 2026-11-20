// @ts-check
// ================================================================
//  STORAGE MANAGER
//
//  - Collections (notes, habits, memories) and per-day task data are sharded:
//    one small key per item/day plus a tiny index, so no single value can
//    approach CloudStorage's per-value cap.
//  - Writes go to the local tier FIRST (durable on this device, offline-safe),
//    then are pushed to CloudStorage with retries for cross-device sync.
//  - Only an EXPLICIT cloud value is treated as authoritative on read. A cloud
//    error or "absent" answer falls back to the local copy; it is never read as
//    "empty", which is what once caused silent data/identity loss.
//  - A write that could not be stored anywhere THROWS, so callers can roll back
//    their UI state and tell the person, instead of reporting a false success.
// ================================================================
const StorageManager = {
    _snapshots: {}, // category -> Map(id -> last-written JSON), used to diff saveCollection()

    init() { TGPlatform.init(); DBLog.info('Storage', `Storage ready (cloud: ${TGPlatform.supportsCloud}, device: ${TGPlatform.supportsDevice}, secure: ${TGPlatform.supportsSecure}).`); },

    _localGetRaw(key) {
        try { return localStorage.getItem('dbmix_' + key) || null; } catch (e) { return null; }
    },
    /** @returns {boolean} true when the value was actually stored */
    _localSetRaw(key, value) {
        try { localStorage.setItem('dbmix_' + key, value); return true; }
        catch (e) { DBLog.warn('Storage', 'Local write failed (storage full or blocked).', e); return false; }
    },
    _localRemoveRaw(key) {
        try { localStorage.removeItem('dbmix_' + key); } catch (e) { /* storage blocked */ }
    },

    /** Writes the local copy. Prefers DeviceStorage; falls back to localStorage if that fails.
     *  @returns {Promise<boolean>} whether any local tier accepted the value */
    async _mirrorLocal(key, value) {
        if (TGPlatform.supportsDevice) {
            const r = await TGPlatform.deviceSet(key, value);
            if (r.ok) return true;
            DBLog.warn('Storage', 'Device storage write failed. Using browser storage for this item.', r.error);
        }
        return this._localSetRaw(key, value);
    },

    /** Reads the local copy: DeviceStorage first, then browser storage. */
    async _readLocalRaw(key) {
        let raw = null;
        if (TGPlatform.supportsDevice) { const dr = await TGPlatform.deviceGet(key); raw = dr.ok ? dr.value : null; }
        return raw || this._localGetRaw(key);
    },

    /** Save one value. Writes the local cache first (durable immediately,
     *  survives offline/refresh on this device), then best-effort syncs
     *  to CloudStorage with retries for cross-device propagation. */
    async setItem(key, value) {
        const encrypted = await EncryptionManager.encrypt(value);
        const localOk = await this._mirrorLocal(key, encrypted);
        if (TGPlatform.supportsCloud) {
            for (let attempt = 0; attempt < 3; attempt++) {
                const r = await TGPlatform.cloudSet(key, encrypted);
                if (r.ok) return;
                if (attempt < 2) await Util.sleep(500 * (attempt + 1));
            }
            if (localOk) { DBLog.warn('Storage', 'Cloud sync failed after retries. Data is kept on this device and will sync on a later save.'); return; }
        } else if (localOk) return;
        throw new Error('storage_write_failed');
    },

    /** Read one value. An EXPLICIT cloud value wins (cross-device freshest).
     *  Anything else — cloud error, cloud "confirmed absent", or no cloud
     *  support at all — falls back to the local cache rather than assuming
     *  emptiness. This is the fix for the v5 data-loss/identity-reset bug. */
    async getItem(key) {
        if (TGPlatform.supportsCloud) {
            const r = await TGPlatform.cloudGet(key);
            if (r.ok && r.value !== null) {
                this._mirrorLocal(key, r.value).catch(() => {}); // best-effort refresh, don't block the read
                return EncryptionManager.decrypt(r.value);
            }
        }
        const raw = await this._readLocalRaw(key);
        if (!raw) return null;
        return EncryptionManager.decrypt(raw);
    },

    /** Local-only variants: encrypted like everything else but NEVER sent to
     *  CloudStorage. Used for data that must stay on this device (action
     *  history) and that may exceed CloudStorage's per-value size cap. */
    async setLocalItem(key, value) {
        const encrypted = await EncryptionManager.encrypt(value);
        if (!(await this._mirrorLocal(key, encrypted))) throw new Error('storage_write_failed');
    },
    async getLocalItem(key) {
        const raw = await this._readLocalRaw(key);
        if (!raw) return null;
        return EncryptionManager.decrypt(raw);
    },

    async removeLocalItem(key) {
        if (TGPlatform.supportsDevice) { try { await TGPlatform.deviceRemove(key); } catch (e) { /* best effort */ } }
        this._localRemoveRaw(key);
    },

    async removeItem(key) {
        if (TGPlatform.supportsCloud) { try { await TGPlatform.cloudRemove(key); } catch (e) { /* best effort */ } }
        if (TGPlatform.supportsDevice) { try { await TGPlatform.deviceRemove(key); } catch (e) { /* best effort */ } }
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
                // The snapshot is updated only AFTER the write succeeds, so a failed
                // write is retried by the next save instead of being treated as stored.
                writes.push(this.setItem(`${category}_${id}`, json).then(() => { snap.set(id, json); }));
            }
        }
        for (const id of Array.from(snap.keys())) {
            if (!currentIds.has(id)) {
                writes.push(this.removeItem(`${category}_${id}`).then(() => { snap.delete(id); }));
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



