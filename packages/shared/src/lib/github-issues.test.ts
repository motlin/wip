import {describe, it, expect} from 'vitest';

import {GitHubIssueSchema, GitHubIssueLabelSchema} from './github-issues.js';

describe('GitHubIssueLabelSchema', () => {
	it('accepts a valid label', () => {
		const label = {name: 'bug', color: 'ff0000'};
		expect(GitHubIssueLabelSchema.parse(label)).toStrictEqual(label);
	});

	it('rejects an empty name', () => {
		expect(() => GitHubIssueLabelSchema.parse({name: '', color: 'ff0000'})).toThrow();
	});

	it('rejects an invalid color', () => {
		expect(() => GitHubIssueLabelSchema.parse({name: 'bug', color: 'not-hex'})).toThrow();
	});

	it('rejects a color with a hash prefix', () => {
		expect(() => GitHubIssueLabelSchema.parse({name: 'bug', color: '#ff0000'})).toThrow();
	});
});

describe('GitHubIssueSchema', () => {
	const validIssue = {
		number: 42,
		title: 'Fix the thing',
		url: 'https://github.com/owner/repo/issues/42',
		labels: [{name: 'bug', color: 'd73a4a'}],
		repository: {name: 'repo', nameWithOwner: 'owner/repo'},
	};

	it('accepts a valid GitHub API response', () => {
		expect(GitHubIssueSchema.parse(validIssue)).toStrictEqual(validIssue);
	});

	it('accepts an issue with no labels', () => {
		const issue = {...validIssue, labels: []};
		expect(GitHubIssueSchema.parse(issue)).toStrictEqual(issue);
	});

	it('rejects a negative issue number', () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, number: -1})).toThrow();
	});

	it('rejects a non-integer issue number', () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, number: 1.5})).toThrow();
	});

	it('rejects zero as an issue number', () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, number: 0})).toThrow();
	});

	it('rejects an empty title', () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, title: ''})).toThrow();
	});

	it('rejects an invalid url', () => {
		expect(() => GitHubIssueSchema.parse({...validIssue, url: 'not-a-url'})).toThrow();
	});

	it('rejects an empty repository name', () => {
		expect(() => GitHubIssueSchema.parse({
			...validIssue,
			repository: {name: '', nameWithOwner: 'owner/repo'},
		})).toThrow();
	});

	it('rejects a nameWithOwner without a slash', () => {
		expect(() => GitHubIssueSchema.parse({
			...validIssue,
			repository: {name: 'repo', nameWithOwner: 'ownerrepo'},
		})).toThrow();
	});

	it('rejects a nameWithOwner with multiple slashes', () => {
		expect(() => GitHubIssueSchema.parse({
			...validIssue,
			repository: {name: 'repo', nameWithOwner: 'owner/sub/repo'},
		})).toThrow();
	});

	it('rejects missing fields', () => {
		expect(() => GitHubIssueSchema.parse({number: 1})).toThrow();
	});
});
