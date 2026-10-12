/**
 * Adds a user to users.json and prints the generated access key.
 *
 *   pnpm --filter @concord/api user:add <id> <displayName> [--admin] [--discord-id <id>]
 *
 * The file path comes from USERS_FILE (default: infra/users.json at the repo root).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseUsersFile, USER_ID_PATTERN, type User, type UsersFile } from '../src/auth';

function fail(message: string): never {
  console.error(`Erro: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const discordFlag = args.indexOf('--discord-id');
const discordUserId =
  discordFlag >= 0 && args[discordFlag + 1] !== undefined ? args[discordFlag + 1] : undefined;
const positional = args.filter(
  (arg, index) => !arg.startsWith('--') && index !== discordFlag + 1 && arg !== discordUserId,
);
const [id, ...nameParts] = positional;
const displayName = nameParts.join(' ').trim();

if (!id || !displayName) {
  console.error(
    'Uso: pnpm --filter @concord/api user:add <id> <nome de exibição> [--admin] [--discord-id <id>]',
  );
  process.exit(2);
}
if (!USER_ID_PATTERN.test(id)) {
  fail(
    `id "${id}" inválido: use 2 a 32 caracteres entre a-z, 0-9, "-" e "_", começando com letra ou número.`,
  );
}
if (discordFlag >= 0 && (!discordUserId || !/^\d+$/.test(discordUserId))) {
  fail('discord-id deve ser o ID numérico da conta Discord.');
}

const usersFile = resolve(
  process.cwd(),
  process.env.USERS_FILE?.trim() || '../../infra/users.json',
);

let users: User[] = [];
try {
  users = parseUsersFile(await readFile(usersFile, 'utf8'));
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

if (users.some((user) => user.id === id))
  fail(`já existe um usuário com id "${id}" em ${usersFile}`);

const key = randomBytes(24).toString('base64url');
users.push({ id, displayName, key, admin, ...(discordUserId ? { discordUserId } : {}) });

const file: UsersFile = { users };
await mkdir(dirname(usersFile), { recursive: true });
await writeFile(usersFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

console.log(`Usuário "${displayName}" (${id}${admin ? ', admin' : ''}) adicionado em ${usersFile}`);
console.log('');
console.log('Chave de acesso (envie para a pessoa; para recuperá-la depois, abra o arquivo):');
console.log('');
console.log(`  ${key}`);
