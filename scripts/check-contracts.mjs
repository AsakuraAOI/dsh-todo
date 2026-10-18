// Run with the installed Desktop Electron in Node mode to inspect its actual contracts.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { apply } from '../src/index.js';
const install = process.env.DSH_DESKTOP_DIR || join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness');
if (!process.versions.electron) {
  const result = spawnSync(join(install, 'DeepSeek Harness.exe'), [import.meta.filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const base = join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai');
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(join(base, 'dsh-tools/lib/index.js')));
const tools = new Map(), disposers = [];
apply({ effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); }, tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, connection: { fetch: { register() { return () => {}; } } } });
try {
  for (const tool of tools.values()) { assertSupportedJsonSchema(tool.parameters); assertSupportedJsonSchema(tool.output.schema); }
  assert.deepEqual(validateJsonSchemaValue(tools.get('todo_update').parameters, { id: 'x', action: 'end', expectedVersion: 1 }), []);
  const sidebar = await readFile(join(base, 'dsh-client-ui-sidebar/lib/client.js'), 'utf8');
  const manager = await readFile(join(base, 'dsh-client-ui-plugin-manager/lib/client.js'), 'utf8');
  assert.ok(sidebar.includes('"sidebar.panellist"') && sidebar.includes('selectPanel(id)'));
  assert.ok(manager.includes('name: "main"') && manager.includes('key: PANEL_ID'));
  const theme = await readFile(join(base, 'dsh-client-ui-theme/lib/client.js'), 'utf8');
  assert.ok(theme.includes('ctx.provide("theme", theme)') && theme.includes('getTheme()') && theme.includes('"theme/change"'));
  const builtinTodo = await readFile(join(base, 'dsh-tool-todo/lib/index.js'), 'utf8');
  for (const name of tools.keys()) assert.ok(!builtinTodo.includes(`name: "${name}"`), 'Must not collide with built-in tools');
  console.log(JSON.stringify({ success: true, schemas: tools.size, sidebarPanelContract: true, mainPanelContract: true, noBuiltinToolCollision: true }));
} finally { for (const dispose of disposers.reverse()) dispose(); }
