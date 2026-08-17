import * as fs from "node:fs";
import * as path from "node:path";

import JSON5 from "json5";
import {z} from "zod";

const APP_NAME = "wip";

function getConfigDir(): string {
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config");
	return path.join(xdgConfig, APP_NAME);
}

export function getCacheDir(): string {
	const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? "", ".cache");
	return path.join(xdgCache, APP_NAME);
}

export function getTestLogDir(projectName: string): string {
	return path.join(getCacheDir(), "test-logs", projectName);
}

function getConfigPath(): string {
	return path.join(getConfigDir(), "config.json5");
}

export type ConfigValue = string | string[];

export const RepositoryPolicySchema = z.enum(["managed", "external", "ignored"]);
export type RepositoryPolicy = z.infer<typeof RepositoryPolicySchema>;

const MANAGED_REPOSITORY_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);
const repositoryPolicyKeySchema = z.string().regex(/^repositoryPolicy\.[^/]+\/(?:[^/]+|\*)$/i);

export function resolveRepositoryPolicy(
	repository: string,
	viewerPermission: string,
	authenticatedLogin: string,
	config: Record<string, ConfigValue> = readConfig(),
): RepositoryPolicy {
	const normalizedRepository = repository.toLowerCase();
	const owner = normalizedRepository.split("/", 1)[0] ?? "";
	const normalizedConfig = new Map(Object.entries(config).map(([key, value]) => [key.toLowerCase(), value] as const));
	const configuredPolicy =
		normalizedConfig.get(`repositorypolicy.${normalizedRepository}`) ??
		normalizedConfig.get(`repositorypolicy.${owner}/*`);
	if (configuredPolicy !== undefined) return RepositoryPolicySchema.parse(configuredPolicy);
	if (MANAGED_REPOSITORY_PERMISSIONS.has(viewerPermission)) return "managed";
	if (owner === authenticatedLogin.toLowerCase()) return "managed";
	return "external";
}

export function readConfig(): Record<string, ConfigValue> {
	const configPath = getConfigPath();
	if (!fs.existsSync(configPath)) return {};
	const content = fs.readFileSync(configPath, "utf-8");
	return JSON5.parse(content);
}

export function writeConfig(config: Record<string, ConfigValue>): void {
	const configDir = getConfigDir();
	fs.mkdirSync(configDir, {recursive: true});
	fs.writeFileSync(getConfigPath(), JSON5.stringify(config, null, "\t") + "\n");
}

export function getConfigValue(key: string): ConfigValue | undefined {
	return readConfig()[key];
}

export function setConfigValue(key: string, value: ConfigValue): void {
	if (key.toLowerCase().startsWith("repositorypolicy.")) {
		repositoryPolicyKeySchema.parse(key);
		RepositoryPolicySchema.parse(value);
	}
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
	const value = getConfigValue("projectsDir");
	if (Array.isArray(value)) return value[0] ?? `${process.env.HOME}/projects`;
	return value ?? `${process.env.HOME}/projects`;
}

export function getProjectsDirs(flagValue?: string): string[] {
	if (flagValue) return [flagValue];
	const value = getConfigValue("projectsDirs");
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return [value];
	// Fall back to singular projectsDir for backward compatibility
	return [getProjectsDir()];
}
