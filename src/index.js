import { homedir } from 'node:os';
import { join } from 'node:path';
import { TodoStore, fail } from './store.js';
import { TodoWindow } from './window.js';

export const name = 'dsh-todo';
export const inject = ['tools', 'connection'];
export const ROUTE = '/api/plugins/dsh-todo';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw fail('需要 JSON 请求。', 415);
  const reader = request.body?.getReader();
  if (!reader) throw fail('缺少请求正文。');
  const chunks = []; let length = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 200000) { await reader.cancel(); throw fail('请求过大。', 413); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (error.status) throw error; throw fail('请求 JSON 格式无效。'); }
  finally { reader.releaseLock(); }
}

export function createHandler(store, popup) {
  return async request => {
    const url = new URL(request.url), path = url.pathname.slice(ROUTE.length);
    try {
      if (request.method === 'GET' && path === '/items') return json(await store.list());
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw fail('拒绝跨站待办操作。', 403);
        const body = await readBody(request);
        if (path === '/items') return json(await store.mutate(body));
        if (path === '/window') return json(body.action === 'theme' ? popup.setTheme(body.theme) : await popup.open(body.theme));
      }
      return json({ error: '没有此待办接口。' }, 404);
    } catch (error) { return json({ error: error.message || '待办操作失败。' }, error.status || 500); }
  };
}

export function apply(ctx) {
  const root = join(homedir(), '.dsh', 'storages', 'dsh-todo');
  const store = new TodoStore(join(root, 'todos.json')), popup = new TodoWindow(store, root);
  ctx.effect(() => () => popup.dispose());
  const handler = createHandler(store, popup);
  for (const [path, methods] of [['/items', ['GET', 'POST']], ['/window', ['POST']]]) ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE + path, methods, requestBody: 'buffered', fetch: handler }));
  const str = description => ({ type: 'string', description });
  const register = (toolName, description, properties, required, run) => ctx.effect(() => ctx.tools.register({
    name: toolName, description, parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: async (args = {}) => run(args),
  }));
  register('todo_list', '读取用户的全局持久待办清单，供用户和 Agent 共用。与会话内部的任务计划不同。默认只列进行中的待办。', { status: { type: 'string', enum: ['active', 'completed', 'ended', 'all'] } }, [], async ({ status = 'active' }) => {
    const data = await store.list();
    if (!['active', 'completed', 'ended', 'all'].includes(status)) throw fail('不支持的待办状态。');
    return { ...data, items: data.items.filter(item => status === 'all' || item.status === status) };
  });
  const change = async args => { const { item, revision } = await store.mutate(args); return { item, revision }; };
  const dueAt = { oneOf: [{ type: 'string' }, { type: 'null' }], description: '可选倒计时的截止时间，带时区的 ISO 日期时间（如 2026-10-18T18:00:00+08:00）。省略保留现状，null 取消倒计时。列表默认按截止时间从早到晚排序，无截止时间的放最后。' };
  register('todo_add', '向用户的待办清单添加一项，可选设置倒计时截止时间。标题和描述保持简短，完整内容放 details。仅在用户要求记录待办时使用，不把 Agent 自己的执行步骤加入用户清单。', { title: str('简短待办标题，最多 300 字。'), notes: str('可选的简短描述，最多 200 字；完整内容请放 details。'), details: str('可选完整详情，最多 20000 字，支持换行；点击待办后查看。'), dueAt }, ['title'], args => change({ ...args, action: 'add' }));
  register('todo_update', '修改一条用户待办的标题、简短描述、完整详情或状态。先用 todo_list 取得 id 和 version。complete=已完成；end=不再继续，保留记录；reopen=恢复进行中。', {
    id: str('todo_list 返回的待办 id。'), action: { type: 'string', enum: ['update', 'complete', 'end', 'reopen'] }, title: str('新标题，保持简短。'), notes: str('简短描述，最多 200 字，空字符串清空。'), details: str('完整详情，最多 20000 字，空字符串清空。'), dueAt, expectedVersion: { type: 'integer', description: '读取到的正整数 version，防止覆盖另一处的新修改。' },
  }, ['id', 'action', 'expectedVersion'], change);
}
