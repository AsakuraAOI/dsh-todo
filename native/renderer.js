let applied = [];
function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.todoTheme = theme.colorScheme;
  root.style.colorScheme = theme.colorScheme;
  for (const name of applied) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
  applied = Object.keys(theme.tokens);
}
window.todo.onTheme(applyTheme);
window.todo.theme().then(theme => {
  applyTheme(theme);
  window.DSHTodoUI(document.getElementById('app'), { compact: true, request: (path, body) => path === '/items' ? body === undefined ? window.todo.list() : window.todo.mutate(body) : window.todo.control(body.action) });
});
