import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { recoveryConfiguration } from '../src/lib/portable-recovery/configuration';
import { loadPortableSchema } from '../src/lib/portable-recovery/schema';
import { assertNativeEmptyDestination } from '../src/lib/portable-recovery/startup-guard';
import { assertDirectoryChain, initializeRecoveryInstance, recoveryStateFiles } from '../src/lib/portable-recovery/storage';
import { RecoveryError } from '../src/lib/portable-recovery/types';

/** This entry point runs before normal startup reads an env file, seeds, migrates or schedules jobs. */
async function main(): Promise<void> {
  const config = recoveryConfiguration(), registry = await loadPortableSchema();
  const schemaState = await assertNativeEmptyDestination(config, registry);
  await initializeRecoveryInstance(config);
  if ((await recoveryStateFiles(config)).length) throw new RecoveryError('RECOVERY_ALREADY_STARTED', 'Recovery state already exists. Review it before restarting or activating this destination.', 409);
  const startupLock = path.join(config.stateDir, 'startup.lock');
  await fs.mkdir(startupLock, { mode: 0o700 });

  // These explicit values also prevent dotenv/Next from restoring normal persisted settings.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: config.databaseUrl, DATABASE_PROVIDER: config.provider,
    LOG_DATABASE_URL: config.databaseUrl, ENC_HASH: '', JWT_SECRET: '', ENABLE_LOG: 'false', ENABLE_NOTIFICATIONS: 'false',
    BABYTRACKER_OCR_FILES_DIR: path.join(config.filesRoot, 'ocr') };
  const run = (args: string[]) => new Promise<void>((resolve, reject) => {
    // CLI output may contain a connection URL. Emit only the bounded stage name below.
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: 'ignore' });
    child.once('error', () => reject(new RecoveryError('RECOVERY_SCHEMA_SETUP_FAILED', 'Recovery schema preparation could not start.', 503)));
    child.once('exit', code => code === 0 ? resolve() : reject(new RecoveryError('RECOVERY_SCHEMA_SETUP_FAILED', 'Recovery schema preparation failed. Its startup lock is retained for operator review.', 503)));
  });
  if (config.databasePath) {
    await assertDirectoryChain(path.dirname(config.databasePath), true);
    await fs.mkdir(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
    await assertDirectoryChain(path.dirname(config.databasePath));
  }
  console.info('Preparing the isolated recovery schema. No seed data will be created.');
  await run(['scripts/prisma-provider.js']);
  await run(['node_modules/prisma/build/index.js', 'generate']);
  // Only generate the log client; never connect or push a diagnostic-log database.
  await run(['node_modules/prisma/build/index.js', 'generate', '--config', 'prisma/log.config.ts']);
  // Recheck immediately before DDL. A changed or populated target is never synchronized.
  if (await assertNativeEmptyDestination(config, registry) !== schemaState) throw new RecoveryError('DESTINATION_CHANGED', 'The recovery schema changed during startup.', 409);
  if (schemaState === 'fresh') {
    await run(config.provider === 'sqlite'
      ? ['node_modules/prisma/build/index.js', 'migrate', 'deploy']
      : ['node_modules/prisma/build/index.js', 'db', 'push']);
  }
  if (await assertNativeEmptyDestination(config, registry) !== 'current-empty') throw new RecoveryError('INCOMPLETE_RECOVERY_SCHEMA', 'The recovery schema is incomplete.', 409);
  if (config.databasePath && process.platform !== 'win32') await fs.chmod(config.databasePath, 0o600);
  await fs.rmdir(startupLock);

  const command = process.argv.slice(2);
  if (!command.length) command.push('npm', 'start');
  console.info('Recovery mode is ready. Normal application access remains disabled.');
  const server = spawn(command[0], command.slice(1), { cwd: process.cwd(), env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.kill(signal));
  server.once('error', () => { console.error('Recovery server could not start.'); process.exitCode = 1; });
  server.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
}

main().catch(error => {
  console.error(error instanceof RecoveryError ? `${error.code}: ${error.message}` : 'RECOVERY_STARTUP_FAILED: Recovery startup was blocked before normal application initialization.');
  process.exitCode = 1;
});
