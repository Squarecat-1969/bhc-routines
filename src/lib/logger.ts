export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(stream: NodeJS.WriteStream = process.stdout): Logger {
  const write = (level: string, msg: string) => {
    stream.write(`${new Date().toISOString()} ${level} ${msg}\n`);
  };
  return {
    info: (msg) => write('INFO ', msg),
    warn: (msg) => write('WARN ', msg),
    error: (msg) => write('ERROR', msg),
  };
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
