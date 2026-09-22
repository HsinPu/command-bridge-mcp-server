import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = process.env.GITHUB_SHA;
if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Only a verified main push may publish the install channel.');
git('fetch', 'origin', 'main');
git('merge-base', '--is-ancestor', sha, 'origin/main');
const version = JSON.parse(git('show', `${sha}:package.json`)).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid package version.');
let parent;
if (git('ls-remote', '--heads', 'origin', 'install-channel')) {
  git('fetch', 'origin', 'install-channel');
  parent = git('rev-parse', 'FETCH_HEAD');
  const previous = git('show', `${parent}:channel.txt`).split('\n')[0];
  if (!/^[a-f0-9]{40}$/.test(previous)) throw new Error('Invalid previous channel.');
  if (previous === sha) process.exit(0);
  try { git('merge-base', '--is-ancestor', previous, sha); }
  catch {
    git('merge-base', '--is-ancestor', sha, previous);
    console.log('A newer verified commit is already published.');
    process.exit(0);
  }
}
const input = `${sha}\n${version}\n`;
const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input, encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['mktree'], { input: `100644 blob ${blob}\tchannel.txt\n`, encoding: 'utf8' }).trim();
const commit = git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Verified installation ${version} (${sha})`);
// Normal fast-forward push: a concurrent writer cannot be overwritten.
git('push', 'origin', `${commit}:refs/heads/install-channel`);
