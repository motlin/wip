import { execa, type Options } from "execa";
import { SpanStatusCode } from "@opentelemetry/api";

import { getTracer } from "./telemetry.js";

export interface ExecaResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed: boolean;
  command: string;
}

export async function tracedExeca(
  command: string,
  args: string[],
  options?: Options,
): Promise<ExecaResult> {
  const tracer = getTracer();
  return tracer.startActiveSpan(`subprocess: ${command}`, async (span) => {
    span.setAttributes({
      "subprocess.command": command,
      "subprocess.args": args.join(" "),
    });

    const start = performance.now();
    try {
      const result = await execa(command, args, options);
      const duration = Math.round(performance.now() - start);
      span.setAttributes({
        "subprocess.exit_code": result.exitCode,
        "subprocess.duration_ms": duration,
      });
      return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        exitCode: result.exitCode ?? 0,
        failed: result.failed,
        command: result.command,
      };
    } catch (error) {
      const duration = Math.round(performance.now() - start);
      const execaError = error as {
        exitCode?: number;
        message: string;
        stdout?: string;
        stderr?: string;
        command?: string;
      };
      span.setAttributes({
        "subprocess.exit_code": execaError.exitCode ?? -1,
        "subprocess.duration_ms": duration,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: execaError.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
