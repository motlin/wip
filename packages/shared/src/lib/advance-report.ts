/** Tree-shaped report for an advance run, mirroring the worker tree. */

export type NodeStatus = "green" | "red" | "stuck" | "skipped" | "upstream_fixed" | "running";

export interface ReportNode {
	label: string;
	status: NodeStatus;
	detail?: string;
	children: ReportNode[];
}

const EMOJI: Record<NodeStatus, string> = {
	green: "✅",
	red: "❌",
	stuck: "🛑",
	skipped: "⏭️",
	upstream_fixed: "⚠️",
	running: "🔄",
};

function label(node: ReportNode): string {
	const detail = node.detail ? ` — ${node.detail}` : "";
	return `${EMOJI[node.status]} ${node.label}${detail}`;
}

export function renderTree(root: ReportNode): string {
	const lines = [label(root)];
	const walk = (children: ReportNode[], prefix: string): void => {
		children.forEach((child, i) => {
			const last = i === children.length - 1;
			lines.push(`${prefix}${last ? "└─ " : "├─ "}${label(child)}`);
			walk(child.children, `${prefix}${last ? "   " : "│  "}`);
		});
	};
	walk(root.children, "");
	return lines.join("\n");
}
