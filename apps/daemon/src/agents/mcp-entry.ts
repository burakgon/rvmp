// codegent MCP sidecar — spawned per dispatch by adapters (T7) as
//   bun apps/daemon/src/agents/mcp-entry.ts
// with env CODEGENT_HOOK_PORT / CODEGENT_HOOK_TOKEN (signal-plane endpoint)
// and CODEGENT_CARD_ID / CODEGENT_DISPATCH_ID (dispatch envelope), set at
// spawn via the generated mcp.json. Speaks MCP over stdio to the agent CLI and
// forwards to the daemon's loopback agent API.
//
// Spec §6: EXACTLY three tools — task_get, task_progress, task_complete.
// No task_ask_user: questions happen in the terminal (principle 2).
//
// Built on the low-level `Server` + setRequestHandler surface (not the
// high-level `McpServer`): tools/list then carries our verbatim JSON Schemas
// with no zod dependency in this package, and error conversion is explicit —
// every failure returns a CallToolResult with isError:true, which lands ONLY
// in the agent's own conversation (§6.1's sanctioned echo channel).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const env = (k: string): string => process.env[k] ?? "";
const ids = () => ({ card: Number(env("CODEGENT_CARD_ID")), dispatch: env("CODEGENT_DISPATCH_ID") });

async function daemon(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${env("CODEGENT_HOOK_PORT")}/api/agent${path}`, {
    method,
    headers: { "x-codegent-hook-token": env("CODEGENT_HOOK_TOKEN"), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data: any = await res.json().catch(() => ({}));
  // Non-2xx (the dirty-worktree 409 above all) throws the daemon's error text;
  // the tool dispatcher below turns it into an MCP tool error the agent reads.
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : `daemon error ${res.status}`);
  return data;
}

const TOOLS: Tool[] = [
  {
    name: "task_get",
    description: "Fetch your assigned task: title, description, and acceptance notes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task_progress",
    description:
      "Append a short progress note to the task timeline. Call it after each meaningful step — it also serves as your heartbeat.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "One short line describing the step you just finished." } },
      required: ["note"],
    },
  },
  {
    name: "task_complete",
    description:
      "Report the task complete with a short summary. Commit all your work first — completion is rejected while the worktree has uncommitted changes. Call exactly once, even if the task failed.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "What was done, or why it could not be finished." } },
      required: ["summary"],
    },
  },
];

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const toolError = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });

const server = new Server({ name: "codegent", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "task_get": {
        const envelope = ids();
        const t = await daemon(
          "GET",
          `/task?card=${envelope.card}&dispatch=${encodeURIComponent(envelope.dispatch)}`,
        );
        return text(JSON.stringify(t));
      }
      case "task_progress": {
        if (typeof args.note !== "string" || !args.note.trim()) return toolError("note (string) is required");
        await daemon("POST", "/progress", { ...ids(), note: args.note });
        return text("progress noted");
      }
      case "task_complete": {
        if (typeof args.summary !== "string") return toolError("summary (string) is required");
        const r = await daemon("POST", "/complete", { ...ids(), summary: args.summary });
        return text(r.stale ? "completion was already recorded for this dispatch" : "completion recorded");
      }
      default:
        return toolError(`unknown tool: ${req.params.name}`);
    }
  } catch (e) {
    return toolError(e instanceof Error ? e.message : String(e));
  }
});

await server.connect(new StdioServerTransport());
