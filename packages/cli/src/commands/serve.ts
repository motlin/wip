import {Command, Flags} from '@oclif/core';
import {execa} from 'execa';
import * as path from 'node:path';
import * as url from 'node:url';

export default class Serve extends Command {
	static override description = 'Start the WIP dashboard web UI';

	static override examples = ['<%= config.bin %> serve', '<%= config.bin %> serve --port 8080'];

	static override flags = {
		port: Flags.integer({default: 3456, description: 'Port to serve on'}),
	};

	async run(): Promise<void> {
		const {flags} = await this.parse(Serve);
		const cliDir = path.dirname(url.fileURLToPath(import.meta.url));
		const webDir = path.resolve(cliDir, '..', '..', '..', 'web');

		this.log(`Starting WIP dashboard on http://localhost:${flags.port}`);

		await execa('npx', ['vite', '--port', String(flags.port)], {
			cwd: webDir,
			stdio: 'inherit',
		});
	}
}
