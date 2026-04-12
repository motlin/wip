import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import { CATEGORIES, CATEGORY_PRIORITY, categoryTextClass } from "../lib/category-actions";
import { STATE_MACHINE, type Category } from "@wip/shared";

const statesSearchSchema = z.object({
  state: z.string().optional(),
});

export const Route = createFileRoute("/states")({
  validateSearch: statesSearchSchema,
  head: () => ({
    meta: [{ title: "WIP State Machine" }],
  }),
  component: StatesPage,
});

// Layout: assign (x, y) positions to each state for the SVG graph.
// States are grouped into columns by lifecycle phase.
const NODE_W = 140;
const NODE_H = 36;
const COL_GAP = 180;
const ROW_GAP = 56;

interface NodePos {
  x: number;
  y: number;
}

// Column assignments: group states by lifecycle phase
const COLUMNS: Category[][] = [
  // Col 0: overrides + ideas
  ["snoozed", "skippable", "untriaged", "triaged", "plan_unreviewed", "plan_approved"],
  // Col 1: early local
  ["detached_head", "local_changes", "no_test"],
  // Col 2: test cycle
  ["ready_to_test", "test_running", "test_failed"],
  // Col 3: rebase + split
  ["needs_rebase", "rebase_unknown", "rebase_conflicts", "rebase_stuck", "needs_split"],
  // Col 4: push
  ["ready_to_push", "pushed_no_pr"],
  // Col 5: CI
  ["checks_unknown", "checks_running", "checks_failed"],
  // Col 6: review
  ["checks_passed", "review_comments", "changes_requested", "approved"],
];

function computePositions(): Record<Category, NodePos> {
  const positions = {} as Record<Category, NodePos>;
  const padLeft = 20;
  const padTop = 20;

  for (let col = 0; col < COLUMNS.length; col++) {
    const states = COLUMNS[col]!;
    const colX = padLeft + col * (NODE_W + COL_GAP);
    for (let row = 0; row < states.length; row++) {
      const rowY = padTop + row * (NODE_H + ROW_GAP);
      positions[states[row]!] = { x: colX, y: rowY };
    }
  }

  return positions;
}

const POSITIONS = computePositions();
const SVG_WIDTH = 20 + COLUMNS.length * (NODE_W + COL_GAP);
const SVG_HEIGHT =
  20 + Math.max(...COLUMNS.map((col) => col.length - 1)) * (NODE_H + ROW_GAP) + NODE_H;

// Color mapping from Tailwind class strings to fill colors for the SVG nodes
function nodeColor(
  category: Category,
  isActive: boolean,
): { fill: string; stroke: string; text: string } {
  if (isActive) {
    return { fill: "#fbbf24", stroke: "#f59e0b", text: "#000" };
  }
  const palette = CATEGORIES[category].palette;
  switch (palette) {
    case "green":
      return { fill: "#064e3b", stroke: "#059669", text: "#6ee7b7" };
    case "red":
      return { fill: "#450a0a", stroke: "#dc2626", text: "#fca5a5" };
    case "yellow":
      return { fill: "#422006", stroke: "#ca8a04", text: "#fde68a" };
    case "blue":
      return { fill: "#172554", stroke: "#2563eb", text: "#93c5fd" };
    case "orange":
      return { fill: "#431407", stroke: "#ea580c", text: "#fdba74" };
    case "amber":
      return { fill: "#451a03", stroke: "#d97706", text: "#fcd34d" };
    case "purple":
      return { fill: "#2e1065", stroke: "#7c3aed", text: "#c4b5fd" };
    default:
      return { fill: "#1e1e2e", stroke: "#4b5563", text: "#9ca3af" };
  }
}

function edgePath(from: NodePos, to: NodePos): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  // If going backwards (right-to-left), route underneath
  if (x2 <= x1) {
    const midY = Math.max(y1, y2) + NODE_H + 20;
    return `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x1 + 40} ${midY}, ${(x1 + x2) / 2} ${midY} C ${x2 - 40} ${midY}, ${x2 - 40} ${y2}, ${x2} ${y2}`;
  }

  // Normal left-to-right: cubic bezier
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

function StateGraph({ activeState }: { activeState: string | undefined }) {
  const navigate = useNavigate();

  // Deduplicate edges: group by from->to, collect transition labels and track kind
  const edgeMap = new Map<
    string,
    { from: Category; to: Category; transitions: string[]; hasActive: boolean; hasPassive: boolean }
  >();
  for (const t of STATE_MACHINE) {
    const key = `${t.from}->${t.to}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.transitions.push(t.transition);
      if (t.kind === "active") existing.hasActive = true;
      if (t.kind === "passive") existing.hasPassive = true;
    } else {
      edgeMap.set(key, {
        from: t.from,
        to: t.to,
        transitions: [t.transition],
        hasActive: t.kind === "active",
        hasPassive: t.kind === "passive",
      });
    }
  }
  const edges = Array.from(edgeMap.values());

  return (
    <div className="overflow-x-auto rounded-lg border border-border-300/30 bg-bg-100">
      <svg
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="min-w-[900px]"
        style={{ width: "100%", height: "auto" }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 7"
            refX="10"
            refY="3.5"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="#6b7280" />
          </marker>
          <marker
            id="arrow-active"
            viewBox="0 0 10 7"
            refX="10"
            refY="3.5"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="#f59e0b" />
          </marker>
          <filter id="glow">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges */}
        {edges.map(({ from, to, transitions, hasActive, hasPassive }) => {
          const fromPos = POSITIONS[from];
          const toPos = POSITIONS[to];
          if (!fromPos || !toPos) return null;
          const isHighlighted = activeState === from || activeState === to;
          const isPassiveOnly = hasPassive && !hasActive;
          return (
            <g key={`${from}-${to}`}>
              <path
                d={edgePath(fromPos, toPos)}
                fill="none"
                stroke={isHighlighted ? "#f59e0b" : "#4b5563"}
                strokeWidth={isHighlighted ? 2 : 1}
                strokeOpacity={isHighlighted ? 0.9 : 0.4}
                strokeDasharray={isPassiveOnly ? "4 3" : undefined}
                markerEnd={isHighlighted ? "url(#arrow-active)" : "url(#arrow)"}
              />
              <title>{transitions.join(", ")}</title>
            </g>
          );
        })}

        {/* Nodes */}
        {CATEGORY_PRIORITY.map((cat) => {
          const pos = POSITIONS[cat];
          if (!pos) return null;
          const isActive = activeState === cat;
          const colors = nodeColor(cat, isActive);
          return (
            <g
              key={cat}
              className="cursor-pointer"
              onClick={() => navigate({ to: "/states", search: { state: cat } })}
            >
              {isActive && (
                <rect
                  x={pos.x - 3}
                  y={pos.y - 3}
                  width={NODE_W + 6}
                  height={NODE_H + 6}
                  rx={10}
                  fill="none"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  filter="url(#glow)"
                />
              )}
              <rect
                x={pos.x}
                y={pos.y}
                width={NODE_W}
                height={NODE_H}
                rx={7}
                fill={colors.fill}
                stroke={colors.stroke}
                strokeWidth={isActive ? 2.5 : 1.5}
              />
              <text
                x={pos.x + NODE_W / 2}
                y={pos.y + NODE_H / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill={colors.text}
                fontSize={11}
                fontWeight={isActive ? 700 : 500}
                fontFamily="Inter, system-ui, sans-serif"
              >
                {CATEGORIES[cat].label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StateTable({ activeState }: { activeState: string | undefined }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-300/30">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-300/30 bg-bg-100">
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">#</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">State</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">Label</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">UI Buttons</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">LLM Command</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">
              Transitions Out
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-text-400">
              Transitions In
            </th>
          </tr>
        </thead>
        <tbody>
          {CATEGORY_PRIORITY.map((cat, idx) => {
            const config = CATEGORIES[cat];
            const isActive = activeState === cat;
            const outgoing = STATE_MACHINE.filter((t) => t.from === cat);
            const incoming = STATE_MACHINE.filter((t) => t.to === cat);
            return (
              <tr
                key={cat}
                className={`border-b border-border-300/20 transition-colors ${
                  isActive ? "bg-amber-500/10" : "hover:bg-bg-100/50"
                }`}
              >
                <td className="px-3 py-2 font-mono text-xs text-text-500">{idx}</td>
                <td className="px-3 py-2">
                  <Link
                    to="/states"
                    search={{ state: cat }}
                    className={`font-mono text-xs hover:underline ${isActive ? "font-bold text-amber-400" : categoryTextClass(cat)}`}
                  >
                    {cat}
                  </Link>
                </td>
                <td className={`px-3 py-2 font-medium ${categoryTextClass(cat)}`}>
                  {config.label}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {config.actions.map((action) => (
                      <span
                        key={action}
                        className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300"
                      >
                        {action}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  {config.llmCommand && (
                    <code className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-xs text-violet-400">
                      {config.llmCommand}
                    </code>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {outgoing.map((t) => (
                      <Link
                        key={`${t.transition}-${t.to}`}
                        to="/states"
                        search={{ state: t.to }}
                        className={`rounded px-1.5 py-0.5 font-mono text-xs hover:bg-bg-300 hover:text-text-100 ${
                          t.kind === "passive"
                            ? "bg-bg-200/60 text-text-400 italic"
                            : "bg-bg-200 text-text-300"
                        }`}
                      >
                        {t.transition} &rarr; {t.to}
                      </Link>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {incoming.map((t) => (
                      <Link
                        key={`${t.from}-${t.transition}`}
                        to="/states"
                        search={{ state: t.from }}
                        className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-xs text-text-300 hover:bg-bg-300 hover:text-text-100"
                      >
                        {t.from} &rarr; {t.transition}
                      </Link>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatesPage() {
  const { state: activeState } = Route.useSearch();

  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="mb-6">
        <Link
          to="/queue"
          className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text-100">State Machine</h1>
        <p className="mt-1 text-sm text-text-400">
          {CATEGORY_PRIORITY.length} states, {STATE_MACHINE.length} transitions.
          {activeState && (
            <>
              {" "}
              Highlighting:{" "}
              <code className="rounded bg-amber-500/20 px-1 py-0.5 font-mono text-xs text-amber-400">
                {activeState}
              </code>
              <Link to="/states" className="ml-2 text-xs text-text-500 hover:text-text-200">
                (clear)
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="mb-8">
        <StateGraph activeState={activeState} />
        <div className="mt-3 flex items-center gap-6 text-xs text-text-400">
          <div className="flex items-center gap-2">
            <svg width="32" height="2">
              <line x1="0" y1="1" x2="32" y2="1" stroke="#4b5563" strokeWidth="1.5" />
            </svg>
            <span>Active (user-triggered)</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="32" height="2">
              <line
                x1="0"
                y1="1"
                x2="32"
                y2="1"
                stroke="#4b5563"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
            </svg>
            <span>Passive (observed on refresh)</span>
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-text-200">All Categories</h2>
        <StateTable activeState={activeState} />
      </div>
    </div>
  );
}
