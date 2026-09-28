/**
 * dsh-archive-center — Client half.
 *
 * Registers a Settings section (归档会话) listing archived conversations with
 * search, restore-and-open, conversation preview, and hard delete.
 *
 * RPC: prefers the host `archiveCenter` service proxy; every response is
 * strictly unwrapped ({ok, value} envelope or bare object) and validated, so a
 * shape mismatch surfaces as an error instead of a silent empty list. Falls
 * back to the host's /archive-center/api/* HTTP routes.
 */

export const inject = ['slots', 'sessions', 'timer', 'locale'];

const React = typeof require !== 'undefined' ? require('react') : globalThis.React;

const I18N = {
  zh: {
    label: '归档会话',
    searchPlaceholder: '搜索名称 / 目录 / id / 正文…',
    hint: '空输入列出全部归档；输入关键词会同时检索会话正文（FTS5，不可用时自动逐会话扫描）。',
    countAll: (n) => `共 ${n} 个归档会话`,
    countMatch: (n) => `匹配 ${n} 个归档会话`,
    diagEmpty: '归档集当前为空：在侧边栏会话菜单里「归档」过的会话会出现在这里。',
    diagStale: (total, stale) => `有 ${total} 条归档记录，其中 ${stale} 条对应的会话日志已不存在（可能是之前清理数据留下的残留），已从列表中隐藏。`,
    cleanupStale: '清理失效记录',
    errorCleanup: (m) => `清理失败: ${m}`,
    confirmDelete: '确认彻底删除？日志目录会从磁盘移除，不可恢复。',
    cancel: '取消',
    restoreOpen: '恢复并打开',
    remove: '彻底删除',
    deleting: '删除中…',
    loading: '加载中…',
    searching: '搜索中…',
    searchingSuffix: ' · 搜索中…',
    empty: '没有已归档的会话。',
    emptyMatch: '无匹配结果。',
    previewTitle: '点击展开最近对话预览',
    previewLoading: '加载预览中…',
    previewEmpty: '无可预览的对话消息',
    roleUser: '用户',
    roleAssistant: 'AI',
    unknownWorkspace: '(未知工作区)',
    errorLoad: (m) => `加载失败: ${m}`,
    errorSearch: (m) => `搜索失败: ${m}`,
    errorRestore: (m) => `恢复失败: ${m}`,
    errorDelete: (m) => `删除失败: ${m}`,
  },
  en: {
    label: 'Archived Sessions',
    searchPlaceholder: 'Search title / directory / id / content…',
    hint: 'Empty input lists all archives; keywords also search conversation content (FTS5, per-session scan fallback).',
    countAll: (n) => `${n} archived session(s)`,
    countMatch: (n) => `${n} match(es)`,
    diagStale: (total, stale) => `${total} archive record(s), but ${stale} reference conversation logs that no longer exist (leftovers from an earlier data cleanup). They are hidden from the list.`,
    cleanupStale: 'Clean up stale records',
    errorCleanup: (m) => `Cleanup failed: ${m}`,
    diagEmpty: 'The archive set is empty: sessions you "Archive" from the sidebar appear here.',
    confirmDelete: 'Hard-delete? The log directory is removed from disk. This cannot be undone.',
    cancel: 'Cancel',
    restoreOpen: 'Restore & open',
    remove: 'Hard delete',
    deleting: 'Deleting…',
    loading: 'Loading…',
    searching: 'Searching…',
    searchingSuffix: ' · searching…',
    empty: 'No archived sessions.',
    emptyMatch: 'No matches.',
    previewTitle: 'Click to toggle a short conversation preview',
    previewLoading: 'Loading preview…',
    previewEmpty: 'No previewable messages',
    roleUser: 'User',
    roleAssistant: 'AI',
    unknownWorkspace: '(unknown workspace)',
    errorLoad: (m) => `Load failed: ${m}`,
    errorSearch: (m) => `Search failed: ${m}`,
    errorRestore: (m) => `Restore failed: ${m}`,
    errorDelete: (m) => `Delete failed: ${m}`,
  },
};

function localeId(ctx) {
  try {
    const snap = ctx.locale?.getLocale?.();
    if (snap && typeof snap.active === 'string') return snap.active.toLowerCase().startsWith('en') ? 'en' : 'zh';
  } catch {}
  const lang = (typeof navigator !== 'undefined' && navigator.language) || '';
  return String(lang).toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/** Unwrap {ok, value} envelopes and validate the rows payload; never return a fake empty list. */
function unwrapRows(r) {
  let v = r;
  if (v && typeof v === 'object' && 'ok' in v) {
    if (v.ok !== true) {
      const err = v.error;
      throw new Error(typeof err === 'string' ? err : (err && (err.message || err.code)) || 'remote failure');
    }
    v = v.value;
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.rows)) {
    throw new Error(`响应结构异常: ${JSON.stringify(v).slice(0, 160)}`);
  }
  return v;
}

export function apply(ctx) {
  const slots = ctx.slots ?? ctx.get('slots');
  const sessions = ctx.sessions ?? ctx.get('sessions');
  const timer = ctx.timer ?? ctx.get('timer');
  if (slots === undefined) return;

  const httpCall = (path, payload) => {
    const init = payload !== undefined
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : undefined;
    return fetch(path, init).then(async (res) => {
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    });
  };

  const getManager = () => {
    let proxied;
    try {
      proxied = ctx.archiveCenter ?? ctx.get('archiveCenter');
      if (proxied && typeof proxied.list !== 'function') proxied = undefined;
    } catch { proxied = undefined; }
    if (proxied) {
      return {
        list: async () => unwrapRows(await proxied.list()),
        search: async (o) => unwrapRows(await proxied.search(o || {})),
        unarchive: async (id) => unwrapOk(await proxied.unarchive(id)),
        remove: async (id) => unwrapOk(await proxied.delete(id)),
        removeMany: (ids) => proxied.deleteMany(ids),
        cleanupDangling: () => proxied.cleanupDangling(),
        preview: (id, n) => proxied.preview(id, n),
      };
    }
    return {
      list: () => httpCall('/archive-center/api/list').then(unwrapRows),
      search: (o) => httpCall('/archive-center/api/search', o || {}).then(unwrapRows),
      unarchive: (id) => httpCall('/archive-center/api/unarchive', { id }),
      remove: (id) => httpCall('/archive-center/api/delete', { id }),
      removeMany: (ids) => httpCall('/archive-center/api/deleteMany', { ids }),
      cleanupDangling: () => httpCall('/archive-center/api/cleanup', {}),
      preview: (id, n) => httpCall(`/archive-center/api/preview?id=${encodeURIComponent(id)}&count=${n || 4}`),
    };
  };
  const unwrapOk = (r) => {
    if (r && typeof r === 'object' && 'ok' in r && r.ok !== true) {
      const err = r.error;
      throw new Error(typeof err === 'string' ? err : (err && (err.message || err.code)) || 'remote failure');
    }
    return r && typeof r === 'object' && 'value' in r ? r.value : r;
  };

  const fmtDate = (ms) => {
    if (!ms) return '';
    try { return new Date(ms).toLocaleString(); } catch { return ''; }
  };

  function ArchivedList({ close }) {
    const [rows, setRows] = React.useState([]);
    const [diagnostics, setDiagnostics] = React.useState(null);
    const [query, setQuery] = React.useState('');
    const [busyId, setBusyId] = React.useState(undefined);
    const [confirmId, setConfirmId] = React.useState(undefined);
    const [previewId, setPreviewId] = React.useState(undefined);
    const [preview, setPreview] = React.useState(undefined);
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [searching, setSearching] = React.useState(false);
    const searchTimer = React.useRef(null);

    const t = I18N[localeId(ctx)] || I18N.zh;
    // Stable across renders: a fresh object each render would change the
    // search callback identity every frame and loop the debounce effect
    // (the constant text flicker).
    const mRef = React.useRef(undefined);
    if (mRef.current === undefined) mRef.current = getManager();
    const m = mRef.current;

    const refresh = React.useCallback(async () => {
      setLoading(true);
      setError('');
      try {
        const r = await m.list();
        setRows(r.rows);
        setDiagnostics(r.diagnostics || null);
      } catch (e) {
        setError(t.errorLoad(e && e.message ? e.message : String(e)));
      } finally {
        setLoading(false);
      }
    }, [t]);

    const runSearch = React.useCallback(async (q) => {
      const trimmed = String(q || '').trim();
      if (!trimmed) { await refresh(); return; }
      setSearching(true);
      setError('');
      try {
        const r = await m.search({ query: trimmed, limit: 50 });
        setRows(r.rows);
        setDiagnostics(r.diagnostics || null);
      } catch (e) {
        setError(t.errorSearch(e && e.message ? e.message : String(e)));
      } finally {
        setSearching(false);
      }
    }, [refresh, t, m]);

    React.useEffect(() => { refresh(); }, [refresh]);
    React.useEffect(() => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => { runSearch(query); }, 300);
      return () => clearTimeout(searchTimer.current);
    }, [query, runSearch]);

    const doRestore = async (id) => {
      setBusyId(id); setError('');
      try {
        await m.unarchive(id);
        setConfirmId(undefined);
        if (close) close();
        timer.timeout(() => { try { sessions.open(id); } catch {} }, 300);
      } catch (e) {
        setError(t.errorRestore(e && e.message ? e.message : String(e)));
      } finally { setBusyId(undefined); }
    };

    const doDelete = async (id) => {
      setBusyId(id); setError('');
      try {
        await m.remove(id);
        setConfirmId(undefined);
        if (previewId === id) { setPreviewId(undefined); setPreview(undefined); }
        await runSearch(query);
      } catch (e) {
        setError(t.errorDelete(e && e.message ? e.message : String(e)));
      } finally { setBusyId(undefined); }
    };

    const togglePreview = async (id) => {
      if (previewId === id) { setPreviewId(undefined); setPreview(undefined); return; }
      setPreviewId(id); setPreview({ state: 'loading', messages: [] });
      try {
        const r = await m.preview(id, 4);
        const messages = (r && r.messages) || [];
        setPreview(messages.length > 0 ? { state: 'ready', messages } : { state: 'empty', messages: [] });
      } catch {
        setPreview({ state: 'empty', messages: [] });
      }
    };

    const grouped = React.useMemo(() => {
      const groups = new Map();
      for (const row of rows) {
        const key = row.workspace || t.unknownWorkspace;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      return [...groups.entries()];
    }, [rows, t]);

    const countText = loading ? '' : (String(query).trim() ? t.countMatch(rows.length) : t.countAll(rows.length));

    const body = loading
      ? React.createElement('div', { className: 'dsac-row-dim' }, t.loading)
      : rows.length === 0
        ? React.createElement('div', { className: 'dsac-row-dim' },
            error ? null : (query.trim() ? t.emptyMatch : t.empty))
        : grouped.map(([workspace, items]) => React.createElement('div', { key: workspace, className: 'dsac-group' },
            React.createElement('div', { className: 'dsac-group-header' },
              React.createElement('span', { className: 'dsac-group-name' }, workspace),
              React.createElement('span', { className: 'dsac-group-count' }, `${items.length}`)),
            items.map((row) => React.createElement('div', { key: row.id, className: 'dsac-item' },
              React.createElement('div', { className: 'dsac-meta' },
                React.createElement('div', {
                  className: 'dsac-title' + (preview ? ' expandable' : ''),
                  title: t.previewTitle,
                  onClick: () => togglePreview(row.id),
                }, row.title || row.id),
                React.createElement('div', { className: 'dsac-sub' },
                  [row.cwd || '', fmtDate(row.createdAt), row.agentPreset].filter(Boolean).join(' · ')),
                previewId === row.id && preview
                  ? React.createElement('div', { className: 'dsac-preview' },
                      preview.state === 'loading' ? t.previewLoading
                        : preview.state === 'empty' ? t.previewEmpty
                          : preview.messages.map((msg, i) => React.createElement('div', { key: i, className: 'dsac-preview-line' },
                              React.createElement('span', { className: msg.role === 'user' ? 'dsac-role-user' : 'dsac-role-ai' },
                                msg.role === 'user' ? t.roleUser : t.roleAssistant),
                              '：' + msg.text)))
                  : null),
              confirmId === row.id
                ? React.createElement('div', { className: 'dsac-actions' },
                    React.createElement('span', { className: 'dsac-confirm-text' }, t.confirmDelete),
                    React.createElement('button', {
                      className: 'dsac-btn danger', disabled: busyId === row.id,
                      onClick: () => doDelete(row.id),
                    }, busyId === row.id ? t.deleting : t.remove),
                    React.createElement('button', {
                      className: 'dsac-btn', disabled: busyId === row.id,
                      onClick: () => setConfirmId(undefined),
                    }, t.cancel))
                : React.createElement('div', { className: 'dsac-actions' },
                    React.createElement('button', {
                      className: 'dsac-btn primary', disabled: busyId === row.id,
                      onClick: () => doRestore(row.id),
                    }, t.restoreOpen),
                    React.createElement('button', {
                      className: 'dsac-btn danger', disabled: busyId === row.id,
                      onClick: () => setConfirmId(row.id),
                    }, t.remove))))));

    const diagText = (() => {
      if (loading || error || !diagnostics) return '';
      if ((diagnostics.registryCount || 0) === 0) return t.diagEmpty;
      const readable = rows.length;
      if (readable === 0 && (diagnostics.missingCount || 0) > 0) {
        return t.diagStale(diagnostics.registryCount, diagnostics.missingCount);
      }
      return '';
    })();
    const showCleanup = !loading && diagnostics && (diagnostics.missingCount || 0) > 0;

    const doCleanup = async () => {
      setError('');
      try {
        const r = await m.cleanupDangling();
        if (r && r.removed > 0) await runSearch(query);
      } catch (e) {
        setError(t.errorCleanup(e && e.message ? e.message : String(e)));
      }
    };

    return React.createElement('div', { className: 'dsac-root' },
      React.createElement('style', null, CSS),
      React.createElement('input', {
        className: 'dsac-search', type: 'text', placeholder: t.searchPlaceholder,
        value: query, onChange: (e) => setQuery(e.target.value),
      }),
      React.createElement('div', { className: 'dsac-hint' }, t.hint),
      React.createElement('div', { className: 'dsac-count' }, countText + (searching ? t.searchingSuffix : '')),
      diagText ? React.createElement('div', { className: 'dsac-diag' }, diagText,
        showCleanup
          ? React.createElement('button', { className: 'dsac-btn', style: { marginLeft: '8px' }, onClick: doCleanup }, t.cleanupStale)
          : null)
        : null,
      error ? React.createElement('div', { className: 'dsac-error' }, error) : null,
      React.createElement('div', { className: 'dsac-list' }, body));
  }

  const CSS = [
    '.dsac-root{display:flex;flex-direction:column;gap:8px;}',
    '.dsac-search{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none;}',
    '.dsac-search:focus{border-color:var(--dsw-alias-brand-primary);}',
    '.dsac-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8;}',
    '.dsac-count{font-size:12px;color:var(--dsw-alias-label-secondary);}',
    '.dsac-diag{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;}',
    '.dsac-error{font-size:12px;color:var(--dsw-alias-danger, #c0392b);background:color-mix(in srgb, #c0392b 8%, transparent);border-radius:6px;padding:6px 8px;}',
    '.dsac-list{max-height:62vh;overflow:auto;}',
    '.dsac-row-dim{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px;}',
    '.dsac-group{margin-bottom:6px;}',
    '.dsac-group-header{display:flex;justify-content:space-between;padding:8px 8px 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l2);}',
    '.dsac-group-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dsac-group-count{opacity:.7;}',
    '.dsac-item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
    '.dsac-meta{min-width:0;flex:1;}',
    '.dsac-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dsac-title.expandable{cursor:pointer;}',
    '.dsac-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dsac-preview{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent);border-radius:6px;padding:6px 8px;display:flex;flex-direction:column;gap:4px;}',
    '.dsac-preview-line{line-height:1.5;}',
    '.dsac-role-user{color:var(--dsw-alias-brand-primary);font-weight:600;}',
    '.dsac-role-ai{font-weight:600;}',
    '.dsac-actions{display:flex;align-items:center;gap:8px;flex:none;}',
    '.dsac-confirm-text{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:220px;}',
    '.dsac-btn{padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
    '.dsac-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
    '.dsac-btn.danger{border-color:color-mix(in srgb, #c0392b 55%, transparent);color:#c0392b;}',
    '.dsac-btn:disabled{opacity:.5;cursor:default;}',
  ].join('');

  const makeRegistration = () => slots.register(
    { name: 'settings.section', id: 'archive-center', order: 80, label: (I18N[localeId(ctx)] || I18N.zh).label },
    (props) => React.createElement(ArchivedList, { close: props ? props.close : undefined }),
  );
  // Deferred registration: the factory runs only when the Settings page declares
  // settings.section — registering eagerly at apply time fails activation.
  ctx.effect(() => slots.inject('settings.section', () => {
    let dispose = makeRegistration();
    const refreshLabel = () => {
      try { dispose(); dispose = makeRegistration(); } catch {}
    };
    let off1, off2;
    try { off1 = ctx.on?.('locale/change', refreshLabel); } catch {}
    try { off2 = ctx.locale?.subscribe?.(refreshLabel); } catch {}
    return () => { try { off1?.(); } catch {} try { off2?.(); } catch {} try { dispose(); } catch {} };
  }), 'archiveCenter.settingsSection');
}
