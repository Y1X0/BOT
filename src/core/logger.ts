import pino from 'pino';
import { env, isProd } from '../config/env';

/**
 * Central structured logger.
 * - Pretty, colorized output in development.
 * - JSON (machine-parseable) in production for log aggregators.
 * - Redacts obvious secrets so tokens never leak into logs.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['BOT_TOKEN', 'token', 'req.headers.authorization', '*.password'],
    censor: '[REDACTED]',
  },
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});

/** Create a child logger scoped to a component (plugin, service, middleware). */
export function createLogger(component: string) {
  return logger.child({ component });
}
