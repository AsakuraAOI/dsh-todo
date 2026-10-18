export function normalizeDueAt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('截止时间需为带时区的 ISO 日期时间，或 null（取消倒计时）。');
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const stamp = Date.parse(value);
  if (!match || !Number.isFinite(stamp) || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate()) throw new Error('截止时间无效，请提供带时区的 ISO 日期时间。');
  return new Date(stamp).toISOString();
}

export function sortTodos(items) {
  const due = item => item.dueAt ? Date.parse(item.dueAt) : Infinity;
  return [...items].sort((a, b) => {
    const left = due(a), right = due(b);
    if (left !== right) return left < right ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
  });
}

export function formatCountdown(dueAt, now = Date.now()) {
  const diff = Date.parse(dueAt) - now;
  const seconds = Math.ceil(Math.abs(diff) / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  const pad = number => String(number).padStart(2, '0');
  return `${diff < 0 ? '已超时' : '剩余'} ${days ? days + '天 ' : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`;
}
