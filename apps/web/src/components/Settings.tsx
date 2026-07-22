import React, { useContext, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardAgent, type Card, type Project, type SessionMeta, type Worktree } from "@rvmp/protocol";
import { api, token } from "../api";
import { formatElapsed } from "../projection";
import { AppCtx } from "../appCtx";
import { notifyEnabled, onNotifyChange, setNotifyEnabled } from "../notify";

// §8 Settings (single page, local-only): worker limit · notifications ·
// service status · agent versions · disk/archive management · access token +
// "expose safely" guidance. Relay/pairing lines are CUT (local-only pivot).

type AgentRow = { name: string; path: string | null; version: string | null };
type LogRow = { id: number; ts: number; cardId: number | null; kind: string; title: string };
type SizedWorktree = Worktree & { bytes: number; cardId: number | null };
type DatabaseState = { integrity: { ok: boolean; detail: string }; backups: string[] };

const box: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, background: "var(--surface)", padding: "12px 14px", marginBottom: 12 };
const h: React.CSSProperties = { fontSize: 10, fontWeight: 650, letterSpacing: ".8px", color: "var(--dim)", textTransform: "uppercase", marginBottom: 8 };

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function SettingsView({ project }: { project: Project }) {
  const { projectId, focusSession } = useContext(AppCtx);
  const qc = useQueryClient();
  const [notifOn, setNotifOn] = useState(notifyEnabled);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(project.name);
  const [baseBranch, setBaseBranch] = useState(project.baseBranch);
  const [defaultAgent, setDefaultAgent] = useState<Card["agent"]>(project.defaultAgent ?? "claude");
  const [mode, setMode] = useState<Project["mode"]>(project.mode);
  const [setupScript, setSetupScript] = useState(project.setupScript);
  const [copyGlobs, setCopyGlobs] = useState(project.copyGlobs.join(", "));
  const [settingsMessage, setSettingsMessage] = useState("");
  React.useEffect(() => onNotifyChange(setNotifOn), []);
  // A confirm armed for project A must never authorize deletion in B (review B-Imp).
  React.useEffect(() => {
    setConfirmPrune(false);
    setConfirmDetach(false);
    setName(project.name);
    setBaseBranch(project.baseBranch);
    setDefaultAgent(project.defaultAgent ?? "claude");
    setMode(project.mode);
    setSetupScript(project.setupScript);
    setCopyGlobs(project.copyGlobs.join(", "));
    setSettingsMessage("");
  }, [projectId, project]);

  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<{ agents: AgentRow[] }>("/api/state/agents"), refetchInterval: 60_000 });
  const service = useQuery({ queryKey: ["service"], queryFn: () => api.get<{ status: string }>("/api/state/service") });
  const database = useQuery({ queryKey: ["database"], queryFn: () => api.get<DatabaseState>("/api/state/database") });
  const worktrees = useQuery({
    queryKey: ["worktrees-sized", projectId],
    queryFn: () => api.get<SizedWorktree[]>(`/api/projects/${projectId}/worktrees?sizes=1`),
  });
  const limit = useMutation({
    mutationFn: (workerLimit: number) => api.patch(`/api/projects/${projectId}`, { workerLimit }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const saveSettings = useMutation({
    mutationFn: () => api.patch<Project>(`/api/projects/${projectId}/settings`, {
      name: name.trim(), baseBranch: baseBranch.trim(), defaultAgent, mode, setupScript,
      copyGlobs: copyGlobs.split(",").map(value => value.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      setSettingsMessage("Project settings saved");
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: error => setSettingsMessage(error instanceof Error ? error.message : String(error)),
  });
  const detach = useMutation({
    mutationFn: () => api.del(`/api/projects/${projectId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
    onError: error => setSettingsMessage(error instanceof Error ? error.message : String(error)),
  });
  const backup = useMutation({
    mutationFn: () => api.post("/api/state/database/backup", {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["database"] }),
    onError: error => setSettingsMessage(error instanceof Error ? error.message : String(error)),
  });
  const prune = useMutation({
    mutationFn: () => api.del(`/api/projects/${projectId}/worktrees/archived`),
    onSuccess: () => {
      setConfirmPrune(false);
      void qc.invalidateQueries({ queryKey: ["worktrees-sized", projectId] });
    },
  });
  const archiveOne = useMutation({
    mutationFn: (id: string) => api.post(`/api/worktrees/${id}/archive`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["worktrees-sized", projectId] }),
    onError: error => setSettingsMessage(error instanceof Error ? error.message : String(error)),
  });
  const pruneOne = useMutation({
    mutationFn: (id: string) => api.del(`/api/worktrees/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["worktrees-sized", projectId] }),
    onError: error => setSettingsMessage(error instanceof Error ? error.message : String(error)),
  });

  const active = (worktrees.data ?? []).filter(w => w.state === "active");
  const archived = (worktrees.data ?? []).filter(w => w.state === "archived");
  const archivedCount = archived.length;
  const accessUrl = `${window.location.origin}/#t=${token()}`; // fragment: never sent in requests

  return (
    <div className="settings-view">
      <div style={box}>
        <div style={h}>Project</div>
        <div className="settings-grid">
          <label className="settings-field">Name<input value={name} onChange={e => setName(e.target.value)} /></label>
          <label className="settings-field">Base branch<input value={baseBranch} onChange={e => setBaseBranch(e.target.value)} /></label>
          <label className="settings-field">Default agent<select value={defaultAgent} onChange={e => setDefaultAgent(e.target.value as Card["agent"])}>
            {CardAgent.options.map(agent => <option key={agent} value={agent}>{agent}</option>)}
          </select></label>
        </div>
        <div className="settings-subhead">Permission policy</div>
        <div className="settings-mode-row">
          {(["auto", "host", "ask"] as const).map(value => (
            <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)} className={value === "host" ? "danger-choice" : ""}>
              <strong>{value === "host" ? "YOLO / host" : value}</strong>
              <span>{value === "auto" ? "sandboxed" : value === "host" ? "no sandbox or approvals" : "agent prompts"}</span>
            </button>
          ))}
        </div>
        {mode === "host" && <div className="danger-note"><strong>Full host access.</strong> New Claude and Codex attempts skip their permission barriers. Running attempts keep their current mode.</div>}
        <details className="advanced-settings settings-advanced">
          <summary>Worktree bootstrap</summary>
          <label>Setup script<textarea rows={3} value={setupScript} onChange={e => setSetupScript(e.target.value)} /></label>
          <label>Copy globs<input value={copyGlobs} onChange={e => setCopyGlobs(e.target.value)} placeholder=".env, .env.local" /></label>
        </details>
        <div className="settings-actions">
          {settingsMessage && <span role="status">{settingsMessage}</span>}
          <button type="button" className="primary-button" disabled={!name.trim() || !baseBranch.trim() || saveSettings.isPending} onClick={() => saveSettings.mutate()}>
            {saveSettings.isPending ? "Saving…" : "Save project settings"}
          </button>
        </div>
      </div>
      <div style={box}>
        <div style={h}>Orchestration</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-2)" }}>
          Worker limit
          <div style={{ display: "flex", gap: 4 }}>
            {[1, 2, 3, 4, 6, 8].map(n => (
              <button key={n} type="button" onClick={() => limit.mutate(n)}
                style={{ minWidth: 26, padding: "3px 0", border: `1px solid ${project.workerLimit === n ? "var(--violet-2)" : "var(--border)"}`, borderRadius: 6, background: "var(--bg)", color: project.workerLimit === n ? "var(--violet-2)" : "var(--ctrl)", font: "inherit", fontSize: 11, cursor: "pointer" }}>{n}</button>
            ))}
          </div>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--meta)" }}>parallel running cards</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, fontSize: 12, color: "var(--text-2)" }}>
          Notifications
          <button type="button" onClick={() => void setNotifyEnabled(!notifOn).then(setNotifOn)}
            style={{ padding: "3px 10px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg)", color: notifOn ? "var(--green)" : "var(--meta)", font: "inherit", fontSize: 10, fontWeight: 500, cursor: "pointer" }}>
            {notifOn ? "on" : "off"}
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--meta)" }}>Web Push · continues after rvmp tabs close</span>
        </div>
      </div>

      <div style={box}>
        <div style={h}>Daemon</div>
        <div style={{ fontSize: 12, color: "var(--text-2)" }}>
          Service: <span data-service-status style={{ color: service.data?.status === "enabled" ? "var(--green)" : "var(--meta)" }}>{service.data?.status ?? "…"}</span>
          <span style={{ marginLeft: 8, fontSize: 11, color: "var(--meta)" }}>manage with `rvmp service enable|disable`</span>
        </div>
      </div>

      <div style={box}>
        <div style={h}>Data & recovery</div>
        <div className="database-state">
          <span className={database.data?.integrity.ok ? "healthy" : "unhealthy"}>{database.data ? database.data.integrity.ok ? "✓ database integrity OK" : `Integrity failed: ${database.data.integrity.detail}` : "Checking integrity…"}</span>
          <span>{database.data?.backups.length ?? 0} backup{database.data?.backups.length === 1 ? "" : "s"} · newest {database.data?.backups[0] ?? "none"}</span>
          <button type="button" className="secondary-button" disabled={backup.isPending} onClick={() => backup.mutate()}>{backup.isPending ? "Backing up…" : "Back up now"}</button>
        </div>
        <div className="recovery-note">Automatic SQLite snapshots are written daily under <code>~/.rvmp/backups</code> and the newest seven are retained. Restore offline with <code>rvmp restore &lt;backup-file&gt;</code>; the command verifies the snapshot and preserves the current database first.</div>
      </div>

      <div style={box}>
        <div style={{ ...h, display: "flex", alignItems: "center" }}>Agents<button type="button" className="link-button" style={{ marginLeft: "auto" }} onClick={() => void api.get("/api/state/agents?refresh=1").then(() => qc.invalidateQueries({ queryKey: ["agents"] }))}>Re-probe</button></div>
        {(agents.data?.agents ?? []).map(a => (
          <div key={a.name} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
            <span style={{ width: 12, color: a.path ? "var(--green)" : "var(--dim)" }}>{a.path ? "✓" : "—"}</span>
            <span style={{ width: 90 }}>{a.name}</span>
            <span style={{ fontSize: 11, color: "var(--meta)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.path ? a.version ?? a.path : "not installed"}
            </span>
            {!a.path && <button type="button" className="link-button" onClick={() => void api.post<SessionMeta>(`/api/projects/${projectId}/sessions`, { title: "agent setup", cwd: project.path }).then(session => focusSession(session.id))}>open setup terminal</button>}
          </div>
        ))}
      </div>

      <div style={box}>
        <div style={h}>Disk & archive</div>
        {active.map(w => (
          <div key={w.id} className="worktree-row">
            <span>{w.branch}<small>{w.base} · {w.sync}{w.cardId !== null ? ` · card ${w.cardId}` : ""}</small></span>
            <span>{fmtBytes(w.bytes)}</span>
            <button type="button" onClick={() => void api.post<SessionMeta>(`/api/projects/${projectId}/sessions`, { title: w.branch, cwd: w.path, worktreeId: w.id }).then(session => focusSession(session.id)).catch(error => setSettingsMessage(error instanceof Error ? error.message : String(error)))}>Terminal</button>
            <button type="button" disabled={w.cardId !== null} title={w.cardId !== null ? "Managed from its card" : undefined} onClick={() => archiveOne.mutate(w.id)}>Archive</button>
          </div>
        ))}
        {active.length === 0 && <div style={{ fontSize: 11, color: "var(--dim)" }}>no active worktrees</div>}
        {archived.map(w => (
          <div key={w.id} className="worktree-row archived">
            <span>{w.branch}<small>archived · branch retained</small></span><span>—</span>
            <button type="button" className="prune-one" onClick={() => pruneOne.mutate(w.id)}>Prune</button>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--meta)" }}>
          {archivedCount} archived worktree row{archivedCount === 1 ? "" : "s"}
          {archivedCount > 0 && !confirmPrune && (
            <button type="button" onClick={() => setConfirmPrune(true)}
              style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--red)", font: "inherit", fontSize: 10, cursor: "pointer" }}>
              Prune
            </button>
          )}
          {confirmPrune && (
            <>
              <span style={{ color: "var(--red)" }}>deletes their kept branches — sure?</span>
              <button type="button" disabled={prune.isPending} onClick={() => prune.mutate()} style={{ padding: "3px 8px", border: "1px solid var(--red)", borderRadius: 6, background: "var(--bg)", color: "var(--red)", font: "inherit", fontSize: 10, cursor: "pointer" }}>Prune now</button>
              <button type="button" onClick={() => setConfirmPrune(false)} style={{ padding: "3px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--ctrl)", font: "inherit", fontSize: 10, cursor: "pointer" }}>Keep</button>
            </>
          )}
        </div>
      </div>

      <div style={box}>
        <div style={h}>Activity (30 days)</div>
        <ActivityLog projectId={projectId} />
      </div>

      <div style={box}>
        <div style={h}>Access & expose safely</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code style={{ flex: 1, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-2)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 9px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accessUrl}</code>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(accessUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            style={{ padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: copied ? "var(--green)" : "var(--ctrl)", font: "inherit", fontSize: 10, cursor: "pointer" }}>
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--meta)", lineHeight: 1.5 }}>
          Access from anywhere: point your own tunnel (Tailscale, cloudflared, or ssh -L)
          at this URL and the board works from any device — the token in the fragment is
          the credential. By default rvmp binds to localhost; never expose the port
          on 0.0.0.0 directly. See docs/expose-safely.md.
        </div>
      </div>

      <div className="danger-zone">
        <div>
          <strong>Remove project from rvmp</strong>
          <span>The repository, branches and worktree directories stay on disk. Only rvmp's registration and history are detached.</span>
        </div>
        {!confirmDetach ? (
          <button type="button" onClick={() => setConfirmDetach(true)}>Remove…</button>
        ) : (
          <div className="confirm-row">
            <span>Remove “{project.name}”?</span>
            <button type="button" disabled={detach.isPending} onClick={() => detach.mutate()}>{detach.isPending ? "Removing…" : "Remove from rvmp"}</button>
            <button type="button" className="secondary-button" onClick={() => setConfirmDetach(false)}>Keep</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** §8 first-run agent strip: probe rows above the add-project sheet. */
export function AgentProbeStrip() {
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<{ agents: AgentRow[] }>("/api/state/agents"), staleTime: 60_000 });
  if (!agents.data) return null;
  return (
    <div data-agent-strip style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
      {agents.data.agents.map(a => (
        <span key={a.name} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", border: "1px solid var(--border)", borderRadius: 999, background: "var(--surface)", fontSize: 10, color: a.path ? "var(--text-2)" : "var(--dim)" }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: a.path ? "var(--green)" : "var(--surface-2)" }} />
          {a.name}{a.path ? "" : " — missing"}
        </span>
      ))}
    </div>
  );
}

/** §18: machine labels → product English on the surface (rows stay enums). */
export function activityLabel(kind: string): string {
  if (kind.startsWith("waiting.")) return "Waiting for input";
  if (kind.startsWith("error.")) return "Error";
  if (kind.startsWith("notice.")) return kind === "notice.runaway" ? "Still running" : kind === "notice.heartbeat-quiet" ? "Quiet 10m+" : "State mismatch";
  if (kind === "review.ready") return "Ready for review";
  if (kind.startsWith("review.")) return `Review — ${kind.slice(7)}`;
  if (kind.startsWith("working.")) return "Running";
  return kind[0]!.toUpperCase() + kind.slice(1);
}

/** §8 event log surface: newest-first state facts, filterable by card. */
export function ActivityLog({ projectId }: { projectId: string }) {
  const [cardFilter, setCardFilter] = useState("");
  const log = useQuery({
    queryKey: ["eventlog", projectId, cardFilter],
    queryFn: () => api.get<LogRow[]>(`/api/projects/${projectId}/events${cardFilter ? `?card=${cardFilter}` : ""}`),
    refetchInterval: 30_000,
  });
  const now = Date.now();
  return (
    <div data-activity-log>
      <input name="activity-card-filter" value={cardFilter} onChange={e => setCardFilter(e.target.value.replace(/[^0-9]/g, ""))}
        placeholder="filter by card id"
        style={{ width: 130, marginBottom: 8, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", font: "inherit", fontSize: 10, outline: "none" }} />
      <div style={{ maxHeight: 220, overflow: "auto" }}>
        {(log.data ?? []).map(r => (
          <div key={r.id} style={{ display: "flex", gap: 8, padding: "2px 0", fontSize: 11, color: "var(--text-2)" }}>
            <span style={{ width: 40, color: "var(--meta)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{formatElapsed(now - r.ts)}</span>
            <span style={{ width: 120, color: "var(--ctrl)", flexShrink: 0 }}>{activityLabel(r.kind)}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.cardId !== null ? `#${r.cardId} · ` : ""}{r.title}</span>
          </div>
        ))}
        {(log.data ?? []).length === 0 && <div style={{ fontSize: 11, color: "var(--dim)" }}>nothing yet</div>}
      </div>
    </div>
  );
}
