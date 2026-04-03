import pino from "pino";

function isLoggingEnabled(): boolean {
  return process.env["WIP_SUBPROCESS_LOGGING"] === "true";
}

function createLogger() {
  if (!isLoggingEnabled()) {
    return pino({ level: "silent" });
  }

  return pino(
    {
      level: "debug",
    },
    pino.transport({
      target: "pino-pretty",
      options: {
        destination: 2, // stderr
        sync: true,
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname,category,cmd,args,duration",
        messageFormat: "{msg}",
        singleLine: true,
      },
    }),
  );
}

const baseLogger = createLogger();

export const log = {
  subprocess: baseLogger.child({ category: "subprocess" }),
  progress: baseLogger.child({ category: "progress" }),
  general: baseLogger.child({ category: "general" }),
};
