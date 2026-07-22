import React from "react";
import type { Project } from "@rvmp/protocol";

export type ProjectSummary = { id: string; running: number; waiting: number; errors: number; review: number };

export function Sidebar({ projects, summaries, activeId, onSelect, onSettings, onAdd }: {
  projects: Project[];
  summaries?: ProjectSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onSettings?: (id: string) => void;
  onAdd?: () => void;
}) {
  const byId = new Map((summaries ?? []).map(summary => [summary.id, summary]));
  return (
    <nav className="project-sidebar" aria-label="Projects">
      <div className="brand">rv<span>mp</span></div>
      <div className="sidebar-title">PROJECTS{onAdd && <button type="button" aria-label="Add project" onClick={onAdd}>+</button>}</div>
      <div className="project-list">
        {projects.map(project => {
          const summary = byId.get(project.id);
          const attention = (summary?.waiting ?? 0) + (summary?.errors ?? 0) + (summary?.review ?? 0);
          return (
            <div className={`project-row${project.id === activeId ? " active" : ""}`} key={project.id}>
              <button type="button" className="project-select" aria-current={project.id === activeId ? "page" : undefined} onClick={() => onSelect(project.id)}>
                <span className="project-name">{project.name}{project.mode === "host" && <small className="yolo-badge">YOLO</small>}</span>
                <span className="project-path mono">{project.path}</span>
                {summary && <span className="project-stats">
                  {summary.running > 0 && <small className="running">{summary.running} running</small>}
                  {summary.waiting > 0 && <small className="waiting">{summary.waiting} waiting</small>}
                  {summary.errors > 0 && <small className="errors">{summary.errors} error</small>}
                  {summary.review > 0 && <small className="review">{summary.review} review</small>}
                  {attention === 0 && summary.running === 0 && <small>quiet</small>}
                </span>}
              </button>
              {onSettings && <button type="button" className="project-menu" aria-label={`Settings for ${project.name}`} onClick={() => onSettings(project.id)}>•••</button>}
            </div>
          );
        })}
        {projects.length === 0 && <div className="sidebar-empty">No projects yet</div>}
      </div>
    </nav>
  );
}
