/**
 * dsh-archive-center — Host half.
 *
 * A Cordis bundle row providing the `archiveCenter` service over the official
 * workspace-registry archive set (`workspaceRegistry.archivedSessionIds`):
 *   - list()        archived sessions with title/cwd/preset metadata + diagnostics.
 *                   Sessions the current persistence layer cannot read (older
 *                   log format versions, e.g. v3 under a v4 harness) are read
 *                   directly from disk via node:zstd.
 *   - search()      keyword filter (FTS5 via sessionQuery when available, scan fallback).
 *   - unarchive()   official workspaceRegistry.unarchiveSession — restore in place.
 *   - delete()      stop a live agent, physically remove the session log dir,
 *                   then drop the id from the archive set.
 *   - preview()     last N user/assistant messages for a quick look.
 *
 * A loopback-only HTTP fallback (`/archive-center/api/*`) is registered for
 * browser runtimes where the service is not proxied to the client.
 */

export const id = 'archive-center';

// Hard deps only: persistence (read sessions) + registry (archive set).
// Everything else (sessionQuery FTS, agents, webServer) is resolved softly so a
// missing optional service degrades a feature instead of killing the plugin.
export const inject = ['sessionPersistence', 'workspaceRegistry'];

const FTS_CODE_STOP = ['SESSION_QUERY_SEARCH_DISABLED', 'SESSION_QUERY_INDEX_FAILED'];

export function apply(ctx) {
  const registry = ctx.workspaceRegistry;
  const persistence = ctx.sessionPersistence;

  const basenameOf = (p) => {
    const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || String(p || '');
  };

  const normalizeForDisplay = (text) =>
    String(text || '').replace(/\s+/gu, ' ').trim();

  // ── Legacy (unreadable-format) session support ─────────────────────────
  // dsh persistence refuses logs written by older format versions; archived
  // sessions would vanish from every listing. We read their headers and events
  // straight from disk: <home>/sessions/<group>/session-<id>/session.vN.jsonl[.zstd]
  const nodeModules = {
    zlib: undefined, fs: undefined, path: undefined, os: undefined,
    async ensure() {
      if (!this.zlib) {
        this.zlib = await import('node:zlib');
        this.fs = await import('node:fs');
        this.path = await import('node:path');
        this.os = await import('node:os');
      }
      return this;
    },
  };

  function sessionsRoots() {
    const home = process.env.DSH_HOME
      || nodeModules.path.join(nodeModules.os.homedir(), '.dsh');
    return [nodeModules.path.join(home, 'sessions')];
  }

  const legacyCache = new Map();

  /** Find one session on disk regardless of format version. Resolves {header, dir, logPath}. */
  async function legacyFind(id) {
    if (legacyCache.has(id)) return legacyCache.get(id);
    await nodeModules.ensure();
    const { fs, path, zlib } = nodeModules;
    const bare = String(id).replace(/^session-/, '');
    for (const root of sessionsRoots()) {
      if (!fs.existsSync(root)) continue;
      let groups = [];
      try { groups = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const group of groups) {
        const groupPath = path.join(root, group.name);
        const candidates = group.isDirectory()
          ? [path.join(groupPath, `session-${bare}`), path.join(groupPath, id)]
          : [groupPath];
        for (const dir of candidates) {
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
          let files = [];
          try { files = fs.readdirSync(dir); } catch { continue; }
          const log = files.find((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
          if (!log) continue;
          const logPath = path.join(dir, log);
          try {
            let text;
            if (log.endsWith('.zstd')) text = zlib.zstdDecompressSync(fs.readFileSync(logPath)).toString('utf8');
            else text = fs.readFileSync(logPath, 'utf8');
            const firstLine = text.split('\n', 1)[0];
            const header = JSON.parse(firstLine);
            if (String(header.id) !== String(id) && String(header.id).replace(/^session-/, '') !== bare) continue;
            const found = { header, dir, logPath, raw: text };
            legacyCache.set(id, found);
            return found;
          } catch { /* unreadable artifact — try next candidate */ }
        }
      }
    }
    legacyCache.set(id, undefined);
    return undefined;
  }

  async function archivedHeaders() {
    const archived = registry.archivedSessionIds || [];
    const headers = await persistence.list();
    const byId = new Map();
    for (const h of headers) byId.set(h.id, h);
    return { archived, byId, present: archived.filter((x) => byId.has(x)), missing: archived.filter((x) => !byId.has(x)) };
  }

  async function titleMap(ids) {
    const titles = new Map();
    const sessionQuery = ctx.get('sessionQuery');
    if (!sessionQuery || typeof sessionQuery.readTitleSnapshots !== 'function' || ids.length === 0) return titles;
    try {
      const snaps = await sessionQuery.readTitleSnapshots(ids);
      for (const r of snaps) {
        if (r.status === 'fulfilled') {
          const t = r.value && r.value.title;
          titles.set(r.sessionId, typeof t?.title === 'string' ? t.title : '');
        }
      }
    } catch { /* titles are optional */ }
    return titles;
  }

  function toRow(id, header, title, legacy) {
    return {
      id,
      title: title || '',
      cwd: header.cwd || '',
      workspace: basenameOf(header.cwd),
      createdAt: header.createdAt || 0,
      agentPreset: header.agentPreset || '',
      ...(legacy ? { legacy: true } : {}),
    };
  }

  /** Events of a legacy session as {type, time, data} (header line excluded). */
  function legacyEvents(found) {
    if (!found || !found.raw) return [];
    const events = [];
    for (const line of found.raw.split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'session') continue;
        events.push(rec);
      } catch { /* tolerate torn tail lines */ }
    }
    return events;
  }

  const service = {
    /** Archived sessions (current + legacy-format) plus diagnostics counters. */
    async list() {
      const { archived, byId, present, missing } = await archivedHeaders();
      const titles = await titleMap(present);
      const rows = present
        .map((id) => toRow(id, byId.get(id) || {}, titles.get(id)))
        .sort((a, b) => b.createdAt - a.createdAt);
      let legacyCount = 0;
      let missingCount = 0;
      const legacyRows = [];
      for (const id of missing) {
        const found = await legacyFind(id);
        if (found) {
          legacyRows.push(toRow(id, found.header, '', true));
          legacyCount++;
        } else missingCount++;
      }
      legacyRows.sort((a, b) => b.createdAt - a.createdAt);
      return {
        rows: [...rows, ...legacyRows],
        diagnostics: {
          registryCount: archived.length,
          persistenceCount: byId.size,
          presentCount: present.length,
          legacyCount,
          missingCount,
        },
      };
    },

    /**
     * Keyword search over archived sessions: title/cwd/id/preset match first,
     * then full-text via sessionQuery (FTS5 when active, per-session scan
     * otherwise). Legacy sessions are searched by metadata + raw log scan.
     */
    async search(opts = {}) {
      const query = String(opts.query || '').trim();
      const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(200, opts.limit)) : 50;
      const base = await this.list();
      if (!query) return { rows: base.rows, query, mode: 'all', diagnostics: base.diagnostics };

      const low = query.toLowerCase();
      const metaHits = base.rows.filter((r) =>
        (r.title || '').toLowerCase().includes(low)
        || (r.cwd || '').toLowerCase().includes(low)
        || r.id.toLowerCase().includes(low)
        || (r.agentPreset || '').toLowerCase().includes(low));
      const hitIds = new Set(metaHits.map((r) => r.id));

      // Legacy sessions: search the decompressed log content directly.
      const legacyHits = [];
      for (const row of base.rows) {
        if (!row.legacy || hitIds.has(row.id)) continue;
        try {
          const found = await legacyFind(row.id);
          if (found && normalizeForDisplay(found.raw).toLowerCase().includes(low)) legacyHits.push(row);
        } catch { /* one unreadable log never fails the search */ }
      }

      const restIds = base.rows.map((r) => r.id).filter((id) => !hitIds.has(id) && !legacyHits.some((h) => h.id === id));
      const sessionQuery = ctx.get('sessionQuery');
      const textHits = [];
      if (sessionQuery && restIds.length > 0) {
        if (typeof sessionQuery.searchSessions === 'function') {
          try {
            const res = await sessionQuery.searchSessions({
              query,
              limit,
              sessionFilters: [{ kind: 'id', values: restIds }],
            });
            const titles = await titleMap(res.items.map((it) => it.header.id));
            for (const item of res.items) {
              textHits.push(toRow(item.header.id, item.header, titles.get(item.header.id)));
            }
          } catch (e) {
            const code = e && e.code ? String(e.code) : '';
            if (code.startsWith('SESSION_QUERY_INVALID')) throw e;
            // otherwise fall through to scan
          }
        }
        const found = new Set(textHits.map((r) => r.id));
        const remaining = restIds.filter((x) => !found.has(x));
        if (remaining.length > 0 && typeof sessionQuery.filterEvents === 'function') {
          let cursor = 0;
          const worker = async () => {
            while (cursor < remaining.length) {
              const sid = remaining[cursor++];
              try {
                const docs = await sessionQuery.filterEvents(sid, [{ kind: 'text', text: query }]);
                if (docs.length > 0) {
                  const headers = await persistence.list();
                  const h = headers.find((x) => x.id === sid) || {};
                  textHits.push(toRow(sid, h, ''));
                }
              } catch { /* one unreadable session never fails the search */ }
            }
          };
          await Promise.all(Array.from({ length: Math.min(6, remaining.length) }, worker));
        }
      }

      const merged = [...metaHits, ...legacyHits, ...textHits];
      const seen = new Set();
      const rows = merged.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
      return { rows, query, mode: 'search', diagnostics: base.diagnostics };
    },

    /** Restore: official public API — the session returns to its original spot. */
    async unarchive(id) {
      if (!id) throw new Error('缺少会话 id');
      await registry.unarchiveSession(id);
      return { ok: true };
    },

    /** Locate the on-disk directory of one stored session (persistence first, disk scan fallback). */
    async sessionDir(id) {
      const headers = await persistence.list();
      const header = headers.find((h) => h.id === id);
      if (header && typeof persistence.locate === 'function') {
        try {
          const loc = persistence.locate({ cwd: header.cwd, id });
          const p = String(loc && loc.path || '');
          if (p) return p.replace(/[\\/][^\\/]*$/, '');
        } catch { /* fall through to scan */ }
      }
      const found = await legacyFind(id);
      return found ? found.dir : undefined;
    },

    /** Hard-delete one archived session: stop a live agent, remove the log dir, drop from the archive set. */
    async delete(id) {
      if (!id) throw new Error('缺少会话 id');
      if (!(registry.archivedSessionIds || []).includes(id)) {
        throw new Error('只能删除已归档的会话');
      }
      // Best-effort: cancel a live agent so no process holds the log dir open.
      let stoppedLiveAgent = false;
      try {
        const agents = ctx.get('agents');
        const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined;
        if (agent) {
          if (typeof agent.cancel === 'function') agent.cancel({ kind: 'disposed' });
          if (typeof agent.whenIdle === 'function') await agent.whenIdle();
          stoppedLiveAgent = true;
        }
      } catch { /* best-effort only */ }

      const dir = await this.sessionDir(id);
      if (dir) {
        // Guard: never rm a directory that does not carry the session id.
        if (!String(dir).replace(/[\\/]/g, '-').includes(String(id).replace(/^session-/, ''))) {
          throw new Error(`安全拦截：目标目录与会话 id 不匹配: ${dir}`);
        }
        const fs = (await nodeModules.ensure()).fs;
        fs.rmSync(dir, { recursive: true, force: true });
        if (fs.existsSync(dir)) {
          throw new Error(`目录删除后仍存在（可能被占用）: ${dir}`);
        }
      }
      legacyCache.delete(id);

      // Purge in-memory traces so the sidebar drops the ghost immediately and
      // the deleted session cannot be re-archived from a stale header index.
      // - Live session store: detach the entry (removes it from ctx.sessions).
      // - Workspace registry private caches: header index + canonical-cwd maps.
      //   The sidebar projects record.sessionIds through the cwd map, so a
      //   purged entry vanishes from every workspace without a restart.
      try {
        const sessions = ctx.get('sessions');
        const entry = sessions && sessions.store ? sessions.store.get(id) : undefined;
        if (entry && typeof entry.detach === 'function') entry.detach();
      } catch { /* best-effort */ }
      try {
        registry.headers?.delete?.(id);
        registry.sessionPaths?.delete?.(id);
        registry.invalidSessionPaths?.delete?.(id);
      } catch { /* best-effort */ }

      // Drop the archive-set entry regardless (an entry whose session is gone resolves).
      await registry.unarchiveSession(id);
      return { ok: true, stoppedLiveAgent, alreadyGone: !dir };
    },

    /** Batch delete, sequentially isolated per id. */
    async deleteMany(ids) {
      if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids 不能为空');
      const unique = [...new Set(ids.map((v) => String(v).trim()).filter(Boolean))];
      const results = [];
      for (const one of unique) {
        try {
          results.push({ id: one, ok: true, ...(await this.delete(one)) });
        } catch (e) {
          results.push({ id: one, ok: false, error: e && e.message ? e.message : String(e) });
        }
      }
      const succeeded = results.filter((r) => r.ok).length;
      return { results, succeeded, failed: results.length - succeeded, total: results.length };
    },

    /** Remove archive-set entries whose session log no longer exists anywhere (persistence + disk). */
    async cleanupDangling() {
      const archived = [...(registry.archivedSessionIds || [])];
      const headers = await persistence.list();
      const known = new Set(headers.map((h) => h.id));
      const removed = [];
      for (const id of archived) {
        if (known.has(id)) continue;
        const found = await legacyFind(id);
        if (found) continue; // legacy-readable: not dangling
        try {
          await registry.unarchiveSession(id);
          legacyCache.delete(id);
          removed.push(id);
        } catch { /* one failing entry never aborts the sweep */ }
      }
      return { ok: true, removed: removed.length, ids: removed };
    },

    /** Preview: last N user/assistant turns, read-only (works for legacy formats too). */
    async preview(id, count = 4) {
      if (!id) throw new Error('缺少会话 id');
      const n = Number.isFinite(count) ? Math.max(1, Math.min(10, count)) : 4;
      let events = [];
      const sessionQuery = ctx.get('sessionQuery');
      if (sessionQuery && typeof sessionQuery.readSurface === 'function') {
        try { events = (await sessionQuery.readSurface(id)).events || []; } catch { /* fall through */ }
      }
      if (events.length === 0 && sessionQuery && typeof sessionQuery.readSession === 'function') {
        try { events = (await sessionQuery.readSession(id)).events || []; } catch { /* fall through */ }
      }
      if (events.length === 0) {
        const found = await legacyFind(id);
        if (found) events = legacyEvents(found);
      }
      const msgs = [];
      for (let i = events.length - 1; i >= 0 && msgs.length < n; i--) {
        const ev = events[i];
        if (!ev || !ev.type) continue;
        if (ev.type === 'user/message') {
          const text = (ev.data?.content || []).map((b) => b?.text || '').join(' ').trim();
          if (text) msgs.push({ role: 'user', text: normalizeForDisplay(text).slice(0, 200), time: ev.time || 0 });
        } else if (ev.type === 'assistant/message') {
          const text = (ev.data?.message?.content || []).map((b) => b?.text || '').join(' ').trim();
          if (text) msgs.push({ role: 'assistant', text: normalizeForDisplay(text).slice(0, 200), time: ev.time || 0 });
        }
      }
      msgs.reverse();
      return { messages: msgs, total: msgs.length };
    },
  };

  ctx.provide('archiveCenter', service);

  // ── HTTP fallback for clients without service proxying ──────────────────
  // Loopback trust fence: mandatory Host header + same-origin check + 8 KiB cap.
  try {
    ctx.inject(['webServer'], (w) => {
      const webServer = w.webServer;
      if (!webServer) return;
      const MAX_BODY = 8 * 1024;
      const trusted = (req) => {
        const host = String(req.headers?.host || '');
        if (!host || !/^[-a-zA-Z0-9.]+(:\d+)?$/.test(host)) return false;
        const origin = req.headers?.origin;
        if (origin === undefined || origin === null) return origin !== 'null';
        try { return new URL(String(origin)).host.toLowerCase() === host.toLowerCase(); } catch { return false; }
      };
      const body = async (req) => {
        const chunks = [];
        let total = 0;
        for await (const c of req) { total += c.length; if (total > MAX_BODY) throw new Error('body too large'); chunks.push(Buffer.from(c)); }
        return Buffer.concat(chunks).toString('utf8');
      };
      const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      const data = (raw) => (raw ? JSON.parse(raw) : {});
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/archive-center/api',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost');
          const p = url.pathname.replace(/^\/archive-center\/api/, '') || '/';
          try {
            if (!trusted(req)) return send(res, 403, { error: 'untrusted request' });
            if (req.method === 'GET' && p === '/list') return send(res, 200, await service.list());
            if (req.method === 'POST' && p === '/search') return send(res, 200, await service.search(data(await body(req))));
            if (req.method === 'POST' && p === '/unarchive') return send(res, 200, await service.unarchive(data(await body(req)).id));
            if (req.method === 'POST' && p === '/delete') return send(res, 200, await service.delete(data(await body(req)).id));
            if (req.method === 'POST' && p === '/deleteMany') { const d = data(await body(req)); return send(res, 200, await service.deleteMany(d.ids)); }
            if (req.method === 'POST' && p === '/cleanup') return send(res, 200, await service.cleanupDangling());
            if (req.method === 'GET' && p === '/preview') {
              return send(res, 200, await service.preview(url.searchParams.get('id') || '', Number(url.searchParams.get('count') || 4)));
            }
            return send(res, 404, { error: 'not found' });
          } catch (e) {
            return send(res, 500, { error: e && e.message ? e.message : String(e) });
          }
        },
      }), 'archiveCenter.http');
    });
  } catch { /* webServer absent — client uses the service proxy path */ }
}
