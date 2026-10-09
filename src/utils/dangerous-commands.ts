// Dangerous commands blacklist for intelligent permission filtering

export interface DangerousPattern {
  pattern: RegExp;
  category: string;
  description: string;
  severity: 'critical' | 'high' | 'medium';
}

// ── Shared sensitive-path sub-expressions (#473) ─────────────────────────
// Credential/config targets reused by several rules below. HOME_PREFIX
// covers `~`, `~user`, `$HOME`, `${HOME}` and absolute /root|/home/<user>.
const HOME_PREFIX = String.raw`(?:~[^\s/"'\\]*|\$HOME|\$\{HOME\}|/root|/home/[^\s/"'\\]+)`;
const CRED_DIRS = String.raw`\.(?:ssh|gnupg|aws|azure|kube|docker|sc-agent|config|cargo|heroku|netlify)`;
const RC_FILES = String.raw`\.(?:bashrc|zshrc|zprofile|zshenv|zlogin|zlogout|profile|bash_profile|bash_login|gitconfig|git-credentials|netrc|npmrc|yarnrc|pypirc|pgpass|s3cfg|my\.cnf|boto|bash_history|zsh_history|mysql_history|psql_history|python_history|node_repl_history|viminfo|lesshst|env)`;
const KEY_MATERIAL = String.raw`(?:[^\s/"'\\]*\bid_(?:rsa|ed25519|ecdsa|dsa)\b[^\s/"'\\]*|\bauthorized_keys\b|[^\s/"'\\]+\.(?:pem|key|p12|pfx|ppk|jks|kdbx?)\b)`;
const ETC_SECRETS = String.raw`/etc/(?:shadow|gshadow|sudoers|ssh|ssl/private|security|pam\.d|cron)`;
const PROC_ENVIRON = String.raw`/proc/(?:self|\d+|\*)/environ`;
// Read-sensitive: any reference to the targets above.
const SENSITIVE_PATH = String.raw`(?:${HOME_PREFIX}/(?:${CRED_DIRS}|${RC_FILES})|${CRED_DIRS}/|${KEY_MATERIAL}|${ETC_SECRETS}|${PROC_ENVIRON})`;
// Write-sensitive: same set, plus /etc at large (matches the redirect rules).
const SENSITIVE_WRITE_PATH = String.raw`(?:${SENSITIVE_PATH}|/etc/|/root/)`;
// File readers, content processors, archivers and editors that can disclose
// or stage sensitive material.
const READERS = String.raw`(?:cat|head|tail|less|more|bat|xxd|hexdump|od|strings|nl|zcat|bzcat|grep|egrep|fgrep|awk|sed|perl|base64|openssl|gpg|ssh-keygen|tar|zip|gzip|bzip2|xz|7z|rar|nano|pico|vi|vim|nvim|emacs|code|sudoedit|sqlite3)`;
// Interpreters/shells a pipeline can feed.
const INTERPRETERS = String.raw`(?:python[0-9.]*|pypy[0-9.]*|node(?:js)?|perl|ruby|php|lua[0-9.]*|bash|sh|zsh|fish|dash|ksh|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?|deno|bun)`;

export const DANGEROUS_COMMANDS: DangerousPattern[] = [
  // File Deletion - CRITICAL
  {
    pattern: /\brm\s+(-[rRfF]*\s+)?[^\s]/,
    category: 'file-deletion',
    description: 'Delete files/directories',
    severity: 'critical',
  },
  {
    pattern: /\bdel\s+/i,
    category: 'file-deletion',
    description: 'Delete files (Windows)',
    severity: 'critical',
  },
  {
    pattern: /\bremove-item\s+/i,
    category: 'file-deletion',
    description: 'Delete files (PowerShell)',
    severity: 'critical',
  },
  {
    pattern: /\bunlink\s+/,
    category: 'file-deletion',
    description: 'Delete files (system call)',
    severity: 'critical',
  },
  // Alternate deleters - the rm-shaped hole is not the whole story (#473)
  {
    pattern: /\bfind\s[^;&|]*?-delete\b/,
    category: 'file-deletion',
    description: 'find -delete removes matched files',
    severity: 'critical',
  },
  {
    pattern: /\b(?:shred|wipe|srm)\s+\S/,
    category: 'file-deletion',
    description: 'Secure file destruction (shred/wipe/srm)',
    severity: 'critical',
  },
  {
    pattern: /\btruncate\s+(?:-s\b|-s=|--size\b)/,
    category: 'file-deletion',
    description: 'Truncate file (destroys contents)',
    severity: 'high',
  },
  {
    pattern: /\bcipher\s+\/w/i,
    category: 'file-deletion',
    description: 'Wipe free space (Windows cipher /w)',
    severity: 'high',
  },
  {
    pattern: /\bhistory\s+-c\b/,
    category: 'defense-evasion',
    description: 'Clear shell history (anti-forensics)',
    severity: 'medium',
  },
  {
    pattern: /\battrib\s+\+h/i,
    category: 'defense-evasion',
    description: 'Hide files (Windows attrib +h)',
    severity: 'medium',
  },
  {
    pattern: /\b(?:wevtutil\s+cl\b|vssadmin\s+delete|wbadmin\s+delete)/i,
    category: 'defense-evasion',
    description: 'Delete logs/backups (anti-forensics)',
    severity: 'high',
  },

  // Recursive/Force deletion - CRITICAL
  {
    pattern: /\brm\s+-[rRfF]*r[fF]*/,
    category: 'recursive-deletion',
    description: 'Recursive delete (rm -rf)',
    severity: 'critical',
  },
  {
    pattern: /\brm\s+-[rRfF]*f[rR]*/,
    category: 'recursive-deletion',
    description: 'Force delete (rm -f)',
    severity: 'critical',
  },
  {
    pattern: /\b(?:rd|rmdir)\s+\/s/i,
    category: 'recursive-deletion',
    description: 'Recursive delete (Windows rd /s)',
    severity: 'critical',
  },

  // System Administration - CRITICAL
  {
    pattern: /\bsudo\s+/,
    category: 'privilege-escalation',
    description: 'Execute as superuser',
    severity: 'critical',
  },
  {
    pattern: /\bsu\s+\S/,
    category: 'privilege-escalation',
    description: 'Switch user',
    severity: 'critical',
  },
  {
    pattern: /\b(?:doas|pkexec|runuser)\s+/,
    category: 'privilege-escalation',
    description: 'Privilege escalation (doas/pkexec/runuser)',
    severity: 'critical',
  },
  {
    pattern: /\brunas\s+/i,
    category: 'privilege-escalation',
    description: 'Run as administrator (Windows)',
    severity: 'critical',
  },
  // (?<![\w/]) — flag these only as command words; /etc/passwd,
  // /etc/adduser.conf & friends are path arguments, not invocations (#473).
  {
    pattern: /(?<![\w/])(?:passwd|chpasswd|useradd|adduser|userdel|deluser|usermod|groupadd|groupmod|groupdel|chsh|chfn|visudo|vigr|pwconv|grpconv|newgrp|newusers)\b/,
    category: 'account-management',
    description: 'User/group/password management',
    severity: 'critical',
  },
  {
    pattern: /\bnet(?:1|\.exe)?\s+(?:user|localgroup|group|accounts|share)\s/i,
    category: 'account-management',
    description: 'Account/share management (Windows net user/localgroup)',
    severity: 'critical',
  },

  // Privilege & session control (#473)
  {
    pattern: /\b(?:u?mount|fusermount|losetup|swapon|swapoff|dmsetup|cryptsetup|mdadm)\s+[^|;&]/,
    category: 'disk-operation',
    description: 'Mount/attach filesystems and devices',
    severity: 'high',
  },
  {
    pattern: /\b(?:insmod|modprobe|rmmod|depmod)\s+/,
    category: 'kernel-module',
    description: 'Load/remove kernel modules',
    severity: 'critical',
  },
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff|telinit|kexec)\b|\binit\s+[0-6]\b|\bloginctl\s+(?:terminate|kill|lock|poweroff|reboot|suspend|hibernate)/,
    category: 'power-session',
    description: 'Power/session control (shutdown/reboot/...)',
    severity: 'high',
  },
  {
    pattern: /\b(?:chroot|nsenter|unshare|setpriv|capsh)\s+/,
    category: 'namespace-escape',
    description: 'Container/namespace boundary tools',
    severity: 'medium',
  },
  {
    pattern: /\bpkill\s+/,
    category: 'process-kill',
    description: 'Kill processes by name (pkill)',
    severity: 'medium',
  },

  // Disk Operations - HIGH
  {
    pattern: /\bmkfs\b/,
    category: 'disk-operation',
    description: 'Format filesystem',
    severity: 'high',
  },
  {
    pattern: /\bdd\s+if=/,
    category: 'disk-operation',
    description: 'Disk dump (can overwrite data)',
    severity: 'high',
  },
  {
    pattern: /\bformat\s+/i,
    category: 'disk-operation',
    description: 'Format disk (Windows)',
    severity: 'high',
  },
  {
    pattern: /\bfdisk\b/,
    category: 'disk-operation',
    description: 'Partition disk',
    severity: 'high',
  },

  // Network Operations - HIGH
  {
    pattern: /\bcurl\s+.*\|\s*(bash|sh|zsh|fish)/,
    category: 'network-execution',
    description: 'Download and execute script',
    severity: 'high',
  },
  {
    pattern: /\bwget\s+.*\|\s*(bash|sh|zsh|fish)/,
    category: 'network-execution',
    description: 'Download and execute script',
    severity: 'high',
  },
  {
    pattern: /\bnc\s+-[le]/,
    category: 'network-backdoor',
    description: 'Netcat listener (potential backdoor)',
    severity: 'high',
  },
  {
    pattern: /\biptables\s+/,
    category: 'network-config',
    description: 'Modify firewall rules',
    severity: 'high',
  },
  {
    pattern: /\bnetsh\s+/i,
    category: 'network-config',
    description: 'Network configuration (Windows)',
    severity: 'high',
  },

  // Shell indirection & interpreter one-liners (#473) — the command under
  // audit is just a launcher; the payload is invisible to the denylist.
  {
    pattern: /\b(?:python[0-9.]*|pythonw|pypy[0-9.]*)\s+[^;&|]*?-\w*c\b/,
    category: 'interpreter-exec',
    description: 'Inline code execution (python -c)',
    severity: 'high',
  },
  {
    pattern: /\b(?:node|nodejs|bun)\s+[^;&|]*?(?:-\w*[ep]\b|--eval\b|--print\b)/,
    category: 'interpreter-exec',
    description: 'Inline code execution (node -e / --eval)',
    severity: 'high',
  },
  {
    pattern: /\bdeno\s+eval\b/,
    category: 'interpreter-exec',
    description: 'Inline code execution (deno eval)',
    severity: 'high',
  },
  {
    pattern: /\b(?:perl|ruby)\s+[^;&|]*?-\w*e\b/,
    category: 'interpreter-exec',
    description: 'Inline code execution (perl/ruby -e)',
    severity: 'high',
  },
  {
    pattern: /\bphp[0-9.]*\s+[^;&|]*?-\w*r\b/,
    category: 'interpreter-exec',
    description: 'Inline code execution (php -r)',
    severity: 'high',
  },
  {
    pattern: /\blua[0-9.]*\s+[^;&|]*?-\w*e\b/,
    category: 'interpreter-exec',
    description: 'Inline code execution (lua -e)',
    severity: 'high',
  },
  {
    pattern: /\b(?:python[0-9.]*|pypy[0-9.]*|node(?:js)?|perl|ruby|php|lua[0-9.]*|bash|sh|zsh|fish|dash|ksh)\s+-?\s*<<-?\s*['"]?\w/,
    category: 'interpreter-exec',
    description: 'Script fed to an interpreter via heredoc',
    severity: 'high',
  },
  {
    pattern: /\b(?:bash|zsh|fish|dash|ksh|sh)\s+[^;&|]*?-\w*c\b/,
    category: 'shell-indirection',
    description: 'Inline shell execution (sh -c / bash -lc)',
    severity: 'high',
  },
  {
    pattern: /\bcmd(?:\.exe)?\s+\/\s*[ck]\b/i,
    category: 'shell-indirection',
    description: 'cmd /c inline execution (Windows)',
    severity: 'high',
  },
  {
    pattern: /\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+[^;&|]*?-(?:c|command|e[cn]|enc|encodedcommand|ep|exp|executionpolicy)\b/i,
    category: 'shell-indirection',
    description: 'PowerShell inline/encoded execution',
    severity: 'high',
  },
  {
    pattern: /\beval\s+\S/,
    category: 'shell-indirection',
    description: 'eval — executes a string as shell code',
    severity: 'high',
  },
  {
    pattern: /\bexec\s+\S/,
    category: 'shell-indirection',
    description: 'exec — replaces the shell / launches a program',
    severity: 'medium',
  },
  {
    pattern: /\bsource\s+\S/,
    category: 'shell-indirection',
    description: 'source — executes a file in the current shell',
    severity: 'medium',
  },
  {
    pattern: /(?:^|[;&|({]\s*)\.\s+\S/,
    category: 'shell-indirection',
    description: '". file" — sources a file in the current shell',
    severity: 'medium',
  },
  {
    pattern: /\bxargs\s+\S/,
    category: 'shell-indirection',
    description: 'xargs — builds and runs commands from piped input',
    severity: 'medium',
  },
  {
    pattern: /\bfind\s[^;&|]*?-exec(?:dir)?\b/,
    category: 'shell-indirection',
    description: 'find -exec runs a command per match',
    severity: 'high',
  },
  {
    pattern: new RegExp(`\\|\\s*(?:sudo\\s+)?${INTERPRETERS}\\b`),
    category: 'shell-indirection',
    description: 'Pipe output into an interpreter/shell',
    severity: 'high',
  },
  {
    pattern: /\b(?:rundll32|regsvr32|mshta|cscript|wscript|wmic|msiexec|installutil|regsvcs|msbuild|hh)\s/i,
    category: 'windows-proxy-exec',
    description: 'Windows proxy/script execution (LOLBIN)',
    severity: 'high',
  },
  {
    pattern: /\bcertutil\s+[^;&|]*?-(?:en|de)code/i,
    category: 'shell-indirection',
    description: 'certutil encode/decode (payload staging)',
    severity: 'medium',
  },

  // Exfiltration (#473) — channels that move data off the machine.
  {
    pattern: /\b(?:scp|sftp|rsync|ftp|tftp|lftp|ncftp|smbclient)\s+/,
    category: 'exfiltration',
    description: 'Remote file transfer (data can leave the machine)',
    severity: 'high',
  },
  {
    pattern: /\bssh\s+\S/,
    category: 'exfiltration',
    description: 'SSH remote shell/tunnel (data can leave the machine)',
    severity: 'high',
  },
  {
    pattern: /\bcurl\s[^;&|]*?(?:-d\b|--data\b|--data-urlencode\b|-T\b|--upload-file\b|-F\b|--form\b|--json\b|-X\s*(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)\b|--request\s+(?:POST|PUT|PATCH|DELETE|post|put|patch|delete)\b)/,
    category: 'exfiltration',
    description: 'curl upload/POST — sends data out',
    severity: 'high',
  },
  {
    pattern: /\bwget\s[^;&|]*?--(?:post-data|post-file|body-data|body-file|method=(?:POST|post|PUT|put|PATCH|patch|DELETE|delete))/,
    category: 'exfiltration',
    description: 'wget upload/POST — sends data out',
    severity: 'high',
  },
  {
    pattern: /(?:\b(?:nc|ncat|netcat|socat)\s[^;&|]*<|\|\s*(?:nc|ncat|netcat|socat)\s)/,
    category: 'exfiltration',
    description: 'netcat/socat moving data over the network',
    severity: 'high',
  },
  {
    pattern: /\b(?:rclone\s+(?:copy|move|sync|copyto|moveto|cat|serve|lsd)|aws\s+s3\s+(?:cp|sync|mv|presign)|aws\s+s3api\s+(?:put-object|copy-object|get-object)|gsutil\s+(?:cp|mv|rsync)|gcloud\s+storage\s+(?:cp|mv|rsync|upload)|azcopy\s+(?:copy|sync)|az\s+storage\s+\S+\s+(?:upload|download|copy))/i,
    category: 'exfiltration',
    description: 'Cloud storage transfer (data can leave the machine)',
    severity: 'high',
  },
  {
    pattern: /\bbitsadmin\s+\/(?:transfer|create|add|set)/i,
    category: 'exfiltration',
    description: 'BITS file transfer (Windows)',
    severity: 'high',
  },
  {
    pattern: /\bgit\s+(?:-[cC]\s+\S+\s+|--git-dir=\S+\s+)*push\s+(?:(?:-[A-Za-z]+|--[a-zA-Z][\w-]*(?:=\S+)?)\s+)*(?!origin\b|-)\S/,
    category: 'exfiltration',
    description: 'git push to a non-origin remote — code can leave the machine',
    severity: 'medium',
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bhelm\s+(?:push|chart\s+push)\b|\b(?:mvn|gradle)\s+(?:deploy|publish|uploadArchives)\b|\b(?:docker|podman|skopeo|crane|buildah)\s+push\b|\bskopeo\s+copy\b/,
    category: 'registry-publish',
    description: 'Publish/push code or images to a registry (exfiltration)',
    severity: 'high',
  },

  // System Configuration - HIGH
  {
    pattern: /\bchmod\s+[0-7]*[246][0-7]*/,
    category: 'permissions-change',
    description: 'Make file world-writable',
    severity: 'high',
  },
  {
    pattern: /\bchown\s+/,
    category: 'permissions-change',
    description: 'Change file ownership',
    severity: 'high',
  },
  {
    pattern: /\bcrontab\s+(?!-l\b)/,
    category: 'system-config',
    description: 'Modify scheduled tasks (persistence)',
    severity: 'high',
  },
  {
    pattern: /\bsystemctl\s+(?:enable|disable|mask|stop|start|restart|kill|isolate|edit|reboot|poweroff|halt|suspend|hibernate|kexec|soft-reboot|daemon-reexec)\b/,
    category: 'system-config',
    description: 'Modify system services / power state',
    severity: 'high',
  },
  {
    pattern: /\bservice\s+/,
    category: 'system-config',
    description: 'Control system services',
    severity: 'high',
  },

  // Persistence (#473) — install hooks/keys/jobs that survive the session.
  {
    pattern: /\bssh-copy-id\b/,
    category: 'persistence',
    description: 'Installs an SSH key in remote authorized_keys',
    severity: 'high',
  },
  {
    pattern: /\bat\s+(?:now\b|noon\b|midnight\b|teatime\b|\+|\d|-[fqtv]\b)|\batrm\s+/,
    category: 'persistence',
    description: 'at — schedules a command for later execution',
    severity: 'medium',
  },
  {
    pattern: /\bgit\s+(?:-[cC]\s+\S+\s+|--git-dir=\S+\s+)*config\s+[^;&|]*?(?:--global\b|--system\b|core\.(?:hooksPath|pager|sshCommand|editor|fsmonitor)|alias\.|include(?:If)?\.)/,
    category: 'persistence',
    description: 'Modify git config — hooksPath/alias/global can run code',
    severity: 'medium',
  },
  {
    pattern: /\b(?:schtasks\s+\/(?:create|change|delete)|sc(?:\.exe)?\s+(?:create|config|delete|failure)|reg(?:\.exe)?\s+(?:add|delete|import|restore)|bcdedit\b|diskpart\b)/i,
    category: 'persistence',
    description: 'Windows persistence/system modification',
    severity: 'high',
  },
  {
    pattern: /\b(?:takeown|icacls)\s+/i,
    category: 'permissions-change',
    description: 'Take ownership / rewrite ACLs (Windows)',
    severity: 'high',
  },

  // Package Management - MEDIUM
  {
    pattern: /\bapt-get\s+(remove|purge)/,
    category: 'package-removal',
    description: 'Uninstall packages',
    severity: 'medium',
  },
  {
    pattern: /\byum\s+remove/,
    category: 'package-removal',
    description: 'Uninstall packages',
    severity: 'medium',
  },
  {
    pattern: /\bnpm\s+(uninstall|remove)/,
    category: 'package-removal',
    description: 'Uninstall npm packages',
    severity: 'medium',
  },
  {
    pattern: /\bpip\s+uninstall/,
    category: 'package-removal',
    description: 'Uninstall Python packages',
    severity: 'medium',
  },

  // Package installs & runners (#473) — postinstall/lifecycle hooks execute
  // fetched code; npx/bunx-style runners download and execute in one step.
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|dlx|exec|create|init|update|upgrade|rebuild)\b/,
    category: 'package-exec',
    description: 'Package install/exec — lifecycle/postinstall code runs',
    severity: 'medium',
  },
  {
    pattern: /\byarn\s*(?:$|[;&|>])/,
    category: 'package-exec',
    description: 'Bare yarn == install (postinstall code)',
    severity: 'medium',
  },
  {
    pattern: /\b(?:npx|bunx|uvx)\s+\S/,
    category: 'package-exec',
    description: 'Download-and-execute package runner (npx/bunx/uvx)',
    severity: 'medium',
  },
  {
    pattern: /\bpip[0-9.]*\s+(?:install|wheel|download)\b|\bpipx\s+(?:install|run)\b/,
    category: 'package-exec',
    description: 'Python package fetch/install — runs build hooks',
    severity: 'medium',
  },
  {
    pattern: /\buv\s+(?:pip\s+install|install|add|sync|run|tool\s+(?:install|run))\b|\b(?:poetry|pipenv|conda|mamba|hatch)\s+(?:install|add|sync)\b/,
    category: 'package-exec',
    description: 'Python env/package install or run — code executes',
    severity: 'medium',
  },
  {
    pattern: /\b(?:gem|composer|brew|port|guix)\s+(?:install|add|require|update|upgrade)\b|\bcargo\s+(?:install|fetch)\b|\bcpanm?\s+\S|\bgo\s+(?:install|generate)\b/,
    category: 'package-exec',
    description: 'Package install — fetched code executes during install',
    severity: 'medium',
  },
  {
    pattern: /\b(?:apt|apt-get|aptitude)\s+(?:install|upgrade|dist-upgrade|full-upgrade|reinstall|remove|purge|autoremove)\b/,
    category: 'package-exec',
    description: 'OS package install/remove — maintainer scripts run as root',
    severity: 'medium',
  },
  {
    pattern: /\b(?:dnf|yum|zypper|apk|pkg|snap|flatpak)\s+(?:install|add|upgrade|update|dist-upgrade|reinstall|remove|del|erase)\b|\bpacman\s+-(?:S(?:yu?)?|U|R|D)\b|\b(?:dpkg|rpm)\s+-\w*[iUeRr]/,
    category: 'package-exec',
    description: 'OS package install/remove — maintainer scripts run as root',
    severity: 'medium',
  },
  {
    pattern: /\bmake\s+(?:install|uninstall)\b|\bcmake\s+--install\b/,
    category: 'package-exec',
    description: 'make/cmake install — runs install scripts into system dirs',
    severity: 'medium',
  },

  // Process Management - MEDIUM
  {
    pattern: /\bkill\s+-9/,
    category: 'process-kill',
    description: 'Force kill process',
    severity: 'medium',
  },
  {
    pattern: /\bkillall\s+/,
    category: 'process-kill',
    description: 'Kill all processes by name',
    severity: 'medium',
  },
  {
    pattern: /\btaskkill\s+\/f/i,
    category: 'process-kill',
    description: 'Force terminate process (Windows)',
    severity: 'medium',
  },

  // File Overwrite - MEDIUM
  {
    pattern: />\s*\/etc\//,
    category: 'system-file-overwrite',
    description: 'Overwrite system configuration',
    severity: 'high',
  },
  {
    pattern: />\s*\/boot\//,
    category: 'system-file-overwrite',
    description: 'Overwrite boot files',
    severity: 'critical',
  },
  {
    pattern: />\s*C:\\Windows\\/i,
    category: 'system-file-overwrite',
    description: 'Overwrite Windows system files',
    severity: 'high',
  },

  // Sensitive-destination writes (#473) — mv/cp/ln/install, redirects, tee,
  // in-place edits and dd pointed at credentials, rc files, /etc or the
  // agent's own config. Distinguishing source from destination args is out
  // of scope: any mv/cp touching a sensitive path is flagged.
  {
    pattern: new RegExp(`\\b(?:mv|cp|ln|install)\\s[^;&|]*?${SENSITIVE_WRITE_PATH}`),
    category: 'sensitive-file-write',
    description: 'Copy/move/link into a sensitive path (overwrite/persistence)',
    severity: 'high',
  },
  {
    pattern: new RegExp(`(?:>{1,2}|>\\|)\\s*[^;&|]*?${SENSITIVE_WRITE_PATH}`),
    category: 'sensitive-file-write',
    description: 'Redirect output into a sensitive file (overwrite/persistence)',
    severity: 'high',
  },
  {
    pattern: new RegExp(`\\btee\\s[^;&|]*?${SENSITIVE_WRITE_PATH}`),
    category: 'sensitive-file-write',
    description: 'tee into a sensitive file',
    severity: 'high',
  },
  {
    pattern: new RegExp(`\\b(?:sed|perl|awk|gsed)\\s[^;&|]*?-\\w*i\\b[^;&|]*?${SENSITIVE_WRITE_PATH}`),
    category: 'sensitive-file-write',
    description: 'In-place edit of a sensitive file',
    severity: 'high',
  },
  {
    pattern: new RegExp(`\\bdd\\s[^;&|]*?of=\\s*${SENSITIVE_WRITE_PATH}`),
    category: 'sensitive-file-write',
    description: 'dd overwrite of a sensitive file',
    severity: 'critical',
  },

  // Secret disclosure (#473) — env dumps, credential-file reads, secret
  // stores and packet capture. The child-env scrub already strips
  // credential-shaped vars from spawned commands; these tripwires catch
  // what remains (user env, on-disk keys, agent config).
  {
    pattern: /\bprintenv\b/,
    category: 'secret-disclosure',
    description: 'Dump environment variables (may expose secrets)',
    severity: 'medium',
  },
  {
    pattern: /\b(?:env|set|export|declare|typeset|history)\s*(?:$|[;&|>])/,
    category: 'secret-disclosure',
    description: 'Dump shell/environment state (may expose secrets)',
    severity: 'medium',
  },
  {
    pattern: /\b(?:export|declare|typeset)\s+-p\b|\bcompgen\s+-[a-zA-Z]*[ev]\b/,
    category: 'secret-disclosure',
    description: 'Dump exported variables/functions',
    severity: 'medium',
  },
  {
    pattern: /\bssh-add\s+-[lL]\b/,
    category: 'secret-disclosure',
    description: 'List SSH identities loaded in the agent',
    severity: 'medium',
  },
  {
    pattern: new RegExp(`\\b${READERS}\\b[^;&|]*?${SENSITIVE_PATH}|\\bgpg\\s+--export-secret`),
    category: 'secret-disclosure',
    description: 'Read credential/config/key material',
    severity: 'high',
  },
  {
    pattern: /\b(?:secret-tool\s+\w|security\s+[^;&|]*?find-(?:generic|internet)-password|cmdkey\s+\/(?:list|generic)|keyctl\s+(?:read|print|show|dump)|op\s+(?:read|item\s+get|inject)|bw\s+(?:get|list|export)\b|vault\s+(?:read|kv\s+get|kv\s+list)|consul\s+kv\s+get|etcdctl\s+get|kubectl\s+(?:get|describe)\s+secrets?\b)/i,
    category: 'secret-disclosure',
    description: 'Read a secret store / keychain / cluster secrets',
    severity: 'high',
  },
  {
    pattern: /\b(?:tcpdump|tshark|dumpcap|ngrep)\s+/,
    category: 'secret-disclosure',
    description: 'Packet capture — can harvest credentials',
    severity: 'medium',
  },

  // Database Operations - HIGH
  {
    pattern: /\bdrop\s+(database|table|schema)/i,
    category: 'database-deletion',
    description: 'Delete database/table',
    severity: 'high',
  },
  {
    pattern: /\btruncate\s+table/i,
    category: 'database-deletion',
    description: 'Delete all table data',
    severity: 'high',
  },
  {
    pattern: /\bdelete\s+from.*where\s+1\s*=\s*1/i,
    category: 'database-deletion',
    description: 'Delete all rows',
    severity: 'high',
  },

  // Container Operations (Podman/Docker) - HIGH
  {
    pattern: /\bpodman\s+run\s+.*--privileged/,
    category: 'container-privileged',
    description: 'Run container with elevated privileges',
    severity: 'high',
  },
  {
    pattern: /\bpodman\s+run\s+.*--(cap-add|security-opt)\s+/, 
    category: 'container-capabilities',
    description: 'Add Linux capabilities to container',
    severity: 'high',
  },
  {
    pattern: /\bpodman\s+(rm|rmi)\s+-f/,
    category: 'container-deletion',
    description: 'Force remove containers/images',
    severity: 'medium',
  },
  {
    pattern: /\bpodman\s+system\s+prune/,
    category: 'container-prune',
    description: 'Remove all unused containers/images',
    severity: 'medium',
  },
  {
    pattern: /\bpodman\s+run\s+.*-v\s+\/:/,
    category: 'container-host-mount',
    description: 'Mount host root filesystem into container',
    severity: 'high',
  },

  // Git Operations - MEDIUM
  {
    pattern: /\bgit\s+push\s+(-f|--force)/,
    category: 'git-force',
    description: 'Force push (can overwrite remote)',
    severity: 'medium',
  },
  {
    pattern: /\bgit\s+reset\s+--hard/,
    category: 'git-destructive',
    description: 'Hard reset (loses changes)',
    severity: 'medium',
  },
  {
    pattern: /\bgit\s+clean\s+-[dfx]/,
    category: 'git-destructive',
    description: 'Delete untracked files',
    severity: 'medium',
  },
];

export function isDangerousCommand(command: string): {
  isDangerous: boolean;
  matches: DangerousPattern[];
} {
  const matches: DangerousPattern[] = [];

  for (const dangerous of DANGEROUS_COMMANDS) {
    if (dangerous.pattern.test(command)) {
      matches.push(dangerous);
    }
  }

  return {
    isDangerous: matches.length > 0,
    matches,
  };
}

export function getHighestSeverity(patterns: DangerousPattern[]): 'critical' | 'high' | 'medium' | 'safe' {
  if (patterns.length === 0) return 'safe';

  const severities = patterns.map(p => p.severity);
  if (severities.includes('critical')) return 'critical';
  if (severities.includes('high')) return 'high';
  if (severities.includes('medium')) return 'medium';
  return 'safe';
}

export function formatDangerousWarning(patterns: DangerousPattern[]): string {
  if (patterns.length === 0) return '';

  const severity = getHighestSeverity(patterns);
  const descriptions = [...new Set(patterns.map(p => p.description))];

  return `⚠️  Dangerous command detected (${severity}):\n${descriptions.map(d => `   • ${d}`).join('\n')}`;
}
