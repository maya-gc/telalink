// Imita o "ssh ... nokey@localhost.run" para os testes (sem internet).
// Confere os argumentos de seguranca e imprime um banner parecido com o real,
// incluindo links que NAO sao o endereco do tunel (o parser tem que ignora-los).
const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const remote = args[args.indexOf('-R') + 1] || '';
const problems = [];
if (!has('StrictHostKeyChecking=accept-new')) problems.push('sem StrictHostKeyChecking=accept-new');
if (!args.some((a) => a.startsWith('UserKnownHostsFile='))) problems.push('sem UserKnownHostsFile');
for (const opt of ['PubkeyAuthentication=no', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'PasswordAuthentication=no']) if (!has(opt)) problems.push(`sem ${opt} (chaves pessoais seriam oferecidas)`);
if (args[args.indexOf('-F') + 1] !== 'none') problems.push('sem -F none (leria ~/.ssh/config)');
if (!/^80:127\.0\.0\.1:\d+$/.test(remote)) problems.push(`-R inesperado: ${remote}`);
if (!args.at(-1)?.startsWith('nokey@')) problems.push('destino inesperado');
if (problems.length) { process.stderr.write(`fake-ssh: ${problems.join('; ')}\n`); process.exit(2); }

const out = [
  '===============================================================================',
  'Welcome to localhost.run!',
  'Follow your favourite reverse tunnel at [https://twitter.com/localhost_run].',
  'To set up and manage custom domains go to https://admin.localhost.run/',
  'More details on custom domains (and how to enable subdomains) at https://localhost.run/docs/custom-domains',
  '===============================================================================',
  '',
  '** your connection id is 1d2c3b4a, please mention it if you send me a message about an issue. **',
  '',
  'authenticated as anonymous user',
  'f00dcafe1234ab.lhr.life tunneled with tls termination, https://f00dcafe1234ab.lhr.life',
].join('\n') + '\n';
setTimeout(() => process.stdout.write(out), 50);
setInterval(() => {}, 1000);
