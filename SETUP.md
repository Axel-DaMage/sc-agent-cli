# Quick Setup Guide

Get `scc` command working in PowerShell and WSL in under 2 minutes.

## Prerequisites

- Node.js >= 20.0.0 installed
- SC CLI project at `D:\git\sc-agent-cli`

## Option A: Automated Setup (Recommended)

### PowerShell

```powershell
cd D:\git\sc-agent-cli\scripts
.\setup-powershell.ps1
```

### WSL / Ubuntu

```bash
cd /mnt/d/git/sc-agent-cli/scripts
./setup-wsl.sh
```

## Option B: Manual Setup

### PowerShell

1. Open PowerShell profile:
   ```powershell
   notepad $PROFILE
   ```

2. Add to the end:
   ```powershell
   # SC CLI
   $env:NVIDIA_API_KEY = "nvapi-your-nvidia-key-here"
   
   function scc {
       param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
       & node "D:\git\sc-agent-cli\bin\sc.js" @Arguments
   }
   ```

3. Save and reload:
   ```powershell
   . $PROFILE
   scc --version  # Should show 0.1.0
   ```

### WSL / Ubuntu

1. Edit `.bashrc`:
   ```bash
   nano ~/.bashrc
   ```

2. Add to the end:
   ```bash
   # SC CLI
   export NVIDIA_API_KEY="nvapi-your-nvidia-key-here"
   alias scc='node /mnt/d/git/sc-agent-cli/bin/sc.js'
   ```

3. Save and reload:
   ```bash
   source ~/.bashrc
   scc --version  # Should show 0.1.0
   ```

## Verify Setup

Both environments:

```bash
scc --version              # Should show: 0.1.0
scc profile list           # Should show nvidia as active
scc --help                 # Show all commands
```

## Start Using

```bash
# Start chat session
scc

# Try a command
You: list files in this directory
You: read the package.json file
You: what is this project about?

# Type 'exit' or 'quit' to end
```

## Troubleshooting

### PowerShell: Execution Policy Error

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

Then re-run the setup script.

### WSL: Node.js Not Installed

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Command Not Found After Setup

Make sure you reloaded your shell:

**PowerShell:**
```powershell
. $PROFILE
```

**WSL:**
```bash
source ~/.bashrc
```

Or close and reopen your terminal.

## What Was Configured

✅ Command `scc` → Runs SC CLI  
✅ `NVIDIA_API_KEY` → Your NVIDIA Nemotron API key  
✅ Active profile → `nvidia` (Nemotron 3 Ultra 550B)  
✅ Ready to chat → Just run `scc`  

## Next Steps

- See [README.md](README.md) for full documentation
- See [QUICKSTART.md](QUICKSTART.md) for usage examples
- See [docs/nvidia-nemotron-setup.md](docs/nvidia-nemotron-setup.md) for NVIDIA details
- See [scripts/README.md](scripts/README.md) for setup script details

## Changing API Keys

To use a different API key or provider:

1. Edit your shell profile:
   - PowerShell: `notepad $PROFILE`
   - WSL: `nano ~/.bashrc`

2. Update the `NVIDIA_API_KEY` (or add `OPENAI_API_KEY`, etc.)

3. Reload your shell

4. Switch profile if needed:
   ```bash
   scc profile use openai
   ```
