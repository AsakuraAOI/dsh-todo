import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TodoStore } from '../src/store.js';
import { createHandler, ROUTE, apply } from '../src/index.js';
import { normalizeDueAt, sortTodos, formatCountdown } from '../src/time.js';
import { normalizeTheme } from '../src/theme.js';
import { TodoWindow } from '../src/window.js';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'dsh-todo-test-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 })); return new TodoStore(join(root, 'todos.json')); }

test('persistent lifecycle, version conflicts and restoration keep history', async t => {
  const store = await fixture(t);
  assert.deepEqual(await store.list(), { revision: 0, items: [] });
  let { item } = await store.mutate({ action: 'add', title: '中文待办', notes: '详细说明' });
  const firstVersion = item.version;
  ({ item } = await store.mutate({ action: 'complete', id: item.id, expectedVersion: item.version }));
  assert.equal(item.status, 'completed');
  await assert.rejects(store.mutate({ action: 'end', id: item.id, expectedVersion: firstVersion }), /另一处更新/);
  ({ item } = await store.mutate({ action: 'end', id: item.id, expectedVersion: item.version }));
  assert.equal(item.status, 'ended');
  ({ item } = await store.mutate({ action: 'reopen', id: item.id, expectedVersion: item.version }));
  ({ item } = await store.mutate({ action: 'update', id: item.id, title: '新的标题', notes: '' }));
  assert.equal(item.status, 'active'); assert.equal(item.notes, '');
  assert.deepEqual((await new TodoStore(store.file).list()).items, [item]);
});
test('independent store writers preserve all concurrent additions', async t => {
  const store = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => new TodoStore(store.file).mutate({ action: 'add', title: `事项 ${i}` })));
  const data = await store.list(); assert.equal(data.items.length, 20); assert.equal(data.revision, 20);
  assert.equal(new Set(data.items.map(row => row.id)).size, 20);
});
test('invalid input and corrupt persisted files never overwrite data', async t => {
  const store = await fixture(t);
  await assert.rejects(store.mutate({ action: 'add', title: ' ' }));
  await assert.rejects(store.mutate({ action: 'add', title: 'x'.repeat(301) }));
  await assert.rejects(store.mutate({ action: 'delete', id: 'missing' }));
  await assert.rejects(store.mutate({ action: 'end', id: 'missing', expectedVersion: -1 }), /正整数/);
  await store.mutate({ action: 'add', title: '保留' });
  await writeFile(store.file, '{damaged');
  await assert.rejects(store.mutate({ action: 'add', title: '不能写入' }), /读取失败/);
  assert.equal(await readFile(store.file, 'utf8'), '{damaged');
});
test('HTTP route validates origins, content and stale writes; window opening is separate', async t => {
  const store = await fixture(t); let opens = 0;
  const handle = createHandler(store, { open: async () => { opens++; return { opened: true }; } });
  const post = (path, body, headers = {}) => handle(new Request(`http://localhost${ROUTE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  assert.equal((await post('/items', { action: 'add', title: 'test' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/items', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/items', { action: 'add', title: 'first' })).status, 200);
  const { item } = await (await post('/items', { action: 'add', title: 'second' })).json();
  assert.equal((await post('/items', { action: 'end', id: item.id, expectedVersion: 99 })).status, 409);
  assert.equal((await post('/items', { action: 'add', title: 'x'.repeat(200001) })).status, 413);
  assert.equal((await post('/window', {})).status, 200); assert.equal(opens, 1);
  assert.equal((await (await handle(new Request(`http://localhost${ROUTE}/items`))).json()).items.length, 2);
});
test('host registers three distinct tools and two routes with cleanup', async () => {
  const tools = new Map(), routes = [], disposers = [];
  apply({ effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose); }, tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } });
  assert.deepEqual([...tools.keys()], ['todo_list', 'todo_add', 'todo_update']);
  assert.equal(routes.length, 2);
  assert.deepEqual(tools.get('todo_update').parameters.required, ['id', 'action', 'expectedVersion']);
  for (const dispose of disposers.reverse()) dispose(); assert.equal(tools.size, 0);
});

test('optional countdowns persist, sort soonest first, update and clear; legacy data is compatible', async t => {
  const store = await fixture(t);
  const none = (await store.mutate({ action: 'add', title: '无倒计时' })).item;
  const later = (await store.mutate({ action: 'add', title: '稍后', dueAt: '2026-10-20T12:00:00+08:00' })).item;
  const overdue = (await store.mutate({ action: 'add', title: '超时', dueAt: '2026-10-17T12:00:00Z' })).item;
  assert.deepEqual((await store.list()).items.map(item => item.id), [overdue.id, later.id, none.id]);
  await store.mutate({ action: 'update', id: none.id, dueAt: '2026-10-19T12:00:00Z' });
  assert.deepEqual((await new TodoStore(store.file).list()).items.map(item => item.id), [overdue.id, none.id, later.id]);
  await store.mutate({ action: 'update', id: overdue.id, dueAt: null });
  const data = await store.list(); assert.equal(data.items.at(-1).dueAt, null);
  const legacy = JSON.parse(await readFile(store.file, 'utf8'));
  for (const item of legacy.items) delete item.dueAt;
  await writeFile(store.file, JSON.stringify(legacy));
  assert.ok((await store.list()).items.every(item => item.dueAt === null));
  const before = await readFile(store.file, 'utf8');
  for (const dueAt of ['tomorrow', '2026-02-30T12:00:00Z', '2026-10-18T12:00', 123]) await assert.rejects(store.mutate({ action: 'add', title: '不能保存', dueAt }), /截止时间/);
  assert.equal(await readFile(store.file, 'utf8'), before);
});

test('countdowns cross zero into overdue without changing state, with stable untimed ordering', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  assert.equal(formatCountdown('2026-10-19T01:02:03Z', now), '剩余 1天 01:02:03');
  assert.equal(formatCountdown('2026-10-18T00:00:00Z', now), '剩余 00:00:00');
  assert.equal(formatCountdown('2026-10-17T23:59:58Z', now), '已超时 00:00:02');
  assert.equal(normalizeDueAt('2026-10-18T08:00:00+08:00'), '2026-10-18T00:00:00.000Z');
  const items = [{ id: 'b', createdAt: '2026-10-18T00:00:00Z' }, { id: 'a', createdAt: '2026-10-18T00:00:00Z' }];
  assert.deepEqual(sortTodos(items).map(item => item.id), ['a', 'b']);
  assert.equal(items[0].id, 'b');
});

test('short descriptions and full details update independently and preserve legacy long notes', async t => {
  const store = await fixture(t), details = '完整内容\n' + '具体操作步骤。'.repeat(2000);
  let { item } = await store.mutate({ action: 'add', title: '简短事项', notes: '一句话描述', details });
  assert.equal(item.details, details);
  ({ item } = await store.mutate({ action: 'update', id: item.id, notes: '修改描述' }));
  assert.equal(item.details, details);
  ({ item } = await store.mutate({ action: 'update', id: item.id, details: '' }));
  assert.equal(item.notes, '修改描述'); assert.equal(item.details, '');
  assert.deepEqual((await new TodoStore(store.file).list()).items, [item]);
  await assert.rejects(store.mutate({ action: 'update', id: item.id, notes: '字'.repeat(201) }), /简短描述/);
  await assert.rejects(store.mutate({ action: 'update', id: item.id, details: '字'.repeat(20001) }), /详情/);
  const old = JSON.parse(await readFile(store.file, 'utf8'));
  old.items[0].notes = '旧备注\n' + '请保留完整资料。'.repeat(300);
  delete old.items[0].details;
  await writeFile(store.file, JSON.stringify(old));
  const migrated = (await store.list()).items[0];
  assert.equal(migrated.details, old.items[0].notes); assert.ok(migrated.notes.length <= 180);
  await store.mutate({ action: 'complete', id: item.id });
  assert.equal((await store.list()).items[0].details, old.items[0].notes);
});

test('HTTP accepts long Chinese details within the field limit', async t => {
  const store = await fixture(t), handle = createHandler(store, {}), details = '中'.repeat(20000);
  const response = await handle(new Request(`http://localhost${ROUTE}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', title: '详情内容', notes: '简短', details }) }));
  assert.equal(response.status, 200); assert.equal((await response.json()).item.details, details);
});

test('theme sync updates the existing popup palette without opening a window', async t => {
  const store = await fixture(t), popup = new TodoWindow(store, join(tmpdir(), 'unused-todo-theme'));
  const handle = createHandler(store, popup);
  const theme = { colorScheme: 'dark', tokens: { '--dsw-alias-bg-layer-1': '#172337', '--dsw-alias-label-primary': 'rgb(235, 240, 250)', '--untrusted-property': 'red' } };
  const response = await handle(new Request(`http://localhost${ROUTE}/window`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'theme', theme }) }));
  assert.equal(response.status, 200); assert.equal(popup.child, undefined);
  assert.deepEqual(popup.theme, normalizeTheme(theme)); assert.ok(!Object.hasOwn(popup.theme.tokens, '--untrusted-property'));
  const revision = popup.themeRevision; popup.setTheme(theme); assert.equal(popup.themeRevision, revision);
  popup.setTheme({ colorScheme: 'light', tokens: {} }); assert.equal(popup.theme.colorScheme, 'light');
  for (const bad of [{ colorScheme: 'system', tokens: {} }, { colorScheme: 'dark', tokens: { '--dsw-alias-bg-layer-1': 'url(https://example.com)' } }, { colorScheme: 'light', tokens: { '--dsw-alias-label-primary': 'red; background: blue' } }]) assert.throws(() => normalizeTheme(bad));
});
