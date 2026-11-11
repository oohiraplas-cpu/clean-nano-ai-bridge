'use strict';
// Finds a real, usable Python interpreter for tests that must actually execute a Python
// script (CI workflow extraction scripts, the PAC worker). Never trusts that a command name
// merely resolves on PATH: on Windows, `python3`/`python` can resolve to the Microsoft Store
// App Execution Alias stub, which exits non-zero and never prints a version string even
// though a real interpreter may be installed (just not first on PATH) — so this also probes
// standard Windows install directories directly via the filesystem. Mockable via `runner`
// (and `platform`/`env`/`fsImpl`) so the lookup itself is testable without any Python installed.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERSION_PATTERN = /Python 3\.\d/;

/** Candidate commands to try, in order. POWERAPPS_RUNTIME_PYTHON (if set) is tried first. */
function candidatesForPlatform(platform = process.platform, env = process.env) {
  const candidates = [];
  if (typeof env.POWERAPPS_RUNTIME_PYTHON === 'string' && env.POWERAPPS_RUNTIME_PYTHON.trim()) {
    candidates.push([env.POWERAPPS_RUNTIME_PYTHON.trim()]);
  }
  candidates.push(['python3']);
  candidates.push(['python']);
  if (platform === 'win32') candidates.push(['py', '-3']);
  return candidates;
}

/** Windows often has a real interpreter installed but not first (or at all) on PATH. */
function findWindowsPythonExe(env = process.env, fsImpl = fs) {
  const roots = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Python'),
    env.ProgramFiles,
    env['ProgramFiles(x86)']
  ].filter(Boolean);
  for (const root of roots) {
    let entries;
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const pythonDirs = entries
      .filter((e) => e.isDirectory() && /^Python3/i.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const dir of pythonDirs) {
      const exe = path.join(root, dir, 'python.exe');
      if (fsImpl.existsSync(exe)) return exe;
    }
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {string} [options.platform] - defaults to process.platform
 * @param {object} [options.env] - defaults to process.env
 * @param {function} [options.runner] - defaults to node:child_process.spawnSync; inject a fake for tests
 * @param {object} [options.fsImpl] - defaults to node:fs; inject a fake for tests
 * @returns {{command: string, args: string[], display: string}|null}
 */
function findPythonInterpreter({ platform = process.platform, env = process.env, runner = spawnSync, fsImpl = fs } = {}) {
  const candidates = candidatesForPlatform(platform, env);
  if (platform === 'win32') {
    const exe = findWindowsPythonExe(env, fsImpl);
    if (exe) candidates.push([exe]);
  }
  for (const [command, ...args] of candidates) {
    let result;
    try {
      result = runner(command, [...args, '--version'], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (!result || result.error) continue;
    const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0 && VERSION_PATTERN.test(text)) {
      return { command, args: [...args], display: [command, ...args].join(' ') };
    }
  }
  return null;
}

module.exports = { findPythonInterpreter, candidatesForPlatform, findWindowsPythonExe, VERSION_PATTERN };
