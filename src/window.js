import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { access, mkdir, readdir, stat, link, copyFile, writeFile, symlink, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fail } from './store.js';
import { normalizeTheme } from './theme.js';

const nativeRoot = fileURLToPath(new URL('../native/', import.meta.url));
export async function prepareRuntime(root, executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE || (process.versions.electron ? process.execPath : undefined)) {
  if (process.platform !== 'win32' || !executable) throw fail('独立窗口需要 Windows 桌面版 DSH；主页面与 Agent 待办工具仍可使用。', 503);
  const info = await stat(executable), source = dirname(executable);
  const key = createHash('sha256').update(`${resolve(executable)}:${info.size}:${info.mtimeMs}:${info.ino}`).digest('hex').slice(0, 16);
  const directory = join(root, 'runtime', key), app = join(directory, 'resources', 'app'), target = join(directory, 'TodoWindow.exe');
  await mkdir(app, { recursive: true });
  // Private launcher: reuse installed runtime files without touching the desktop installation.
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || (entry.name !== executable.split(/[\\/]/).at(-1) && !/\.(dll|pak|bin|dat)$/i.test(entry.name))) continue;
    const from = join(source, entry.name), to = join(directory, entry.name === executable.split(/[\\/]/).at(-1) ? 'TodoWindow.exe' : entry.name);
    try { await access(to); } catch {
      try { await link(from, to); } catch (error) { if (error.code !== 'EEXIST') await copyFile(from, to); }
    }
  }
  try { await access(join(directory, 'locales')); } catch {
    try { await symlink(join(source, 'locales'), join(directory, 'locales'), 'junction'); }
    catch { await cp(join(source, 'locales'), join(directory, 'locales'), { recursive: true }); }
  }
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'dsh-todo-window', version: '0.1.0', main: 'main.cjs' }));
  await writeFile(join(app, 'main.cjs'), `require(${JSON.stringify(join(nativeRoot, 'main.cjs'))});\n`);
  return target;
}

export class TodoWindow {
  constructor(store, root, options = {}) { this.store = store; this.root = root; this.options = options; this.commands = []; this.disposed = false; this.theme = { colorScheme: 'light', tokens: {} }; this.themeRevision = 0; }
  setTheme(theme) {
    let next; try { next = normalizeTheme(theme); } catch (error) { throw fail(error.message); }
    if (JSON.stringify(next) !== JSON.stringify(this.theme)) { this.theme = next; this.themeRevision++; }
    return { synced: true };
  }
  open(theme) {
    if (this.disposed) return Promise.reject(fail('待办插件已停用。', 503));
    if (theme !== undefined) this.setTheme(theme);
    if (this.child && this.ready) { this.commands.push('focus'); return Promise.resolve({ opened: true }); }
    if (!this.pending) this.pending = this.launch().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async launch() {
    const executable = await prepareRuntime(this.root, this.options.executable);
    if (this.disposed) throw fail('待办插件已停用。', 503);
    const token = randomBytes(32).toString('hex');
    const server = createServer(async (req, res) => {
      const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
      const auth = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (req.method !== 'POST' || req.url !== '/rpc' || req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) { send({ error: '拒绝访问。' }, 403); return; }
      try {
        let length = 0, chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > 200000) throw fail('请求过大。', 413); chunks.push(chunk); }
        const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (args.kind === 'ready') { this.ready = true; this.onReady?.(); send({ ok: true }); }
        else if (args.kind === 'heartbeat') send({ commands: this.commands.splice(0), theme: this.theme, themeRevision: this.themeRevision });
        else if (args.kind === 'theme') send({ theme: this.theme, themeRevision: this.themeRevision });
        else if (args.kind === 'fixture-theme' && this.options.smokeReport) send(this.setTheme(args.input));
        else if (args.kind === 'list') send(await this.store.list());
        else if (args.kind === 'mutate') send(await this.store.mutate(args.input));
        else send({ error: '无此操作。' }, 400);
      } catch (error) { send({ error: error.message }, error.status || 500); }
    });
    this.server = server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (this.disposed) { server.close(); throw fail('待办插件已停用。', 503); }
    this.ready = false; this.commands = [];
    const env = { ...process.env, DSH_TODO_ENDPOINT: `http://127.0.0.1:${server.address().port}/rpc`, DSH_TODO_TOKEN: token, DSH_TODO_DATA_ROOT: this.root };
    delete env.ELECTRON_RUN_AS_NODE;
    if (this.options.smokeReport) env.DSH_TODO_SMOKE_REPORT = this.options.smokeReport;
    const child = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    // Drain Electron diagnostics; do not persist inherited environment or bridge credentials.
    child.stderr.on('data', chunk => { if (this.options.diagnostics) process.stderr.write(chunk); });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(fail('独立待办窗口启动超时，请重试。', 503)); }, 25000);
      this.onReady = () => { clearTimeout(timer); resolve({ opened: true }); };
      const cleanup = () => { clearTimeout(timer); server.close(); if (this.child === child) { this.child = undefined; this.server = undefined; this.ready = false; this.onReady = undefined; } };
      child.once('error', error => { cleanup(); reject(fail(`独立窗口无法启动：${error.message}`, 503)); });
      child.once('exit', () => { const ready = this.ready; cleanup(); if (!ready) reject(fail('独立待办窗口在启动前退出。', 503)); });
    });
  }
  dispose() { this.disposed = true; this.child?.kill(); this.server?.close(); }
}
