# Setup Verification Tests

Quick tests to verify your SC CLI setup is working correctly.

## PowerShell Tests

Open a **new** PowerShell window and run these commands:

### 1. Check Command Availability

```powershell
scc --version
# Expected: 0.1.0
```

✅ Pass if version shows  
❌ Fail if "command not found" → Run `. $PROFILE` and try again

### 2. Check API Key

```powershell
echo $env:NVIDIA_API_KEY
# Expected: nvapi-your-key-here
```

✅ Pass if key shows  
❌ Fail if empty → Check your PowerShell profile

### 3. Check Active Profile

```powershell
scc profile list
# Expected: nvidia (active) in the list
```

✅ Pass if "nvidia (active)" is shown  
❌ Fail if not active → Run `scc profile use nvidia`

### 4. Check Help

```powershell
scc --help
# Expected: Usage: sc [options] [command]...
```

✅ Pass if help shows  
❌ Fail if error → Check Node.js is installed

### 5. Quick Function Test

```powershell
# Test if the function works
Get-Command scc
# Expected: CommandType = Function
```

✅ Pass if shows as Function  
❌ Fail if not found → Reload profile with `. $PROFILE`

## WSL Tests

After running `./scripts/setup-wsl.sh`, open a **new** WSL terminal:

### 1. Check Command Availability

```bash
scc --version
# Expected: 0.1.0
```

✅ Pass if version shows  
❌ Fail if "command not found" → Run `source ~/.bashrc` and try again

### 2. Check API Key

```bash
echo $NVIDIA_API_KEY
# Expected: nvapi-your-key-here
```

✅ Pass if key shows  
❌ Fail if empty → Check your ~/.bashrc

### 3. Check Active Profile

```bash
scc profile list
# Expected: nvidia (active) in the list
```

✅ Pass if "nvidia (active)" is shown  
❌ Fail if not active → Run `scc profile use nvidia`

### 4. Check Alias

```bash
alias scc
# Expected: alias scc='node /mnt/d/git/sc-agent-cli/bin/sc.js'
```

✅ Pass if alias shows  
❌ Fail if not found → Check ~/.bashrc

### 5. Check Node.js

```bash
node --version
# Expected: v20.x.x or higher
```

✅ Pass if v20+  
❌ Fail if not installed → Install Node.js in WSL

## Interactive Test (Both Environments)

Try a simple chat interaction:

```bash
scc
```

When the chat starts, type:

```
You: list files in this directory
```

Expected behavior:
1. Agent should call `list_dir` tool
2. Ask for permission (if not auto-approved)
3. Show list of files in current directory
4. Provide a response

Type `exit` to quit.

✅ Pass if agent responds with file list  
❌ Fail if error → Check NVIDIA API key is valid

## Troubleshooting

### PowerShell: Command Not Found

```powershell
# Reload profile
. $PROFILE

# Or manually run the function
function scc {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & node "D:\git\sc-agent-cli\bin\sc.js" @Arguments
}
```

### WSL: Command Not Found

```bash
# Reload bashrc
source ~/.bashrc

# Or manually set alias
alias scc='node /mnt/d/git/sc-agent-cli/bin/sc.js'
```

### API Key Not Set

**PowerShell:**
```powershell
$env:NVIDIA_API_KEY = "nvapi-your-key-here"
```

**WSL:**
```bash
export NVIDIA_API_KEY="nvapi-your-key-here"
```

### NVIDIA Profile Not Active

```bash
scc profile use nvidia
```

## Full Test Checklist

- [ ] PowerShell: `scc --version` works
- [ ] PowerShell: API key is set
- [ ] PowerShell: nvidia profile is active
- [ ] PowerShell: Interactive chat works
- [ ] WSL: Setup script ran successfully
- [ ] WSL: `scc --version` works
- [ ] WSL: API key is set
- [ ] WSL: nvidia profile is active
- [ ] WSL: Interactive chat works

## Success Criteria

✅ All tests pass → You're ready to use SC CLI!  
❌ Any test fails → Follow troubleshooting steps above

## Need Help?

1. Check [SETUP.md](SETUP.md) for setup instructions
2. Check [scripts/README.md](scripts/README.md) for script details
3. Check [docs/windows-sc-conflict.md](docs/windows-sc-conflict.md) for Windows issues
4. Open an issue on GitHub

## Next Steps After Successful Tests

1. **Read the docs:**
   - [README.md](README.md) - Full documentation
   - [QUICKSTART.md](QUICKSTART.md) - Usage examples
   - [docs/nvidia-nemotron-setup.md](docs/nvidia-nemotron-setup.md) - NVIDIA details

2. **Try it out:**
   ```bash
   scc
   You: explain how this CLI works
   ```

3. **Explore other models:**
   ```bash
   scc profile list
   scc profile use ollama  # Try local model
   ```

4. **Check out the tools:**
   - File operations (read, write, edit)
   - Directory listing
   - Text search
   - Shell execution
