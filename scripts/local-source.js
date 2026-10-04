const { execFileSync } = require('node:child_process');
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 5000000 });
function localSource() {
  const branch = git(['branch', '--show-current']).trim() || 'detached-local-source';
  const commitSha = git(['rev-parse', 'HEAD']).trim();
  const root = 'powerapps/CN_CompanyOS_ElectronicDailyReport/Source';
  const paths = git(['ls-tree', '-r', '--name-only', '-z', commitSha, '--', root]).split('\0').filter(Boolean);
  return {
    branch, commitSha, complete: true,
    source: { host: 'github.com', owner: 'oohiraplas-cpu', repository: 'clean-nano-ai-bridge', root },
    files: paths.map(p => ({ relativePath: p.slice(root.length + 1), content: git(['show', `${commitSha}:${p}`]) }))
  };
}
module.exports = { localSource };
