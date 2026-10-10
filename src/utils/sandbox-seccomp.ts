// #423 — seccomp profile generation for sandboxed `run_shell` commands.
//
// Emits a raw classic-BPF program (`struct sock_filter[]`) in the exact wire
// format bubblewrap's `--seccomp FD` expects: a flat sequence of 8-byte
// instructions, little-endian (native order on x86_64), no `sock_fprog`
// header — bwrap computes the instruction count as `len / 8` itself.
//
// Policy shape (default profile):
//   - non-x86_64 arch or x32-ABI syscall numbers  → SECCOMP_RET_KILL_PROCESS
//   - denied syscall numbers                       → SECCOMP_RET_ERRNO(EPERM)
//   - clone() carrying any CLONE_NEW* flag         → SECCOMP_RET_ERRNO(EPERM)
//   - everything else                              → SECCOMP_RET_ALLOW
//
// The denylist targets privilege-escalation / namespace-escape / kernel-attack-
// surface syscalls; it intentionally stays permissive for anything a build or
// test command legitimately needs (fork/clone/execve/memfd_create/prctl are
// all allowed).

import { readFileSync } from 'node:fs';

// cBPF opcodes (linux/bpf_common.h / bpf.h).
const BPF_LD_W_ABS = 0x20; // BPF_LD | BPF_W | BPF_ABS
const BPF_JMP_JEQ_K = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const BPF_JMP_JSET_K = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const BPF_RET_K = 0x06; // BPF_RET | BPF_K

// seccomp return actions (linux/seccomp.h).
export const SECCOMP_RET_KILL_PROCESS = 0x80000000;
export const SECCOMP_RET_ERRNO_EPERM = 0x00050000 | 1; // SECCOMP_RET_ERRNO | EPERM
export const SECCOMP_RET_ALLOW = 0x7fff0000;

// seccomp_data field offsets + audit arch constants (linux/seccomp.h, audit.h).
export const SECCOMP_DATA_NR_OFFSET = 0;
export const SECCOMP_DATA_ARCH_OFFSET = 4;
export const SECCOMP_DATA_ARGS_OFFSET = 16; // args[0] low word
export const AUDIT_ARCH_X86_64 = 0xc000003e;
export const X32_SYSCALL_BIT = 0x40000000;

// CLONE_NEW* flags (linux/sched.h) — any of these on clone() means the child
// is trying to re-namespace itself out of the sandbox.
export const CLONE_NEWNS = 0x00020000;
export const CLONE_NEWCGROUP = 0x02000000;
export const CLONE_NEWUTS = 0x04000000;
export const CLONE_NEWIPC = 0x08000000;
export const CLONE_NEWUSER = 0x10000000;
export const CLONE_NEWPID = 0x20000000;
export const CLONE_NEWNET = 0x40000000;
export const CLONE_NAMESPACE_MASK =
  CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET;

const SYS_clone_x64 = 56;

/**
 * x86_64 syscall numbers denied by the default profile. Sorted ascending —
 * keeping the table sorted keeps the generated BPF chain deterministic and
 * makes the list auditable at a glance.
 */
export const DEFAULT_DENIED_SYSCALLS_X64: ReadonlyArray<{ name: string; nr: number }> = [
  { name: 'ptrace', nr: 101 },
  { name: 'syslog', nr: 103 },
  { name: 'personality', nr: 135 },
  { name: 'vhangup', nr: 153 },
  { name: 'modify_ldt', nr: 154 },
  { name: 'pivot_root', nr: 155 },
  { name: '_sysctl', nr: 156 },
  { name: 'adjtimex', nr: 159 },
  { name: 'chroot', nr: 161 },
  { name: 'acct', nr: 163 },
  { name: 'settimeofday', nr: 164 },
  { name: 'mount', nr: 165 },
  { name: 'umount2', nr: 166 },
  { name: 'swapon', nr: 167 },
  { name: 'swapoff', nr: 168 },
  { name: 'reboot', nr: 169 },
  { name: 'sethostname', nr: 170 },
  { name: 'setdomainname', nr: 171 },
  { name: 'iopl', nr: 172 },
  { name: 'ioperm', nr: 173 },
  { name: 'create_module', nr: 174 },
  { name: 'init_module', nr: 175 },
  { name: 'delete_module', nr: 176 },
  { name: 'get_kernel_syms', nr: 177 },
  { name: 'query_module', nr: 178 },
  { name: 'quotactl', nr: 179 },
  { name: 'nfsservctl', nr: 180 },
  { name: 'lookup_dcookie', nr: 212 },
  { name: 'clock_settime', nr: 227 },
  { name: 'mbind', nr: 237 },
  { name: 'set_mempolicy', nr: 238 },
  { name: 'kexec_load', nr: 246 },
  { name: 'add_key', nr: 248 },
  { name: 'request_key', nr: 249 },
  { name: 'keyctl', nr: 250 },
  { name: 'migrate_pages', nr: 256 },
  { name: 'unshare', nr: 272 },
  { name: 'move_pages', nr: 279 },
  { name: 'perf_event_open', nr: 298 },
  { name: 'clock_adjtime', nr: 305 },
  { name: 'setns', nr: 308 },
  { name: 'process_vm_readv', nr: 310 },
  { name: 'process_vm_writev', nr: 311 },
  { name: 'kcmp', nr: 312 },
  { name: 'finit_module', nr: 313 },
  { name: 'kexec_file_load', nr: 320 },
  { name: 'bpf', nr: 321 },
  { name: 'userfaultfd', nr: 323 },
  { name: 'io_uring_setup', nr: 425 },
  { name: 'io_uring_enter', nr: 426 },
  { name: 'io_uring_register', nr: 427 },
  { name: 'open_tree', nr: 428 },
  { name: 'move_mount', nr: 429 },
  { name: 'fsopen', nr: 430 },
  { name: 'fsconfig', nr: 431 },
  { name: 'fsmount', nr: 432 },
  { name: 'fspick', nr: 433 },
  { name: 'mount_setattr', nr: 442 },
  { name: 'quotactl_fd', nr: 443 },
];

/**
 * Serialize a single `struct sock_filter` (8 bytes, little-endian).
 * Buffer is zero-initialized so the padding semantics are explicit.
 */
function insn(code: number, k: number, jt = 0, jf = 0): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(code, 0);
  b.writeUInt8(jt, 2);
  b.writeUInt8(jf, 3);
  b.writeUInt32LE(k >>> 0, 4);
  return b;
}

const ret = (k: number) => insn(BPF_RET_K, k);
const ldW = (offset: number) => insn(BPF_LD_W_ABS, offset);

/**
 * Build the default sandbox seccomp program as raw cBPF bytes.
 *
 * Program layout (D = denied list length, N = 5 + D is the JEQ-chain tail):
 *
 *   0      LD   W ABS 4                     ; A = arch
 *   1      JEQ  AUDIT_ARCH_X86_64  jt=1 jf=0 ; x64 → insn 3, else → insn 2
 *   2      RET  KILL_PROCESS                 ; foreign arch (i386/aarch64 compat): can't filter safely
 *   3      LD   W ABS 0                     ; A = nr
 *   4      JSET X32_SYSCALL_BIT  jt→deny jf=0 ; x32 ABI numbers bypass nr checks
 *   5..    JEQ  <denied nr>      jt→deny jf=0 ; linear deny chain
 *   5+D    JEQ  clone            jt=1  jf=0  ; clone needs arg inspection
 *   6+D    RET  ALLOW                        ; non-denied, non-clone
 *   7+D    LD   W ABS 16                    ; A = clone flags (args[0] low)
 *   8+D    JSET CLONE_NAMESPACE_MASK jt=0 jf=1 ; ns-clone → deny, plain clone → allow
 *   9+D    RET  ERRNO(EPERM)                 ; shared deny target
 *   10+D   RET  ALLOW                        ; plain clone lands here
 *
 * cBPF only jumps forward, so the deny target sits at the end.
 */
export function buildDefaultSeccompProgram(
  denied: ReadonlyArray<{ name: string; nr: number }> = DEFAULT_DENIED_SYSCALLS_X64,
): Buffer {
  const D = denied.length;
  const denyIdx = 9 + D; // index of the shared ERRNO return

  const program: Buffer[] = [
    ldW(SECCOMP_DATA_ARCH_OFFSET),
    insn(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0),
    ret(SECCOMP_RET_KILL_PROCESS),
    ldW(SECCOMP_DATA_NR_OFFSET),
    insn(BPF_JMP_JSET_K, X32_SYSCALL_BIT, denyIdx - 5, 0),
  ];

  for (let i = 0; i < D; i++) {
    program.push(insn(BPF_JMP_JEQ_K, denied[i].nr, denyIdx - (5 + i + 1), 0));
  }

  program.push(
    insn(BPF_JMP_JEQ_K, SYS_clone_x64, 1, 0), // clone → insn 7+D, else fall to ALLOW
    ret(SECCOMP_RET_ALLOW),
    ldW(SECCOMP_DATA_ARGS_OFFSET),
    insn(BPF_JMP_JSET_K, CLONE_NAMESPACE_MASK, 0, 1), // ns flags → next insn (deny); else skip to ALLOW
    ret(SECCOMP_RET_ERRNO_EPERM),
    ret(SECCOMP_RET_ALLOW),
  );

  return Buffer.concat(program);
}

/**
 * Load an operator-supplied cBPF blob (e.g. `seccomp_export_bpf` output) for
 * `sandbox.seccompProfile`. bwrap requires the byte length to be a multiple
 * of 8 — it derives the instruction count from the blob size.
 */
export function loadSeccompProfile(path: string): Buffer {
  const blob = readFileSync(path);
  if (blob.length === 0 || blob.length % 8 !== 0) {
    throw new Error(
      `Invalid seccomp profile "${path}": must be a non-empty cBPF program whose size is a multiple of 8 bytes ` +
        `(as produced by seccomp_export_bpf). Got ${blob.length} bytes.`,
    );
  }
  return blob;
}

/**
 * seccomp filtering is only wired for the x86_64 syscall table generated by
 * {@link buildDefaultSeccompProgram}; a custom profile can override on any
 * platform the operator targets.
 */
export function seccompSupportedOnThisHost(platform: NodeJS.Platform, arch: string): boolean {
  return platform === 'linux' && arch === 'x64';
}
