import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AUDIT_ARCH_X86_64,
  buildDefaultSeccompProgram,
  CLONE_NAMESPACE_MASK,
  DEFAULT_DENIED_SYSCALLS_X64,
  loadSeccompProfile,
  SECCOMP_RET_ALLOW,
  SECCOMP_RET_ERRNO_EPERM,
  SECCOMP_RET_KILL_PROCESS,
  seccompSupportedOnThisHost,
} from './sandbox-seccomp.js';

interface Insn {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

function decode(blob: Buffer): Insn[] {
  const out: Insn[] = [];
  for (let i = 0; i < blob.length; i += 8) {
    out.push({
      code: blob.readUInt16LE(i),
      jt: blob.readUInt8(i + 2),
      jf: blob.readUInt8(i + 3),
      k: blob.readUInt32LE(i + 4),
    });
  }
  return out;
}

test('buildDefaultSeccompProgram emits raw cBPF instructions (len % 8 === 0)', () => {
  const blob = buildDefaultSeccompProgram();
  assert.equal(blob.length % 8, 0);
  assert.ok(blob.length > 8 * 10);
});

test('buildDefaultSeccompProgram is deterministic', () => {
  assert.deepEqual(buildDefaultSeccompProgram(), buildDefaultSeccompProgram());
});

test('generated program gates on AUDIT_ARCH_X86_64 then kills foreign arches', () => {
  const insns = decode(buildDefaultSeccompProgram());
  // insn 0: load arch word
  assert.deepEqual(insns[0], { code: 0x20, jt: 0, jf: 0, k: 4 });
  // insn 1: JEQ AUDIT_ARCH_X86_64 → skip the KILL below
  assert.equal(insns[1].code, 0x15);
  assert.equal(insns[1].k, AUDIT_ARCH_X86_64);
  assert.equal(insns[1].jt, 1);
  assert.equal(insns[1].jf, 0);
  // insn 2: non-x64 arch is killed outright
  assert.deepEqual(insns[2], { code: 0x06, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS });
});

test('every denied syscall number appears in the JEQ chain and lands on EPERM', () => {
  const insns = decode(buildDefaultSeccompProgram());
  const D = DEFAULT_DENIED_SYSCALLS_X64.length;
  const denyIdx = 9 + D;
  assert.equal(insns[denyIdx].k, SECCOMP_RET_ERRNO_EPERM);
  assert.equal(insns[denyIdx].code, 0x06);
  for (let i = 0; i < D; i++) {
    const insn = insns[5 + i];
    assert.equal(insn.code, 0x15, `insn ${5 + i} must be JEQ`);
    assert.equal(insn.k, DEFAULT_DENIED_SYSCALLS_X64[i].nr, `deny chain entry ${i}`);
    // forward jump must land exactly on the shared EPERM return
    assert.equal(5 + i + 1 + insn.jt, denyIdx);
  }
});

test('mount/unmount/module/keyctl-class syscalls are denied by default', () => {
  const nrs = new Set(DEFAULT_DENIED_SYSCALLS_X64.map((s) => s.nr));
  for (const nr of [165, 166, 175, 176, 250, 272, 308, 101]) {
    assert.ok(nrs.has(nr), `expected nr ${nr} denied`);
  }
  // syscall numbers a normal build needs must NOT be denied
  for (const nr of [0, 1, 56, 57, 59, 158]) {
    assert.ok(!nrs.has(nr), `nr ${nr} must stay allowed`);
  }
});

test('clone() carrying CLONE_NEW* flags is denied; plain clone is allowed', () => {
  const insns = decode(buildDefaultSeccompProgram());
  const D = DEFAULT_DENIED_SYSCALLS_X64.length;
  const cloneJeq = insns[5 + D];
  assert.equal(cloneJeq.code, 0x15);
  assert.equal(cloneJeq.k, 56); // __NR_clone on x86_64
  const argsLoad = insns[7 + D];
  assert.deepEqual(argsLoad, { code: 0x20, jt: 0, jf: 0, k: 16 }); // args[0] low word
  const jset = insns[8 + D];
  assert.equal(jset.code, 0x45); // BPF_JSET
  assert.equal(jset.k, CLONE_NAMESPACE_MASK);
});

test('the x32-ABI escape hatch is blocked via the nr high bit', () => {
  const insns = decode(buildDefaultSeccompProgram());
  const x32Jset = insns[4];
  assert.equal(x32Jset.code, 0x45);
  assert.equal(x32Jset.k, 0x40000000);
});

test('program terminates every path in a RET', () => {
  const insns = decode(buildDefaultSeccompProgram());
  const D = DEFAULT_DENIED_SYSCALLS_X64.length;
  assert.equal(insns[6 + D].k, SECCOMP_RET_ALLOW); // non-denied syscall
  assert.equal(insns[9 + D].k, SECCOMP_RET_ERRNO_EPERM); // deny
  assert.equal(insns[10 + D].k, SECCOMP_RET_ALLOW); // plain clone
});

test('loadSeccompProfile accepts an 8-byte-aligned blob and rejects malformed ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc-seccomp-'));
  try {
    const good = path.join(dir, 'good.bpf');
    writeFileSync(good, Buffer.alloc(16));
    assert.equal(loadSeccompProfile(good).length, 16);

    const bad = path.join(dir, 'bad.bpf');
    writeFileSync(bad, Buffer.alloc(7));
    assert.throws(() => loadSeccompProfile(bad), /multiple of 8/);

    const empty = path.join(dir, 'empty.bpf');
    writeFileSync(empty, Buffer.alloc(0));
    assert.throws(() => loadSeccompProfile(empty), /non-empty/);

    assert.throws(() => loadSeccompProfile(path.join(dir, 'missing.bpf')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seccompSupportedOnThisHost is linux/x64 only', () => {
  assert.equal(seccompSupportedOnThisHost('linux', 'x64'), true);
  assert.equal(seccompSupportedOnThisHost('linux', 'arm64'), false);
  assert.equal(seccompSupportedOnThisHost('darwin', 'x64'), false);
  assert.equal(seccompSupportedOnThisHost('win32', 'x64'), false);
});
