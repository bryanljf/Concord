/**
 * Command-line flags understood by the app.
 *
 *   --hidden                  start without showing the window (used by autostart)
 *   --user-data-dir=<path>    separate settings/cache dir (lets two instances run for testing)
 *   --server=<url> --key=<k>  dev only: log in on startup (same code path as the UI login)
 *   --room=<id>               dev only: navigate to a room once the renderer loads
 *
 * Both `--flag=value` and `--flag value` forms are accepted.
 * `CONCORD_USER_DATA_DIR` is an alternative for dev runners that consume unknown CLI flags.
 */
export interface CliArgs {
  hidden: boolean;
  userDataDir?: string;
  server?: string;
  key?: string;
  room?: string;
}

const VALUE_FLAGS = {
  'user-data-dir': 'userDataDir',
  server: 'server',
  key: 'key',
  room: 'room',
} as const;

type ValueFlag = keyof typeof VALUE_FLAGS;

function isValueFlag(name: string): name is ValueFlag {
  return Object.hasOwn(VALUE_FLAGS, name);
}

export function parseCliArgs(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CliArgs {
  const args: CliArgs = { hidden: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === 'hidden') {
      args.hidden = true;
      continue;
    }
    if (!isValueFlag(name)) continue;
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value !== undefined && value !== '') args[VALUE_FLAGS[name]] = value;
  }
  if (args.userDataDir === undefined) {
    const environmentDir = environment.CONCORD_USER_DATA_DIR?.trim();
    if (environmentDir !== undefined && environmentDir !== '') {
      args.userDataDir = environmentDir;
    }
  }
  return args;
}
