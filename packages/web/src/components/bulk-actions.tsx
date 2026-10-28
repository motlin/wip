import {useState} from "react";

import {Loader2, RefreshCw} from "./icons.js";
import {ESCAPE_HATCH_RECIPES, type EscapeHatchRecipe} from "../lib/escape-hatch.js";
import {runPendingAction} from "../lib/pending-action.js";
import {pushToast} from "../lib/toast-store.js";

export interface BulkActionsProps {
	topUp: () => Promise<{running: boolean}>;
	runRecipe: (recipe: EscapeHatchRecipe) => Promise<unknown>;
}

/**
 * The dashboard's bulk actions (lean plan step 37): "Top up ready buffer" pulls at most the
 * buffer's shortfall; the More menu is the escape hatch to the user's own just recipes.
 */
export function BulkActions({topUp, runRecipe}: BulkActionsProps) {
	const [toppingUp, setToppingUp] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [status, setStatus] = useState<string | null>(null);

	const handleTopUp = async () => {
		setStatus(null);
		await runPendingAction("Top up ready buffer", setToppingUp, async () => {
			const {running} = await topUp();
			if (running) pushToast({level: "info", message: "Topping up the ready buffer…"});
			else setStatus("The ready buffer is not running in this server");
		});
	};

	const handleRecipe = async (recipe: EscapeHatchRecipe, label: string) => {
		setMenuOpen(false);
		await runPendingAction(label, undefined, async () => {
			await runRecipe(recipe);
			pushToast({level: "info", message: `Running "${label}" in every repo…`});
		});
	};

	return (
		<div className="relative flex items-center gap-2">
			{status && <output className="text-xs text-text-500">{status}</output>}
			<button
				type="button"
				onClick={() => {
					void handleTopUp();
				}}
				disabled={toppingUp}
				className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:bg-green-600/80"
			>
				{toppingUp ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
				Top up ready buffer
			</button>
			<button
				type="button"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onClick={() => {
					setMenuOpen((open) => !open);
				}}
				className="rounded-lg border border-border-300 px-3 py-1.5 text-sm font-medium text-text-300 transition-colors hover:bg-bg-200"
			>
				More
			</button>
			{menuOpen && (
				<div
					role="menu"
					className="absolute right-0 top-full z-20 mt-1 flex min-w-56 flex-col rounded-lg border border-border-300 bg-bg-000 py-1 shadow-lg"
				>
					{ESCAPE_HATCH_RECIPES.map(({recipe, label, command}) => (
						<button
							key={recipe}
							type="button"
							role="menuitem"
							aria-label={`${label} (${command})`}
							onClick={() => {
								void handleRecipe(recipe, label);
							}}
							className="flex items-center justify-between gap-4 px-3 py-1.5 text-left text-sm text-text-100 hover:bg-bg-200"
						>
							{label}
							<code className="text-xs text-text-500">{command}</code>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
