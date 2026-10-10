import { buildApp } from './app';
import { UserStore, UsersFileError } from './auth';
import { ConfigError, loadConfig, type ApiConfig } from './config';
import { createRoomService } from './livekit';
import { PresenceStore } from './presence-store';
import { startResync } from './resync';
import { watchUsersFile } from './users-watch';

function fail(message: string): never {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

function readConfig(): ApiConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return fail(
      `configuração inválida — ${err.message}.\n` +
        'Defina as variáveis de ambiente em infra/.env (veja infra/.env.example).',
    );
  }
}

async function readUsers(path: string): Promise<UserStore> {
  try {
    return await UserStore.fromFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail(
        `arquivo de usuários não encontrado em ${path}.\n` +
          'Crie o primeiro usuário com: pnpm --filter @concord/api user:add <id> <nome>',
      );
    }
    if (err instanceof UsersFileError) return fail(`${path}: ${err.message}`);
    throw err;
  }
}

const config = readConfig();
const users = await readUsers(config.usersFile);
const presence = new PresenceStore(config.rooms);
const app = buildApp({ config, users, presence, logger: true });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const resync = startResync({
  presence,
  roomService: createRoomService(config.livekit),
  log: app.log,
});
const usersWatcher = watchUsersFile({ path: config.usersFile, store: users, log: app.log });
app.log.info(
  { rooms: config.rooms, users: users.size, usersFile: config.usersFile },
  'concord-api pronto',
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'encerrando');
  setTimeout(() => process.exit(1), 5000).unref();
  resync.stop();
  usersWatcher.stop();
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
