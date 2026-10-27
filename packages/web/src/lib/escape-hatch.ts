import {z} from "zod";

/**
 * The More-menu escape hatch (lean plan step 37): the user's own global just recipes, run once per
 * project, for when the ready buffer is not enough. Client-safe: labels and the input schema only.
 */
export const ESCAPE_HATCH_RECIPES = [
	{recipe: "g", label: "Git all", command: "just g"},
	{recipe: "rebase-all", label: "Rebase all", command: "just rebase-all"},
	{recipe: "replay-all", label: "Replay all", command: "just replay-all"},
	{recipe: "ta", label: "Test all", command: "just ta"},
] as const;

export const EscapeHatchRecipeSchema = z.enum(["g", "rebase-all", "replay-all", "ta"]);
export type EscapeHatchRecipe = z.infer<typeof EscapeHatchRecipeSchema>;
