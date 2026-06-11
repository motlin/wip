import pino from "pino";

export type StderrLog = {
  subprocess: pino.Logger;
  progress: pino.Logger;
  general: pino.Logger;
};

/**
 * Builds a pino logger that pretty-prints to stderr. Server-only: this module is
 * loaded exclusively via dynamic import from logger-pino.ts so its node-only
 * dependencies (pino, pino-pretty) are never evaluated in the browser.
 */
export function createStderrLog(): StderrLog {
  const base = pino(
    { level: "debug" },
    pino.transport({
      target: "pino-pretty",
      options: {
        destination: 2,
        sync: true,
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname,category,cmd,args,duration",
        messageFormat: "{msg}",
        singleLine: true,
      },
    }),
  );

  return {
    subprocess: base.child({ category: "subprocess" }),
    progress: base.child({ category: "progress" }),
    general: base.child({ category: "general" }),
  };
}
