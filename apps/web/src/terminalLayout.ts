export type PaneOrientation = "columns" | "rows";

export type TerminalLayout = {
  version: 1;
  open: string[];
  focused: string | null;
  orientation: PaneOrientation;
  sizes: number[];
  maximized: string | null;
};

export const MAX_PANES = 4;

export const emptyLayout = (): TerminalLayout => ({
  version: 1,
  open: [],
  focused: null,
  orientation: "columns",
  sizes: [],
  maximized: null,
});

const equalSizes = (count: number): number[] => count === 0 ? [] : Array.from({ length: count }, () => 1 / count);

export function normalizeSizes(values: number[], count: number): number[] {
  if (count === 0) return [];
  if (values.length !== count || values.some(value => !Number.isFinite(value) || value <= 0)) return equalSizes(count);
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map(value => value / total);
}

export function addPane(layout: TerminalLayout, id: string): { layout: TerminalLayout; added: boolean } {
  if (layout.open.includes(id)) return { layout: { ...layout, focused: id, maximized: null }, added: false };
  if (layout.open.length >= MAX_PANES) return { layout, added: false };
  const open = [...layout.open, id];
  return { layout: { ...layout, open, focused: id, sizes: equalSizes(open.length), maximized: null }, added: true };
}

export function removePane(layout: TerminalLayout, id: string): TerminalLayout {
  const index = layout.open.indexOf(id);
  if (index < 0) return layout;
  const open = layout.open.filter(value => value !== id);
  const focused = layout.focused === id ? open[Math.min(index, open.length - 1)] ?? null : layout.focused;
  return { ...layout, open, focused, sizes: equalSizes(open.length), maximized: layout.maximized === id ? null : layout.maximized };
}

export function movePane(layout: TerminalLayout, id: string, direction: -1 | 1): TerminalLayout {
  const from = layout.open.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= layout.open.length) return layout;
  const open = [...layout.open];
  [open[from], open[to]] = [open[to]!, open[from]!];
  const sizes = [...layout.sizes];
  [sizes[from], sizes[to]] = [sizes[to]!, sizes[from]!];
  return { ...layout, open, sizes };
}

export function sanitizeLayout(layout: TerminalLayout, validIds: ReadonlySet<string>): TerminalLayout {
  const open = layout.open.filter((id, index) => validIds.has(id) && layout.open.indexOf(id) === index).slice(0, MAX_PANES);
  const focused = layout.focused && open.includes(layout.focused) ? layout.focused : open[0] ?? null;
  return {
    version: 1,
    open,
    focused,
    orientation: layout.orientation === "rows" ? "rows" : "columns",
    sizes: normalizeSizes(layout.sizes, open.length),
    maximized: layout.maximized && open.includes(layout.maximized) ? layout.maximized : null,
  };
}

const storageKey = (projectId: string) => `rvmp:terminal-layout:${projectId}`;

export function loadLayout(projectId: string): TerminalLayout {
  if (typeof localStorage === "undefined") return emptyLayout();
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "null");
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.open)) return emptyLayout();
    return sanitizeLayout(parsed as TerminalLayout, new Set(parsed.open.filter((id: unknown): id is string => typeof id === "string")));
  } catch {
    return emptyLayout();
  }
}

export function saveLayout(projectId: string, layout: TerminalLayout): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(storageKey(projectId), JSON.stringify(layout));
}
