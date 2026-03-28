import {describe, it, expect} from 'vitest';

import {resolveLanguage} from './diff-section';

describe('resolveLanguage', () => {
	it('returns the extension directly when it is a supported shiki language', () => {
		expect(resolveLanguage('main.go')).toBe('go');
		expect(resolveLanguage('index.html')).toBe('html');
		expect(resolveLanguage('styles.css')).toBe('css');
		expect(resolveLanguage('query.sql')).toBe('sql');
	});

	it('maps common extensions to their shiki language identifier', () => {
		expect(resolveLanguage('app.js')).toBe('javascript');
		expect(resolveLanguage('app.ts')).toBe('typescript');
		expect(resolveLanguage('app.tsx')).toBe('tsx');
		expect(resolveLanguage('script.py')).toBe('python');
		expect(resolveLanguage('script.sh')).toBe('bash');
		expect(resolveLanguage('config.yml')).toBe('txt'); // yaml not in default shiki highlighter
		expect(resolveLanguage('README.md')).toBe('markdown');
		expect(resolveLanguage('header.h')).toBe('c');
		expect(resolveLanguage('lib.hpp')).toBe('cpp');
		expect(resolveLanguage('page.htm')).toBe('html');
		expect(resolveLanguage('App.kt')).toBe('kotlin');
	});

	it('falls back to txt for unknown extensions', () => {
		expect(resolveLanguage('docs/src/main/znai/toc')).toBe('txt');
		expect(resolveLanguage('file.znai')).toBe('txt');
		expect(resolveLanguage('data.parquet')).toBe('txt');
		expect(resolveLanguage('image.png')).toBe('txt');
	});

	it('falls back to txt for files with no extension', () => {
		expect(resolveLanguage('LICENSE')).toBe('txt');
		expect(resolveLanguage('Procfile')).toBe('txt');
	});
});
