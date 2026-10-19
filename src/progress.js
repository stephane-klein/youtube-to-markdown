export function formatDuration(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value < 1000) return `${Math.round(value)}ms`;

  const seconds = value / 1000;
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`;

  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  if (minutes < 60) return `${minutes}m ${String(rounded % 60).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function progressStats({ done, total, startedAt, now = performance.now() }) {
  const elapsed = Math.max(0, now - startedAt);
  const completed = Math.min(Math.max(done, 0), Math.max(total, 0));

  if (completed === 0 || total <= 0) return { elapsed, eta: null };

  return { elapsed, eta: (elapsed * (total - completed)) / completed };
}

export function progressLine({ label, done, total, startedAt, now }) {
  const { elapsed, eta } = progressStats({ done, total, startedAt, now });
  const parts = [`  ${label} ${done}/${total}`, `${formatDuration(elapsed)} elapsed`];

  if (eta !== null && eta > 0) parts.push(`~${formatDuration(eta)} left`);

  return parts.join("  ");
}
