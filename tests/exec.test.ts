import { describe, it, expect } from 'vitest';
import { execCommand, execCommandFull } from '../src/utils/exec.js';

describe('execCommand', () => {
  it('should execute a simple command and return stdout', async () => {
    const result = await execCommand('echo', ['hello']);
    expect(result.trim()).toBe('hello');
  });

  it('should reject on non-zero exit code', async () => {
    await expect(execCommand('sh -c "exit 1"', [])).rejects.toThrow();
  });

  it('should handle shell commands', async () => {
    const result = await execCommand('echo', ['foo bar']);
    expect(result.trim()).toBe('foo bar');
  });
});

describe('execCommandFull', () => {
  it('should return full result with exit code 0 on success', async () => {
    const result = await execCommandFull('echo', ['test']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('test');
  });

  it('should return non-zero exit code without throwing', async () => {
    const result = await execCommandFull('sh -c "exit 42"', []);
    expect(result.code).toBe(42);
  });

  it('should capture stderr', async () => {
    const result = await execCommandFull('sh -c "echo error >&2"', []);
    expect(result.stderr.trim()).toBe('error');
  });
});
