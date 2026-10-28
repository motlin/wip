import * as fs from "node:fs";
import * as path from "node:path";

import JSON5 from "json5";
import {z} from "zod";

import {DEFAULT_CLASS_CAPS} from "./work-queue.js";

const APP_NAME = "wip";

export function getConfigDir(): string {
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
	Reflect.deleteProperty(config, key);
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

const WORK_QUEUE_CLASSES = ["cheap", "git-write", "build", "ai"] as const;

/** Per-class work queue caps from config keys like `workQueue.build: "3"`. Invalid values are ignored. */
export function getWorkQueueClassCaps(
	config: Record<string, ConfigValue> = readConfig(),
): Partial<Record<(typeof WORK_QUEUE_CLASSES)[number], number>> {
	const caps: Partial<Record<(typeof WORK_QUEUE_CLASSES)[number], number>> = {};
	for (const costClass of WORK_QUEUE_CLASSES) {
		const value = config[`workQueue.${costClass}`];
		if (typeof value !== "string") continue;
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed >= 1) caps[costClass] = parsed;
	}
	return caps;
}

export const DEFAULT_READY_BUFFER_SIZE = 3;

function positiveInt(value: ConfigValue | undefined): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** How many commits the ready buffer keeps ready across all repos, from config key `readyBuffer.size`. Defaults to 3. */
export function getReadyBufferSize(config: Record<string, ConfigValue> = readConfig()): number {
	return positiveInt(config["readyBuffer.size"]) ?? DEFAULT_READY_BUFFER_SIZE;
}

const DEFAULT_OWNERSHIP_ORGS: readonly string[] = ["liftwizard"];

/**
 * Orgs whose upstreams are "own" for stop-the-line, from config key `ownership.orgs` (a list or one org).
 * The viewer's login is always own on top of these. Defaults to liftwizard.
 */
export function getOwnershipOrgs(config: Record<string, ConfigValue> = readConfig()): string[] {
	const value = config["ownership.orgs"];
	if (Array.isArray(value)) return value;
	if (typeof value === "string") return [value];
	return [...DEFAULT_OWNERSHIP_ORGS];
}

const DEFAULT_FLOW_STALE_AFTER_MINUTES = 15;

/** Minutes after the last completed scan before the nav's staleness indicator turns prominent, from config key `flow.staleAfterMinutes`. Defaults to 15. */
export function getFlowStaleAfterMinutes(config: Record<string, ConfigValue> = readConfig()): number {
	return positiveInt(config["flow.staleAfterMinutes"]) ?? DEFAULT_FLOW_STALE_AFTER_MINUTES;
}

/**
 * How many ready-buffer jobs run at once, a hardware budget independent of priority: config key
 * `readyBuffer.capacity`, else the build class cap (`workQueue.build`), else its default.
 */
export function getReadyBufferCapacity(config: Record<string, ConfigValue> = readConfig()): number {
	return (
		positiveInt(config["readyBuffer.capacity"]) ?? getWorkQueueClassCaps(config).build ?? DEFAULT_CLASS_CAPS.build
	);
}

/** Max milliseconds a user-click git action waits for a busy repo, from config key `actionMaxWaitMs`. Undefined when unset or invalid. */
export function getActionMaxWaitMs(config: Record<string, ConfigValue> = readConfig()): number | undefined {
	const value = config["actionMaxWaitMs"];
	if (typeof value !== "string") return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const DEFAULT_AI_RUNG_TIMEOUT_MS = 30 * 60 * 1000;

/** Overall timeout for an AI ladder rung, from config key `aiRungTimeoutMs`. Defaults to 30 minutes. */
export function getAiRungTimeoutMs(config: Record<string, ConfigValue> = readConfig()): number {
	const value = config["aiRungTimeoutMs"];
	if (typeof value !== "string") return DEFAULT_AI_RUNG_TIMEOUT_MS;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_AI_RUNG_TIMEOUT_MS;
}

export const DEFAULT_AI_MAX_ATTEMPTS = 10;

/** Cap on AI test/fix attempts per branch, from config key `aiMaxAttempts`. Defaults to 10. */
export function getAiMaxAttempts(config: Record<string, ConfigValue> = readConfig()): number {
	const value = config["aiMaxAttempts"];
	if (typeof value !== "string") return DEFAULT_AI_MAX_ATTEMPTS;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_AI_MAX_ATTEMPTS;
}

/** Placeholder until real data says otherwise (lean plan open question 3). */
export const DEFAULT_SPLIT_THRESHOLD_LINES = 400;

/** Lines changed above which a commit shows "consider splitting", from config key `flow.splitThresholdLines`. Defaults to 400. */
export function getSplitThresholdLines(config: Record<string, ConfigValue> = readConfig()): number {
	const value = config["flow.splitThresholdLines"];
	if (typeof value !== "string") return DEFAULT_SPLIT_THRESHOLD_LINES;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_SPLIT_THRESHOLD_LINES;
}

/** Whether the background ladder replays and rebases branches, from config key `ladder.backgroundRebase`. Defaults to off. */
export function getLadderBackgroundRebase(config: Record<string, ConfigValue> = readConfig()): boolean {
	return config["ladder.backgroundRebase"] === "true";
}
