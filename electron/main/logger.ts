import pino from 'pino';
import path from 'path';
import { getLionClawHome } from './paths';

const isDev = process.env.NODE_ENV === 'development';
const basePath = getLionClawHome();

const transport = isDev
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    })
  : pino.transport({
      target: 'pino/file',
      options: { destination: path.join(basePath, 'data', 'lionclaw.log') },
    });

const rootLogger = pino(
  {
    level: isDev ? 'debug' : 'info',
  },
  transport,
);

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export { rootLogger };
