import * as fs from 'node:fs';
import * as path from 'node:path';

import JSON5 from 'json5';

const APP_NAME = 'wip';

function getConfigDir(): string {
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config');
	return path.join(xdgConfig, APP_NAME);
}

function getConfigPath(): string {
	return path.join(getConfigDir(), 'config.json5');
}

export function readConfig(): Record<string, string> {
	const configPath = getConfigPath();
	if (!fs.existsSync(configPath)) return {};
	const content = fs.readFileSync(configPath, 'utf-8');
	return JSON5.parse(content);
}

export function writeConfig(config: Record<string, string>): void {
	const configDir = getConfigDir();
	fs.mkdirSync(configDir, {recursive: true});
	fs.writeFileSync(getConfigPath(), JSON5.stringify(config, null, '\t') + '\n');
}

export function getConfigValue(key: string): string | undefined {
	return readConfig()[key];
}

export function setConfigValue(key: string, value: string): void {
	const config = readConfig();
	config[key] = value;
	writeConfig(config);
}

export function unsetConfigValue(key: string): boolean {
	const config = readConfig();
	if (!(key in config)) return false;
	delete config[key];
	writeConfig(config);
	return true;
}

export function getProjectsDir(flagValue?: string): string {
	if (flagValue) return flagValue;
	return getConfigValue('projectsDir') ?? `${process.env.HOME}/projects`;
}
