import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeDueAt, sortTodos } from './time.js';

export const STATUSES = ['active', 'completed', 'ended'];
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, label, max, empty = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (!empty && !value.trim())) throw fail(`${label}需为${empty ? '不超过' : '1 至'} ${max} 字的文字。`);
  return value.trim();
};

export class TodoStore {
  constructor(file) { this.file = file; }
  async list() {
    let data;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { revision: 0, items: [] }; throw fail('待办数据读取失败，请保留原文件并检查文件内容及权限。', 500); }
    const valid = data?.format === 1 && Number.isSafeInteger(data.revision) && data.revision >= 0 && Array.isArray(data.items) && data.items.every(item =>
      item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.notes === 'string' && STATUSES.includes(item.status) &&
      (item.details === undefined || typeof item.details === 'string') &&
      Number.isSafeInteger(item.version) && item.version > 0 && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string');
    if (!valid || new Set(data.items.map(item => item.id)).size !== data.items.length) throw fail('待办数据格式无效，已停止写入以保护原数据。', 500);
    try { data.items = data.items.map(item => ({ ...item, dueAt: normalizeDueAt(item.dueAt), details: item.details ?? item.notes,
      notes: item.details === undefined ? item.notes.replace(/\s+/g, ' ').slice(0, 180) : item.notes })); }
    catch { throw fail('待办截止时间数据无效，已停止写入以保护原数据。', 500); }
    return { revision: data.revision, items: sortTodos(data.items) };
  }
  async lock() {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    for (let i = 0; i < 100; i++) {
      let handle;
      try {
        handle = await open(lock, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        return async () => { await handle.close(); await unlink(lock).catch(() => {}); };
      } catch (error) {
        if (handle) { await handle.close(); await unlink(lock).catch(() => {}); throw error; }
        if (error.code !== 'EEXIST') throw error;
        // Recover only locks whose owning process has exited. Never steal a live writer's lock.
        try {
          const pid = Number(await readFile(lock, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') await unlink(lock).catch(() => {}); }
          } else if (Date.now() - (await stat(lock)).mtimeMs > 30000) await unlink(lock).catch(() => {});
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    throw fail('待办正在保存，请稍后重试。', 409);
  }
  async mutate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('需要待办操作参数。');
    const { action } = args;
    if (!['add', 'update', 'complete', 'reopen', 'end'].includes(action)) throw fail('不支持的待办操作。');
    if (args.expectedVersion !== undefined && (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 1)) throw fail('待办版本必须为正整数。');
    let dueAt;
    if (Object.hasOwn(args, 'dueAt')) {
      try { dueAt = normalizeDueAt(args.dueAt); } catch (error) { throw fail(error.message); }
    }
    const release = await this.lock();
    let temporary;
    try {
      const data = await this.list(), now = new Date().toISOString();
      let item;
      if (action === 'add') {
        if (data.items.length >= 10000) throw fail('待办已达 10000 条上限。');
        item = { id: randomUUID(), title: text(args.title, '标题', 300), notes: text(args.notes ?? '', '简短描述', 200, true), details: text(args.details ?? '', '详情', 20000, true), dueAt: dueAt ?? null, status: 'active', version: 1, createdAt: now, updatedAt: now };
        data.items.unshift(item);
      } else {
        item = data.items.find(row => row.id === args.id);
        if (!item) throw fail('待办不存在，请刷新清单。', 404);
        if (args.expectedVersion !== undefined && args.expectedVersion !== item.version) throw fail('这条待办已在另一处更新，请刷新后重试。', 409);
        if (action === 'update') {
          if (args.title === undefined && args.notes === undefined && args.details === undefined && dueAt === undefined) throw fail('请提供要修改的标题、描述、详情或截止时间。');
          if (args.title !== undefined) item.title = text(args.title, '标题', 300);
          if (args.notes !== undefined) item.notes = text(args.notes, '简短描述', 200, true);
          if (args.details !== undefined) item.details = text(args.details, '详情', 20000, true);
          if (dueAt !== undefined) item.dueAt = dueAt;
        } else item.status = { complete: 'completed', reopen: 'active', end: 'ended' }[action];
        item.version++; item.updatedAt = now;
      }
      data.revision++;
      data.items = sortTodos(data.items);
      temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ format: 1, ...data }, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, this.file);
      return { ...data, item };
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await release();
    }
  }
}
