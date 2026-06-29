interface Label {
	name: string;
	color: string;
}

interface LabelListProps {
	labels: Label[];
	size: "compact" | "detail";
}

function uniqueLabels(labels: Label[]): Label[] {
	const seen = new Set<string>();
	const unique: Label[] = [];

	for (const label of labels) {
		if (seen.has(label.name)) continue;
		seen.add(label.name);
		unique.push(label);
	}

	return unique;
}

export function LabelList({labels, size}: LabelListProps) {
	const unique = uniqueLabels(labels);
	if (unique.length === 0) return null;

	const className =
		size === "compact"
			? "rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-tight"
			: "rounded-full px-2 py-0.5 text-xs font-medium";
	const containerClassName = size === "compact" ? "mt-1.5 flex flex-wrap gap-1" : "mt-3 flex flex-wrap gap-1.5";

	return (
		<div className={containerClassName}>
			{unique.map((label) => (
				<span
					key={label.name}
					className={className}
					style={{
						backgroundColor: `#${label.color}20`,
						color: `#${label.color}`,
						border: `1px solid #${label.color}40`,
					}}
				>
					{label.name}
				</span>
			))}
		</div>
	);
}
