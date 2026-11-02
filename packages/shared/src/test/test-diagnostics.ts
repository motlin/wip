// Runs the per-package test suites (`just test` / `git test` precommit) while sampling machine memory and load once a
// second, so a test that times out on a stalled machine can be lined up with swap-ins, memory pressure or a backup.
// Diagnostics only: it changes no timeout and retries nothing.
import {spawn, execFile} from "node:child_process";
import {appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {z} from "zod";

export interface MachineSample
{
	t: number;
	load1: number;
	pageins: number | null;
	swapins: number | null;
	compressorPages: number | null;
	swapUsedMb: number | null;
	pressureLevel: number | null;
	backupd: boolean | null;
}

const RUNS_TO_KEEP = 5;
const WINDOW_PADDING_MS = 5000;
const PRESSURE_NAMES: Record<number, string> =
{
	1: "normal",
	2: "warn",
	4: "critical",
};

function vmStatCounter(text: string, label: string): number | null
{
	const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text);
	return match ? Number(match[1]) : null;
}

export function parseVmStat(text: string): Pick<MachineSample, "pageins" | "swapins" | "compressorPages">
{
	return {
		pageins: vmStatCounter(text, "Pageins"),
		swapins: vmStatCounter(text, "Swapins"),
		compressorPages: vmStatCounter(text, "Pages occupied by compressor"),
	};
}

export function parseSwapUsedMb(text: string): number | null
{
	const match = /used = ([\d.]+)M/.exec(text);
	return match ? Number(match[1]) : null;
}

async function run(
	command: string,
	args: string[],
): Promise<
{
	code: number;
	stdout: string;
}>
{
	return new Promise((resolve) =>
	{
		execFile(
			command,
			args,
			{
				timeout: 5000,
			},
			(error, stdout) =>
			{
				resolve(
					{
						code: error ? Number(error.code ?? 1) || 1 : 0,
						stdout,
					},
				);
			},
		);
	});
}

async function sampleMachine(): Promise<MachineSample>
{
	const t = Date.now();
	const [vmStat, swap, pressure, backupd] = await Promise.all([
		run("vm_stat", []),
		run("sysctl", ["-n", "vm.swapusage"]),
		run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
		run("pgrep", ["-x", "backupd"]),
	]);
	const pressureLevel = Number.parseInt(pressure.stdout, 10);
	return {
		t,
		load1: os.loadavg()[0] ?? 0,
		...(vmStat.code === 0
			? parseVmStat(vmStat.stdout)
			:
				{
					pageins: null,
					swapins: null,
					compressorPages: null,
				}),
		swapUsedMb: swap.code === 0 ? parseSwapUsedMb(swap.stdout) : null,
		pressureLevel: Number.isNaN(pressureLevel) ? null : pressureLevel,
		// pgrep exits 1 when nothing matches, 2+ when it could not look.
		backupd: backupd.code <= 1 ? backupd.code === 0 : null,
	};
}

export function startSampler(options: {
	intervalMs: number;
	sample: () => Promise<MachineSample>;
	onSample: (sample: MachineSample) => void;
}):
{
	stop: () => Promise<void>;
}
{
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const tick = (): void =>
	{
		if (inFlight || stopped)
		{
			return;
		}
		inFlight = options
			.sample()
			.then((s) =>
			{
				if (!stopped)
				{
					options.onSample(s);
				}
				return undefined;
			})
			.catch(() => {})
			.finally(() =>
			{
				inFlight = undefined;
			});
	};
	const timer = setInterval(tick, options.intervalMs);
	tick();
	return {
		stop: async () =>
		{
			clearInterval(timer);
			const pending = inFlight;
			await pending;
			stopped = true;
		},
	};
}

const jsonReportSchema = z.object(
	{
		testResults: z.array(
			z.object(
				{
					name: z.string(),
					startTime: z.number(),
					endTime: z.number(),
					assertionResults: z.array(
						z.object(
							{
								fullName: z.string(),
								status: z.string(),
								duration: z.number().nullish(),
								failureMessages: z.array(z.string()),
							},
						),
					),
				},
			),
		),
	},
);
type JsonReport = z.infer<typeof jsonReportSchema>;

export interface TimedOutTest
{
	file: string;
	test: string;
	startMs: number;
	endMs: number;
}

// Vitest's JSON report times files, not tests; tests in a file run in order, so a test starts about where the
// durations before it end.
export function findTimeouts(report: JsonReport): TimedOutTest[]
{
	const timeouts: TimedOutTest[] = [];
	for (const file of report.testResults)
	{
		let offset = 0;
		for (const test of file.assertionResults)
		{
			const duration = test.duration ?? 0;
			if (test.failureMessages.some((message) => /(Test|Hook) timed out in \d+ms/.test(message)))
			{
				const startMs = file.startTime + offset;
				timeouts.push(
					{
						file: file.name,
						test: test.fullName,
						startMs,
						endMs: startMs + duration,
					},
				);
			}
			offset += duration;
		}
	}
	return timeouts;
}

function range(values: (number | null)[], format: (n: number) => string = String): string | undefined
{
	const present = values.filter((v): v is number => v !== null);
	if (present.length === 0)
	{
		return undefined;
	}
	const min = Math.min(...present);
	const max = Math.max(...present);
	return min === max ? format(min) : `${format(min)}-${format(max)}`;
}

function delta(values: (number | null)[]): string | undefined
{
	const present = values.filter((v): v is number => v !== null);
	const [first] = present;
	const last = present.at(-1);
	return present.length < 2 || first === undefined || last === undefined ? undefined : `+${last - first}`;
}

export function summarizeWindow(samples: MachineSample[], startMs: number, endMs: number, paddingMs: number): string
{
	const inWindow = samples.filter((s) => s.t >= startMs - paddingMs && s.t <= endMs + paddingMs);
	if (inWindow.length === 0)
	{
		return "no samples in window";
	}
	const maxPressure = Math.max(...inWindow.map((s) => s.pressureLevel ?? 0));
	const backupd = inWindow.some((s) => s.backupd === true);
	const parts = [
		`load ${range(inWindow.map((s) => Math.round(s.load1)))}`,
		...[
			["pageins", delta(inWindow.map((s) => s.pageins))],
			["swapins", delta(inWindow.map((s) => s.swapins))],
			["compressor pages", range(inWindow.map((s) => s.compressorPages))],
			[
				"swap used",
				range(
					inWindow.map((s) => s.swapUsedMb),
					(n) => `${Math.round(n)}`,
				),
			],
		]
			.filter(([, value]) => value !== undefined)
			.map(([label, value]) => (label === "swap used" ? `${label} ${value}M` : `${label} ${value}`)),
		...(maxPressure > 0 ? [`pressure ${PRESSURE_NAMES[maxPressure] ?? maxPressure}`] : []),
		backupd ? "backupd running" : "backupd idle",
	];
	return `${inWindow.length} samples: ${parts.join(", ")}`;
}

export function pruneRuns(root: string, keep: number): void
{
	// Run dirs are ISO timestamps, so name order is age order. tsconfig targets es2022 (no Array#toSorted).
	// eslint-disable-next-line unicorn/no-array-sort -- sorts readdirSync's fresh array
	const runs = readdirSync(root).sort();
	for (const name of runs.slice(0, Math.max(0, runs.length - keep)))
	{
		rmSync(
			path.join(root, name),
			{
				recursive: true,
				force: true,
			},
		);
	}
}

// Spread into a package's vitest `test` options: under the runner below, each package also writes a JSON report.
export function diagnosticsVitestOptions(
	packageName: string,
	env: NodeJS.ProcessEnv = process.env,
):
{
	reporters?: string[];
	outputFile?:
	{
		json: string;
	};
}
{
	const dir = env.WIP_TEST_DIAGNOSTICS_DIR;
	return dir
		?
			{
				reporters: ["default", "json"],
				outputFile:
				{
					json: path.join(dir, `${packageName}.json`),
				},
			}
		: {};
}

function timeoutLines(dir: string, samples: MachineSample[]): string[]
{
	const lines: string[] = [];
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")))
	{
		let report: JsonReport;
		try
		{
			report = jsonReportSchema.parse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
		}
		catch
		{
			continue;
		}
		for (const timeout of findTimeouts(report))
		{
			const window = `${new Date(timeout.startMs).toLocaleTimeString()}-${new Date(timeout.endMs).toLocaleTimeString()}`;
			lines.push(
				`test diagnostics: ${dir}: ${path.basename(timeout.file)} > ${timeout.test} timed out (~${window}): ${summarizeWindow(samples, timeout.startMs, timeout.endMs, WINDOW_PADDING_MS)}`,
			);
		}
	}
	return lines;
}

async function main(): Promise<void>
{
	const repoRoot = path.resolve(import.meta.dirname, "../../../..");
	const root = path.join(repoRoot, ".llm", "test-diagnostics");
	mkdirSync(
		root,
		{
			recursive: true,
		},
	);
	const dir = path.join(
		root,
		new Date()
			.toISOString()
			.replaceAll(":", "-")
			.replace(/\.\d+Z$/, ""),
	);
	mkdirSync(
		dir,
		{
			recursive: true,
		},
	);
	pruneRuns(root, RUNS_TO_KEEP);

	const samplesFile = path.join(dir, "samples.jsonl");
	const samples: MachineSample[] = [];
	const sampler = startSampler(
		{
			intervalMs: 1000,
			sample: sampleMachine,
			onSample: (s) =>
			{
				samples.push(s);
				appendFileSync(samplesFile, `${JSON.stringify(s)}\n`);
			},
		},
	);

	const child = spawn(
		"pnpm",
		["-r", "run", "test", ...process.argv.slice(2)],
		{
			cwd: repoRoot,
			stdio: "inherit",
			env:
			{
				...process.env,
				WIP_TEST_DIAGNOSTICS_DIR: dir,
			},
		},
	);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
	{
		process.on(signal, () => child.kill(signal));
	}
	const code = await new Promise<number>((resolve) =>
	{
		child.on("exit", (exitCode, signal) =>
		{
			resolve(exitCode ?? (signal ? 1 : 0));
		});
		child.on("error", () =>
		{
			resolve(1);
		});
	});
	await sampler.stop();

	if (code !== 0 && existsSync(dir))
	{
		const lines = timeoutLines(dir, samples);
		console.error(lines.length > 0 ? lines.join("\n") : `test diagnostics: ${dir}`);
	}
	process.exit(code);
}

if (import.meta.main)
{
	await main();
}
