import { describe, expect, it, vi } from 'vitest';
import { killTree, ownGroup } from '../src/core/process-tree.js';
import { defaultShell, posixSh } from '../src/terminal/pty.js';

const only = (...files: string[]) => (file: string) => files.includes(file);

describe('shells on Windows and Linux', () => {
  it('picks PowerShell 7, then Windows PowerShell, then cmd for the terminal on Windows', () => {
    const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    expect(defaultShell(env, 'win32', only('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(defaultShell(env, 'win32', only('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))).toMatch(/powershell\.exe$/);
    expect(defaultShell(env, 'win32', only())).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('keeps $SHELL, then zsh, bash and sh elsewhere', () => {
    expect(defaultShell({ SHELL: '/usr/bin/fish' }, 'linux', only('/usr/bin/fish'))).toBe('/usr/bin/fish');
    expect(defaultShell({}, 'linux', only('/bin/bash'))).toBe('/bin/bash');
    expect(defaultShell({}, 'linux', only())).toBe('/bin/sh');
  });

  it('runs sh commands in Git Bash on Windows, the one Claude Code uses', () => {
    expect(posixSh({}, 'linux')).toBe('/bin/sh');
    expect(posixSh({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe' }, 'win32', only('D:\\Git\\bin\\bash.exe'))).toBe('D:\\Git\\bin\\bash.exe');
    expect(posixSh({ ProgramFiles: 'C:\\Program Files' }, 'win32', only('C:\\Program Files\\Git\\bin\\bash.exe'))).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(posixSh({}, 'win32', only())).toBeUndefined();
  });
});

describe('stopping a command with everything it started', () => {
  it('signals the process group where there are groups', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killTree({ pid: 4242, kill: () => true }, 'linux');
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    kill.mockRestore();
    expect(ownGroup('darwin')).toBe(true);
    expect(ownGroup('win32')).toBe(false);
  });

  it('kills the child itself when it never started', () => {
    const child = { pid: undefined, kill: vi.fn(() => true) };
    killTree(child, 'win32');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
