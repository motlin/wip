import {describe, expect, it} from "vite-plus/test";

import {parseAsapLadder, proposePriorities, tierPriority} from "./asap-priority.js";
import type {ProjectRecord} from "./inventory.js";

function project(name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
	return {name, dir: `/home/me/projects/${name}`, template: "typescript", kind: "own", ...extra};
}

const workLadder = {
	name: "📌 Tasks (asap) (work)",
	id: "bucket-work",
	children: [
		{
			name: "1st",
			id: "t1",
			children: [{name: "T3 Planning", id: "a"}],
		},
		{
			name: "2nd",
			id: "t2",
			children: [
				{name: "Land the liftwizard upgrade #liftwizard", id: "b"},
				{name: "wip", id: "c", completedAt: null},
			],
		},
		{
			name: "3rd",
			id: "t3",
			children: [{name: "Clean up the sprint", id: "d"}],
		},
	],
};

const personalLadder = {
	name: "📌 Tasks (asap) (personal)",
	id: "bucket-personal",
	children: [
		{name: "Notes about the ladder", id: "n"},
		{
			name: "3rd",
			id: "p3",
			children: [
				{
					name: '🤖 <a href="https://github.com/motlin/claude-code-prompts">Claude Code Prompts</a> #obsession',
					id: "e",
				},
				{name: "Ship the liftwizard docs", id: "f"},
				{name: "factorio.school dark mode", id: "g", completedAt: "2026-09-01T00:00:00.000Z"},
			],
		},
		{
			name: "5th",
			id: "p5",
			children: [
				{
					name: "Dev infrastructure",
					id: "h",
					children: [{name: "Fix the dotfiles justfile in ~/.dotfiles", id: "i"}],
				},
				{name: "factorio.school dark mode", id: "j"},
			],
		},
	],
};

describe("tierPriority", () => {
	it("maps the top two tiers to high, the next two to medium and the rest to low", () => {
		expect([1, 2, 3, 4, 5, 9].map((tier) => tierPriority(tier))).toStrictEqual([
			"high",
			"high",
			"medium",
			"medium",
			"low",
			"low",
		]);
	});
});

describe("proposePriorities", () => {
	const projects = [
		project("liftwizard", {priority: "low"}),
		project("wip"),
		project("claude-code-prompts"),
		project("dotfiles", {dir: "/home/me/.dotfiles"}),
		project("factorio.school"),
		project("clean"),
		project("unrelated", {priority: "high"}),
		project("skipped-thing", {kind: "skip"}),
	];

	it("proposes a priority from the highest tier each matched repo appears in and leaves unmatched repos out", () => {
		const ladders = [parseAsapLadder(workLadder), parseAsapLadder(personalLadder)];
		expect(proposePriorities(ladders, projects)).toStrictEqual([
			{
				name: "claude-code-prompts",
				current: undefined,
				proposed: "medium",
				tier: 3,
				ladder: "📌 Tasks (asap) (personal)",
				evidence: "🤖 Claude Code Prompts #obsession",
			},
			{
				name: "dotfiles",
				current: undefined,
				proposed: "low",
				tier: 5,
				ladder: "📌 Tasks (asap) (personal)",
				evidence: "Fix the dotfiles justfile in ~/.dotfiles",
			},
			{
				name: "factorio.school",
				current: undefined,
				proposed: "low",
				tier: 5,
				ladder: "📌 Tasks (asap) (personal)",
				evidence: "factorio.school dark mode",
			},
			{
				name: "liftwizard",
				current: "low",
				proposed: "high",
				tier: 2,
				ladder: "📌 Tasks (asap) (work)",
				evidence: "Land the liftwizard upgrade #liftwizard",
			},
			{
				name: "wip",
				current: undefined,
				proposed: "high",
				tier: 2,
				ladder: "📌 Tasks (asap) (work)",
				evidence: "wip",
			},
		]);
	});

	it("proposes nothing from an empty ladder", () => {
		expect(proposePriorities([parseAsapLadder({name: "📌", children: []})], projects)).toStrictEqual([]);
	});
});

describe("parseAsapLadder", () => {
	it("rejects an export that is not a node tree", () => {
		expect(() => parseAsapLadder({children: "nope"})).toThrow(/name/);
	});
});
