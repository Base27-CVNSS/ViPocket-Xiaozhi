import { spawn } from 'node:child_process';

const commands = [
  ['gateway', ['--workspace', '@vipocket/gateway', 'run', 'dev']],
  ['web', ['--workspace', '@vipocket/web', 'run', 'dev']]
];

const children = commands.map(([name, args]) => {
  const child = spawn('npm', args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
  return child;
});

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
