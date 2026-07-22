export function bindKeys(map: Record<string, () => void>): () => void {
  const h = (e: KeyboardEvent) => {
    if (e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.closest("[data-term]")) return;
    const key = e.key.toLowerCase();
    const fn = (e.metaKey || e.ctrlKey) ? map[`mod+${key}`] : map[key];
    if (fn) { e.preventDefault(); fn(); }
  };
  window.addEventListener("keydown", h);
  return () => window.removeEventListener("keydown", h);
}
