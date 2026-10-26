import {describe, expect, it} from "vite-plus/test";
import {
	rankCandidates,
	rankGitChildren,
	remainingJob,
	type Chain,
	type ChainCommit,
	type RankFacts,
} from "./candidate-rank.js";
import type {GitChildResult} from "./schemas.js";

function facts(overrides: Partial<RankFacts>): RankFacts {
	return {
		landable: false,
		needsReplay: false,
		predictedConflicts: false,
		testBad: false,
		lines: 0,
		...overrides,
	};
}

function commit(sha: string, overrides: Partial<ChainCommit> = {}): ChainCommit {
	return {
		sha,
		ready: false,
		firstSeen: 0,
		...facts({}),
		...overrides,
	};
}

describe("remainingJob", () => {
	it.each([
		{name: "landable is zero even when large", input: facts({landable: true, lines: 1023}), expected: 0},
		{name: "nothing left but size", input: facts({lines: 7}), expected: 3},
		{name: "clean replay", input: facts({needsReplay: true}), expected: 1},
		{
			name: "predicted conflicts replace the clean replay",
			input: facts({needsReplay: true, predictedConflicts: true}),
			expected: 3,
		},
		{name: "known bad test", input: facts({testBad: true}), expected: 2},
		{
			name: "everything at once",
			input: facts({needsReplay: true, predictedConflicts: true, testBad: true, lines: 15}),
			expected: 9,
		},
	])("$name -> $expected", ({input, expected}) => {
		expect(remainingJob(input)).toBe(expected);
	});
});

describe("rankCandidates", () => {
	it.each<{name: string; chains: Chain[]; expected: string[]}>([
		{
			name: "shortest remaining job first across repos",
			chains: [
				{project: "a", commits: [commit("a1", {testBad: true})]},
				{project: "b", commits: [commit("b1", {needsReplay: true})]},
				{project: "c", commits: [commit("c1", {landable: true, ready: true, lines: 500})]},
			],
			expected: ["c:c1", "b:b1", "a:a1"],
		},
		{
			name: "size ranks but never excludes",
			chains: [
				{project: "a", commits: [commit("big", {lines: 4095})]},
				{project: "a", commits: [commit("small", {lines: 1})]},
			],
			expected: ["a:small", "a:big"],
		},
		{
			name: "only the first unready commit of a chain is a candidate",
			chains: [{project: "a", commits: [commit("a1"), commit("a2"), commit("a3")]}],
			expected: ["a:a1"],
		},
		{
			name: "a stacked commit becomes a candidate once its parent is ready, and stays behind it",
			chains: [
				{
					project: "a",
					commits: [
						commit("a1", {landable: true, ready: true, lines: 63}),
						commit("a2", {ready: true}),
						commit("a3", {needsReplay: true}),
						commit("a4"),
					],
				},
				{project: "b", commits: [commit("b1", {lines: 3})]},
			],
			expected: ["a:a1", "a:a2", "a:a3", "b:b1"],
		},
		{
			name: "a child never outranks its parent even when its own job is smaller",
			chains: [
				{project: "a", commits: [commit("a1", {testBad: true, ready: true}), commit("a2")]},
				{project: "b", commits: [commit("b1", {needsReplay: true})]},
			],
			expected: ["b:b1", "a:a1", "a:a2"],
		},
		{
			name: "ties go to first-seen, then project, then sha",
			chains: [
				{project: "b", commits: [commit("b2", {firstSeen: 10})]},
				{project: "b", commits: [commit("b1", {firstSeen: 10})]},
				{project: "a", commits: [commit("a9", {firstSeen: 10})]},
				{project: "z", commits: [commit("z1", {firstSeen: 5})]},
			],
			expected: ["z:z1", "a:a9", "b:b1", "b:b2"],
		},
		{
			name: "an empty chain has no candidate",
			chains: [{project: "a", commits: []}],
			expected: [],
		},
	])("$name", ({chains, expected}) => {
		expect(rankCandidates(chains).map((c) => `${c.project}:${c.sha}`)).toStrictEqual(expected);
	});

	it("reports each candidate's job and stack depth", () => {
		expect(
			rankCandidates([
				{project: "a", commits: [commit("a1", {ready: true, needsReplay: true}), commit("a2", {lines: 1})]},
			]),
		).toStrictEqual([
			{project: "a", sha: "a1", job: 1, depth: 0},
			{project: "a", sha: "a2", job: 1, depth: 1},
		]);
	});
});

function child(sha: string, overrides: Partial<GitChildResult>): GitChildResult {
	return {
		project: "p",
		remote: "upstream",
		originRemote: "origin",
		sha: sha.padEnd(40, "0"),
		shortSha: sha.padEnd(7, "0"),
		subject: sha,
		date: "2026-10-01",
		testStatus: "unknown",
		checkStatus: "unknown",
		skippable: false,
		pushedToRemote: false,
		reviewStatus: "none",
		...overrides,
	} as GitChildResult;
}

describe("rankGitChildren", () => {
	it("orders queue items by remaining job, then commit date", () => {
		const items = [
			child("conflict", {rebaseable: false}),
			child("failed", {testStatus: "failed"}),
			child("behind", {commitsBehind: 2}),
			child("newer", {date: "2026-10-20"}),
			child("older", {date: "2026-09-01"}),
			child("dirty", {mergeStateStatus: "DIRTY"}),
		];
		expect(rankGitChildren(items).map((c) => c.subject)).toStrictEqual([
			"older",
			"newer",
			"behind",
			"failed",
			"conflict",
			"dirty",
		]);
	});
});
