// Shared display formatting (vscode-free so pure modules can import it).

export function fmtNum(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "k";
  }
  return String(n);
}

// Compact by design ("2h", not "2h ago") — session rows have ~30 chars of
// description before the sidebar clips them.
export function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h`;
  }
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
