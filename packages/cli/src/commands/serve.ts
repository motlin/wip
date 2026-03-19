import {Command, Flags} from '@oclif/core';
import {execa} from 'execa';
import * as path from 'node:path';
import * as url from 'node:url';

interface ServeJson {
	port: number;
	webDir: string;
	dryRun: boolean;
}

export default class Serve extends Command {
	static override description = 'Start the WIP dashboard web UI';

	static enableJsonFlag = true;

	static override examples = [
		'<%= config.bin %> serve',
		'<%= config.bin %> serve --port 8080',
		'<%= config.bin %> serve --dry-run',
		'<%= config.bin %> serve --dry-run --json',
	];

	static override flags = {
		'dry-run': Flags.boolean({
			char: 'n',
			default: false,
			description: 'Show what would be started without starting',
		}),
		port: Flags.integer({default: 3456, description: 'Port to serve on'}),
	};

	async run(): Promise<ServeJson> {
		const {flags} = await this.parse(Serve);
		const cliDir = path.dirname(url.fileURLToPath(import.meta.url));
		const webDir = path.resolve(cliDir, '..', '..', '..', 'web');

		if (flags['dry-run']) {
			this.log(`Would start WIP dashboard on http://localhost:${flags.port}`);
			this.log(`  web directory: ${webDir}`);
			return {port: flags.port, webDir, dryRun: true};
		}

		this.log(`Starting WIP dashboard on http://localhost:${flags.port}`);

		await execa('npx', ['vite', '--port', String(flags.port)], {
			cwd: webDir,
			stdio: 'inherit',
		});

		return {port: flags.port, webDir, dryRun: false};
	}
}
