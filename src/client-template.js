window.__ModuleLoader__.load({
  id: 'dsh-todo',
  factory: require => {
    const React = require('react');
    /* TODO_THEME */
    /* TODO_UI */
    const mount = window.DSHTodoUI;
    let clientContext;
    function readTheme() {
      const theme = clientContext?.get?.('theme') || clientContext?.theme;
      const snapshot = theme?.getTheme?.();
      const colorScheme = snapshot?.active?.colorScheme || (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light');
      const computed = getComputedStyle(document.body), tokens = {};
      for (const name of THEME_TOKENS) { const value = computed.getPropertyValue(name).trim(); if (value) tokens[name] = value; }
      return normalizeTheme({ colorScheme, tokens });
    }
    async function request(path, body) {
      if (path === '/window' && !body?.action) body = { ...body, theme: readTheme() };
      const response = await fetch('/api/plugins/dsh-todo' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      let data;
      try { data = await response.json(); } catch { throw new Error('待办服务不可用，请确认插件已启用并重启 DSH。'); }
      if (!response.ok) throw new Error(data.error || `操作失败（${response.status}）`);
      return data;
    }
    function Page() {
      const ref = React.useRef(null);
      React.useEffect(() => mount(ref.current, { request }), []);
      return React.createElement('div', { ref, style: { height: '100%', minHeight: 0, overflow: 'hidden' } });
    }
    function Icon({ size = 16 }) {
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 4 }), React.createElement('path', { d: 'm7 12 3 3 7-7' }));
    }
    return { inject: ['slots', 'theme'], apply(ctx) {
      clientContext = ctx;
      ctx.effect?.(() => {
        let stopped = false, running = false, previous = '', pending;
        async function sync() {
          if (stopped || running) return;
          running = true;
          try { const theme = readTheme(), encoded = JSON.stringify(theme); if (encoded !== previous) { await request('/window', { action: 'theme', theme }); previous = encoded; } }
          catch { /* A host reconnect will be retried by the next theme snapshot. */ }
          finally { running = false; }
        }
        const schedule = () => { clearTimeout(pending); pending = setTimeout(sync, 0); };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        const dispose = ctx.on?.('theme/change', schedule);
        const timer = setInterval(sync, 1000); schedule();
        return () => { stopped = true; clearInterval(timer); clearTimeout(pending); observer.disconnect(); if (typeof dispose === 'function') dispose(); };
      });
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-todo' }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-todo', order: 45, label: '待办' }, Icon));
    } };
  },
});
