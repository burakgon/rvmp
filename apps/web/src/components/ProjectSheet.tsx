import React, { useEffect, useMemo, useRef, useState } from "react";
import { CardAgent, type Card, type Project } from "@rvmp/protocol";
import { api } from "../api";

type DirectorySnapshot = {
  home: string;
  current: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  repository: null | { root: string; branch: string | null; isRoot: boolean };
};

const agentLabels: Record<Card["agent"], string> = {
  claude: "Claude", codex: "Codex", gemini: "Gemini", opencode: "OpenCode",
  aider: "Aider", amp: "Amp", goose: "Goose", generic: "Generic", none: "None",
};

const modeCopy: Record<Project["mode"], { title: string; detail: string; tone: string }> = {
  auto: { title: "Sandboxed", detail: "Use the agent's native workspace sandbox.", tone: "var(--green)" },
  host: { title: "YOLO / host", detail: "No sandbox or approval prompts. Full host access.", tone: "var(--red)" },
  ask: { title: "Ask every time", detail: "Let the agent show its normal permission prompts.", tone: "var(--amber)" },
};

const leaf = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || "project";
const joinPath = (parent: string, child: string): string => `${parent.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
const cloneLeaf = (url: string): string => leaf(url.trim().replace(/\.git$/, ""));

function DirectoryBrowser({ value, onChange, selectParent = false }: {
  value: string;
  onChange: (path: string, snapshot: DirectorySnapshot | null) => void;
  selectParent?: boolean;
}) {
  const [typed, setTyped] = useState(value);
  const [snapshot, setSnapshot] = useState<DirectorySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [activeEntry, setActiveEntry] = useState(0);
  const request = useRef(0);
  const entryButtons = useRef<Array<HTMLButtonElement | null>>([]);

  const browse = (path: string) => {
    const serial = ++request.current;
    setLoading(true);
    setError("");
    void api.get<DirectorySnapshot>(`/api/state/directories?path=${encodeURIComponent(path)}&hidden=${hidden ? "1" : "0"}`)
      .then(next => {
        if (request.current !== serial) return;
        setSnapshot(next);
        setActiveEntry(0);
        setTyped(next.current);
      })
      .catch(e => {
        if (request.current !== serial) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (request.current === serial) setLoading(false); });
  };

  useEffect(() => { browse(value || ""); /* initial/current value only */ }, []);
  useEffect(() => {
    if (snapshot) browse(snapshot.current);
  }, [hidden]);

  const crumbs = useMemo(() => {
    if (!snapshot) return [];
    const relative = snapshot.current.slice(snapshot.home.length).split("/").filter(Boolean);
    return [
      { label: "Home", path: snapshot.home },
      ...relative.map((label, index) => ({ label, path: `${snapshot.home}/${relative.slice(0, index + 1).join("/")}` })),
    ];
  }, [snapshot]);

  return (
    <div className="directory-browser">
      <div className="directory-address">
        <button type="button" className="icon-button" aria-label="Parent directory" disabled={!snapshot?.parent} onClick={() => snapshot?.parent && browse(snapshot.parent)}>↑</button>
        <input aria-label="Directory path" value={typed} onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") browse(typed); }} />
        <button type="button" className="secondary-button" disabled={loading || !typed.trim()} onClick={() => browse(typed)}>{loading ? "Opening…" : "Open"}</button>
        <button type="button" className="secondary-button" disabled={!typed.trim()} title="Use the exact path without listing it" onClick={() => onChange(typed.trim(), null)}>Use path</button>
      </div>
      {snapshot && (
        <>
          <nav className="directory-crumbs" aria-label="Directory breadcrumb">
            {crumbs.map((crumb, index) => (
              <React.Fragment key={crumb.path}>
                {index > 0 && <span aria-hidden="true">/</span>}
                <button type="button" onClick={() => browse(crumb.path)}>{crumb.label}</button>
              </React.Fragment>
            ))}
            <label className="hidden-toggle"><input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} /> hidden</label>
          </nav>
          <div className="directory-list" role="listbox" aria-label="Folders">
            {snapshot.entries.map((entry, index) => (
              <button type="button" role="option" aria-selected={activeEntry === index} key={entry.path} ref={node => { entryButtons.current[index] = node; }}
                onFocus={() => setActiveEntry(index)} onClick={() => browse(entry.path)}
                onKeyDown={event => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const next = Math.min(snapshot.entries.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
                    setActiveEntry(next); entryButtons.current[next]?.focus();
                  }
                }}>
                <span aria-hidden="true">▸</span><span>{entry.name}</span>
              </button>
            ))}
            {snapshot.entries.length === 0 && <div className="empty-note">No accessible subfolders</div>}
          </div>
          <div className="directory-status">
            <span>{selectParent ? "Browsing destination parents" : "Browsing"}: <strong className="mono">{snapshot.current}</strong></span>
            {snapshot.repository
              ? <span className="repo-ok">Git repository · {snapshot.repository.branch ?? "detached"}{!snapshot.repository.isRoot && ` · root: ${snapshot.repository.root}`}</span>
              : <span>Not a Git repository — you can initialize it after validation.</span>}
            <button type="button" className="primary-button choose-directory" onClick={() => onChange(snapshot.current, snapshot)}>
              {selectParent ? "Use as destination" : "Choose this folder"}
            </button>
          </div>
        </>
      )}
      {value && <div className="directory-selected">Selected: <strong className="mono">{value}</strong></div>}
      {error && <div role="alert" className="form-error">{error}</div>}
    </div>
  );
}

export function ProjectSheet({ onDone, onClose }: { onDone: (project: Project) => void; onClose?: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [tab, setTab] = useState<"path" | "clone">("path");
  const [path, setPath] = useState("");
  const [snapshot, setSnapshot] = useState<DirectorySnapshot | null>(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneFolder, setCloneFolder] = useState("");
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [agent, setAgent] = useState<Card["agent"]>("claude");
  const [mode, setMode] = useState<Project["mode"]>("auto");
  const [setupScript, setSetupScript] = useState("");
  const [copyGlobs, setCopyGlobs] = useState("");
  const [err, setErr] = useState("");
  const [canInit, setCanInit] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (tab === "clone" && !cloneFolder.trim() && cloneUrl.trim()) setCloneFolder(cloneLeaf(cloneUrl));
  }, [cloneUrl, tab]);

  const target = tab === "path" ? path : path && cloneFolder.trim() ? joinPath(path, cloneFolder.trim()) : "";
  const readyForReview = tab === "path" ? !!path : !!path && !!cloneUrl.trim() && !!cloneFolder.trim();

  const review = () => {
    if (!readyForReview) return;
    setName(current => current || (tab === "clone" ? cloneFolder.trim() : leaf(path)));
    setBaseBranch(current => current || (tab === "path" ? snapshot?.repository?.branch ?? "" : ""));
    setStep(2);
  };

  const submit = async (gitInit = false) => {
    if (busy || !target || !name.trim()) return;
    setErr("");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: name.trim(), path: target };
      if (baseBranch.trim()) body.baseBranch = baseBranch.trim();
      if (tab === "clone") body.clone = cloneUrl.trim();
      if (gitInit) body.gitInit = true;
      const globs = copyGlobs.split(",").map(s => s.trim()).filter(Boolean);
      body.settings = { defaultAgent: agent, mode, setupScript, copyGlobs: globs };
      const project = await api.post<Project>("/api/projects", body);
      onDone(project);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCanInit(message.includes("not a git repository"));
      setErr(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-project-sheet className="project-sheet">
      <header className="sheet-header">
        <div>
          <div className="eyebrow">NEW PROJECT · STEP {step} OF 2</div>
          <h2>{step === 1 ? "Choose a repository" : "Review and configure"}</h2>
        </div>
        {onClose && <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>}
      </header>

      {step === 1 ? (
        <>
          <div className="segmented" role="tablist" aria-label="Project source">
            <button type="button" role="tab" aria-selected={tab === "path"} onClick={() => setTab("path")}>Local path</button>
            <button type="button" role="tab" aria-selected={tab === "clone"} onClick={() => setTab("clone")}>Git clone</button>
          </div>
          {tab === "clone" && (
            <div className="clone-fields">
              <label>Repository URL<input name="clone-url" value={cloneUrl} onChange={e => setCloneUrl(e.target.value)} placeholder="https://github.com/you/repo.git" /></label>
              <label>Destination folder<input name="clone-folder" value={cloneFolder} onChange={e => setCloneFolder(e.target.value)} placeholder="repo" /></label>
            </div>
          )}
          <div className="field-label">{tab === "clone" ? "Clone destination" : "Repository directory"}</div>
          <DirectoryBrowser value={path} selectParent={tab === "clone"} onChange={(next, meta) => { setPath(next); setSnapshot(meta); setCanInit(false); }} />
          <footer className="sheet-footer">
            <span className="footer-hint">{target || "Select a directory to continue"}</span>
            <button type="button" className="primary-button" disabled={!readyForReview} onClick={review}>Continue →</button>
          </footer>
        </>
      ) : (
        <>
          <div className="project-summary">
            <span className="summary-icon" aria-hidden="true">⌘</span>
            <div><strong>{name || leaf(target)}</strong><span className="mono">{target}</span></div>
            <button type="button" className="link-button" onClick={() => setStep(1)}>Change</button>
          </div>
          <div className="form-grid two">
            <label>Project name<input name="project-name" value={name} onChange={e => setName(e.target.value)} /></label>
            <label>Base branch<input name="base-branch" value={baseBranch} onChange={e => setBaseBranch(e.target.value)} placeholder="auto-detect" /></label>
          </div>
          <div className="form-grid two">
            <label>Default agent<select value={agent} onChange={e => setAgent(e.target.value as Card["agent"])} aria-label="Default agent">
              {CardAgent.options.map(value => <option key={value} value={value}>{agentLabels[value]}</option>)}
            </select></label>
          </div>
          <fieldset className="mode-picker">
            <legend>Permission policy</legend>
            {(["auto", "host", "ask"] as const).map(value => (
              <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)} style={{ "--mode-tone": modeCopy[value].tone } as React.CSSProperties}>
                <span className="mode-radio" aria-hidden="true" />
                <span><strong>{modeCopy[value].title}</strong><small>{modeCopy[value].detail}</small></span>
              </button>
            ))}
          </fieldset>
          {mode === "host" && <div className="danger-note" role="status"><strong>Full host access enabled.</strong> Claude will use dangerously-skip-permissions; Codex will bypass approvals and sandboxing. Already-running sessions are unchanged.</div>}
          <details className="advanced-settings">
            <summary>Advanced worktree setup</summary>
            <label>Worktree setup script<textarea name="setup-script" value={setupScript} onChange={e => setSetupScript(e.target.value)} rows={3} placeholder="bun install" /></label>
            <label>Copy into worktrees<input name="copy-globs" value={copyGlobs} onChange={e => setCopyGlobs(e.target.value)} placeholder=".env, .env.local" /></label>
          </details>
          {err && <div role="alert" className="form-error">{err}{canInit && <button type="button" className="secondary-button" onClick={() => void submit(true)}>Initialize Git here</button>}</div>}
          <footer className="sheet-footer">
            <button type="button" className="secondary-button" onClick={() => setStep(1)}>← Back</button>
            <button type="button" className="primary-button" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? "Adding…" : tab === "clone" ? "Clone and add" : "Add project"}</button>
          </footer>
        </>
      )}
    </div>
  );
}
