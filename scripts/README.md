# Setup Scripts

Automated setup scripts for configuring SC CLI in different environments.

## Available Scripts

### `setup-powershell.ps1`

Configures SC CLI (`scc` command) in PowerShell.

**What it does:**
- Adds `scc` function to your PowerShell profile
- Configures `NVIDIA_API_KEY` environment variable
- Sets NVIDIA Nemotron as the active profile
- Backs up your existing profile before making changes

**Usage:**

```powershell
# Run from PowerShell
cd D:\git\sc-agent-cli\scripts
.\setup-powershell.ps1
```

**Manual setup (if script fails):**

1. Open PowerShell profile:
   ```powershell
   notepad $PROFILE
   ```

2. Add this to the end:
   ```powershell
   # SC CLI
   $env:NVIDIA_API_KEY = "nvapi-your-nvidia-key-here"
   
   function scc {
       param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
       $scCliPath = "D:\git\sc-agent-cli\bin\sc.js"
       & node $scCliPath @Arguments
   }
   ```

3. Reload:
   ```powershell
   . $PROFILE
   ```

### `setup-wsl.sh`

Configures SC CLI (`scc` command) in Windows Subsystem for Linux (WSL/Ubuntu).

**What it does:**
- Adds `scc` alias to your `.bashrc`
- Configures `NVIDIA_API_KEY` environment variable
- Sets NVIDIA Nemotron as the active profile
- Backs up your existing `.bashrc` before making changes

**Usage:**

```bash
# Run from WSL terminal
cd /mnt/d/git/sc-agent-cli/scripts
./setup-wsl.sh
```

**Manual setup (if script fails):**

1. Edit `.bashrc`:
   ```bash
   nano ~/.bashrc
   ```

2. Add this to the end:
   ```bash
   # SC CLI
   export NVIDIA_API_KEY="nvapi-your-nvidia-key-here"
   alias scc='node /mnt/d/git/sc-agent-cli/bin/sc.js'
   ```

3. Reload:
   ```bash
   source ~/.bashrc
   ```

### `test-nvidia.sh`

Quick test script for NVIDIA profile (Git Bash / WSL).

**Usage:**

```bash
export NVIDIA_API_KEY="nvapi-..."
./test-nvidia.sh
```

### `test-chat.sh`

General test script for SC CLI (Git Bash / WSL).

**Usage:**

```bash
./test-chat.sh
```

### `codex-scc-loop.ps1`

Runs an external maintenance loop that invokes `scc` every 15 minutes with a prompt that pushes each cycle through a traceable branch, PR, and merge flow while favoring user experience and product quality.

**Usage:**

```powershell
cd D:\git\sc-agent-cli\scripts
.\codex-scc-loop.ps1
```

**What it does:**

- Works from the current repository root by default
- Invokes `scc` if the command is available in the current PowerShell session
- Falls back to `node D:\git\sc-agent-cli\bin\sc.js` if `scc` is not loaded
- Encourages one atomic change per cycle with branch, PR, validation, merge traceability, and UX/quality focus
- Waits 15 minutes between cycles by default

**Example:**

```powershell
.\codex-scc-loop.ps1 -WorkspaceRoot D:\git\sc-agent-cli -IntervalMinutes 15 -Cycles 4
```

### `register-codex-scc-task.ps1`

Registers a Windows Task Scheduler task that runs one SCC improvement cycle every 15 minutes. The task uses the current PowerShell profile so the `scc` command and its environment remain available.

**Usage:**

```powershell
cd D:\git\sc-agent-cli\scripts
.\register-codex-scc-task.ps1
```

**What it does:**

- Registers `SC-Agent-CLI-Codex-SCC` by default
- Runs `codex-scc-loop.ps1` with `-Cycles 1` so each scheduled invocation stays single-purpose
- Uses `MultipleInstances IgnoreNew` to avoid overlapping runs
- Starts the first run about one minute after registration, then repeats every 15 minutes

### `ensure-deps.mjs`

Dependency bootstrap hook wired into `npm run build` (`prebuild`) and `npm test` (`pretest`). Fresh worktrees and CI gates that invoke npm scripts without a prior `npm ci` would otherwise fail with `sh: line 1: tsc: command not found`.

**What it does:**

- Checks `node_modules/<package>/package.json` for the required package (argument, default `typescript`)
- When missing, runs `npm ci --ignore-scripts --no-audit --no-fund` (or `npm install` when no `package-lock.json` exists)
- No-ops instantly when dependencies are already installed
- Exits non-zero with a clear error if the install fails

**Usage:**

```bash
node scripts/ensure-deps.mjs          # checks typescript
node scripts/ensure-deps.mjs vitest   # checks vitest
```

## Verification

After running setup, verify the configuration:

**PowerShell:**
```powershell
scc --version              # Should show: 0.1.0
scc profile list           # Should show nvidia as active
$env:NVIDIA_API_KEY        # Should show your API key
```

**WSL:**
```bash
scc --version              # Should show: 0.1.0
scc profile list           # Should show nvidia as active
echo $NVIDIA_API_KEY       # Should show your API key
```

## Troubleshooting

### PowerShell: "Execution policy" error

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### WSL: "Node.js not found"

Install Node.js in WSL:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### "scc: command not found"

Make sure you reloaded your shell configuration:

**PowerShell:**
```powershell
. $PROFILE
```

**WSL:**
```bash
source ~/.bashrc
```

### Wrong path to sc-agent-cli

If your project is in a different location, edit the scripts and update:

- PowerShell: `D:\git\sc-agent-cli\bin\sc.js`
- WSL: `/mnt/d/git/sc-agent-cli/bin/sc.js`

## Security Note

These scripts contain your NVIDIA API key. The key is:

- Added to your shell profile (loaded on every terminal session)
- **Not** committed to git (profiles are gitignored)
- Can be rotated by editing your profile and running the setup again

To use a different API key:
1. Edit your PowerShell profile (`$PROFILE`) or `.bashrc`
2. Update the `NVIDIA_API_KEY` value
3. Reload your shell

## Next Steps

After setup:

1. **Test the command:**
   ```bash
   scc --version
   ```

2. **List profiles:**
   ```bash
   scc profile list
   ```

3. **Start chatting:**
   ```bash
   scc
   ```

4. **Try a quick task:**
   ```
   You: list files in this directory
   ```
