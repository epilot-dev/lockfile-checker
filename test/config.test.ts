import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';

const V = '1.2.3';

describe('parseConfig — precedence', () => {
  it('uses defaults when nothing supplied', () => {
    const r = parseConfig([], {}, V);
    expect(r.kind).toBe('config');
    if (r.kind !== 'config') throw new Error('unreachable');
    expect(r.config.mode).toBe('scan');
    expect(r.config.baseRef).toBeNull();
    expect(r.config.minAgeHours).toBe(168);
    expect(r.config.concurrency).toBe(8);
    expect(r.config.registry).toBe('https://registry.npmjs.org');
    expect(r.config.failOnRegistryError).toBe(false);
    expect(r.config.quiet).toBe(false);
    expect([...r.config.allowedScopes]).toEqual([]);
    expect(r.config.allowedPackages.size).toBe(0);
  });

  it('CLI flag overrides env var which overrides default (min-age)', () => {
    const fromEnv = parseConfig([], { MIN_PACKAGE_AGE_HOURS: '24' }, V);
    if (fromEnv.kind !== 'config') throw new Error('unreachable');
    expect(fromEnv.config.minAgeHours).toBe(24);

    const fromFlag = parseConfig(
      ['--min-age', '48'],
      { MIN_PACKAGE_AGE_HOURS: '24' },
      V,
    );
    if (fromFlag.kind !== 'config') throw new Error('unreachable');
    expect(fromFlag.config.minAgeHours).toBe(48);
  });

  it('--base or BASE_REF puts the tool in diff mode', () => {
    const fromFlag = parseConfig(['--base', 'origin/main'], {}, V);
    if (fromFlag.kind !== 'config') throw new Error('unreachable');
    expect(fromFlag.config.mode).toBe('diff');
    expect(fromFlag.config.baseRef).toBe('origin/main');

    const fromEnv = parseConfig([], { BASE_REF: 'abc1234' }, V);
    if (fromEnv.kind !== 'config') throw new Error('unreachable');
    expect(fromEnv.config.mode).toBe('diff');
    expect(fromEnv.config.baseRef).toBe('abc1234');
  });

  it('missing --base / empty BASE_REF stays in scan mode', () => {
    const empty = parseConfig([], { BASE_REF: '' }, V);
    if (empty.kind !== 'config') throw new Error('unreachable');
    expect(empty.config.mode).toBe('scan');
    expect(empty.config.baseRef).toBeNull();

    const whitespace = parseConfig([], { BASE_REF: '   ' }, V);
    if (whitespace.kind !== 'config') throw new Error('unreachable');
    expect(whitespace.config.mode).toBe('scan');
  });

  it('--allow and ALLOWED_PACKAGES tolerate whitespace and empty entries', () => {
    const r = parseConfig(['--allow', ' foo , bar ,,baz '], {}, V);
    if (r.kind !== 'config') throw new Error('unreachable');
    expect([...r.config.allowedPackages].sort()).toEqual(['bar', 'baz', 'foo']);
  });

  it('--allow-scope sets the allowed scopes list', () => {
    const r = parseConfig(['--allow-scope', '@acme,@corp'], {}, V);
    if (r.kind !== 'config') throw new Error('unreachable');
    expect([...r.config.allowedScopes].sort()).toEqual(['@acme', '@corp']);
  });

  it('ALLOWED_SCOPES env sets the allowed scopes list', () => {
    const r = parseConfig([], { ALLOWED_SCOPES: '@acme' }, V);
    if (r.kind !== 'config') throw new Error('unreachable');
    expect([...r.config.allowedScopes]).toEqual(['@acme']);
  });

  it('--fail-on-registry-error and FAIL_ON_REGISTRY_ERROR=true', () => {
    const fromFlag = parseConfig(['--fail-on-registry-error'], {}, V);
    if (fromFlag.kind !== 'config') throw new Error('unreachable');
    expect(fromFlag.config.failOnRegistryError).toBe(true);

    const fromEnv = parseConfig([], { FAIL_ON_REGISTRY_ERROR: 'true' }, V);
    if (fromEnv.kind !== 'config') throw new Error('unreachable');
    expect(fromEnv.config.failOnRegistryError).toBe(true);

    const fromEnvFalse = parseConfig([], { FAIL_ON_REGISTRY_ERROR: 'false' }, V);
    if (fromEnvFalse.kind !== 'config') throw new Error('unreachable');
    expect(fromEnvFalse.config.failOnRegistryError).toBe(false);
  });

  it('--quiet and QUIET=1', () => {
    const fromFlag = parseConfig(['--quiet'], {}, V);
    if (fromFlag.kind !== 'config') throw new Error('unreachable');
    expect(fromFlag.config.quiet).toBe(true);

    const fromEnv = parseConfig([], { QUIET: '1' }, V);
    if (fromEnv.kind !== 'config') throw new Error('unreachable');
    expect(fromEnv.config.quiet).toBe(true);
  });

  it('--registry overrides env and default; trailing slash stripped', () => {
    const fromFlag = parseConfig(['--registry', 'https://r.example/'], {}, V);
    if (fromFlag.kind !== 'config') throw new Error('unreachable');
    expect(fromFlag.config.registry).toBe('https://r.example');
  });

  it('--concurrency must be a positive integer', () => {
    const ok = parseConfig(['--concurrency', '12'], {}, V);
    if (ok.kind !== 'config') throw new Error('unreachable');
    expect(ok.config.concurrency).toBe(12);

    const bad = parseConfig(['--concurrency', '0'], {}, V);
    expect(bad.kind).toBe('error');

    const negative = parseConfig(['--concurrency', '-3'], {}, V);
    expect(negative.kind).toBe('error');

    const nonNumeric = parseConfig(['--concurrency', 'lots'], {}, V);
    expect(nonNumeric.kind).toBe('error');
  });

  it('--min-age must be a non-negative number', () => {
    const ok = parseConfig(['--min-age', '0'], {}, V);
    if (ok.kind !== 'config') throw new Error('unreachable');
    expect(ok.config.minAgeHours).toBe(0);

    const bad = parseConfig(['--min-age', 'soon'], {}, V);
    expect(bad.kind).toBe('error');

    const negative = parseConfig(['--min-age', '-1'], {}, V);
    expect(negative.kind).toBe('error');
  });

  it('unknown flag → error', () => {
    const r = parseConfig(['--what'], {}, V);
    expect(r.kind).toBe('error');
  });

  it('--help and --version short-circuit', () => {
    expect(parseConfig(['--help'], {}, V).kind).toBe('help');
    const v = parseConfig(['--version'], {}, V);
    expect(v.kind).toBe('version');
    if (v.kind !== 'version') throw new Error('unreachable');
    expect(v.message).toBe(V);
  });
});
