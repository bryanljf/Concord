import { buildApp } from './app';
import { UserStore, UsersFileError } from './auth';
import { ConfigError, loadConfig, type ApiConfig } from './config';
import { startDiscordSync } from './discord-sync';
import { createJamService } from './jam/service';
import { createRoomService } from './livekit';
import type { Logger } from './logger';
import { PresenceStore } from './presence-store';
import { createProfileResolver, ProfileStore } from './profiles';
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

/** Startup logging before Fastify's logger exists. */
const bootLog: Logger = {
  debug: () => undefined,
  info: (obj, msg) => console.log(msg ?? '', obj),
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
};

async function readProfiles(path: string): Promise<ProfileStore> {
  try {
    return await ProfileStore.load(path, bootLog);
  } catch (err) {
    return fail(`não foi possível ler o arquivo de perfis ${path}: ${(err as Error).message}`);
  }
}

const config = readConfig();
const users = await readUsers(config.usersFile);
const profiles = await readProfiles(config.profilesFile);
const presence = new PresenceStore(config.rooms, createProfileResolver(users, profiles));

// The Jam logs through Fastify's logger once it exists (it is loaded before the app listens).
let jamLogTarget: Logger = bootLog;
const jamLog: Logger = {
  debug: (obj, msg) => jamLogTarget.debug(obj, msg),
  info: (obj, msg) => jamLogTarget.info(obj, msg),
  warn: (obj, msg) => jamLogTarget.warn(obj, msg),
  error: (obj, msg) => jamLogTarget.error(obj, msg),
};
const jam = createJamService({ config, presence, log: jamLog });
const app = buildApp({ config, users, presence, profiles, jam, logger: true });
jamLogTarget = app.log.child({ module: 'jam' });

try {
  await jam.start();
} catch (err) {
  app.log.error({ err }, 'could not start the jam; it starts empty');
}

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
const discordSync = config.discordBotToken
  ? startDiscordSync({
      users,
      profiles,
      botToken: config.discordBotToken,
      log: app.log.child({ module: 'discord-sync' }),
    })
  : undefined;
const usersWatcher = watchUsersFile({
  path: config.usersFile,
  store: users,
  log: app.log,
  onReload: () => {
    presence.refreshAll();
    discordSync?.trigger();
  },
});
app.log.info(
  {
    rooms: config.rooms,
    users: users.size,
    usersFile: config.usersFile,
    profilesFile: config.profilesFile,
    discordSync: discordSync !== undefined,
    jam: jam.available,
    jamStateFile: jam.available ? config.jam.stateFile : undefined,
  },
  'concord-api pronto',
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'encerrando');
  setTimeout(() => process.exit(1), 5000).unref();
  resync.stop();
  discordSync?.stop();
  usersWatcher.stop();
  await jam.stop();
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
