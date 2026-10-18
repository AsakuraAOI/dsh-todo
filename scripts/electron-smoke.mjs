import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TodoWindow } from '../src/window.js';
import { TodoStore } from '../src/store.js';
const root = await mkdtemp(join(tmpdir(), 'dsh-todo-window-'));
const reports = resolve(import.meta.dirname, '../../reports/dsh-todo'); await mkdir(reports, { recursive: true });
const executable = process.env.DSH_DESKTOP_NODE_EXECUTABLE || join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const popup = new TodoWindow(new TodoStore(join(root, 'todos.json')), root, { executable, smokeReport: join(reports, 'native.json'), diagnostics: true });
try {
  await popup.open();
  const child = popup.child;
  const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => { popup.dispose(); reject(new Error('Smoke timed out')); }, 45000); child.once('exit', code => { clearTimeout(timer); resolve(code); }); });
  const report = JSON.parse(await readFile(join(reports, 'native.json'), 'utf8'));
  console.log(JSON.stringify({ ...report, fixture: root }, null, 2));
  if (code !== 0 || !report.success || !report.close) process.exitCode = 1;
} finally { popup.dispose(); }
