# Live Show Panic Fixes

## "No Sound from REAPER" — Post-Crash Recovery

### Root Cause
When `coreaudiod` is killed while REAPER has an active audio connection (e.g., system restart, force-quit, or running `sudo killall -9 coreaudiod`), REAPER's internal audio state can become desynchronized from the HAL. On relaunch, REAPER reconnects to CoreAudio (IO threads are active, audio engine runs), but all tracks render **-91 dB (digital silence)**. The audio pipeline is "warm" but producing zero output.

The exact mechanism: when REAPER crashes mid-session, track mute/solo/volume states and the LSM runner state are not saved. On reload, the project opens with tracks in a default-muted or zero-volume state, and the runner is not restarted.

### Quick Fix (if you have GUI access, ~10 seconds)
1. In REAPER, run the audio emergency script:

   ```
   reaper -nonewinst /tmp/fix_audio.lua
   ```

   Or apply manually: press space to start transport, then in REAPER Actions menu:
   - Run `Track: Unmute all tracks` (40339)
   - Run `Track: Unsolo all tracks` (40340)
   - Check Master track is not muted and fader is at 0dB

2. Restart the LSM runner: open LSM GUI, click **"▶ LAUNCH PERFORMANCE"**

---

## Diagnostic Playbook

### Step 1: Verify System Audio Chain
```bash
# Audio devices recognized?
system_profiler SPAudioDataType | grep -A3 "Default Output"

# CoreAudio daemon healthy?
ps aux | grep '[/]usr/sbin/coreaudiod$' | awk '{print $3"%"}'
# Should be 1-5%. If 30%+, something is wrong.

# USB audio driver running?
ps aux | grep '[u]sbaudiod'
```

### Step 2: Verify REAPER Is Connected to Audio
```bash
# Is REAPER running?
ps aux | grep '[R]EAPER'

# Does REAPER have active IO threads? (definitive proof of HAL connection)
sudo sample REAPER 1 -file /tmp/reaper_sample.txt
grep -c 'IOThread.*client' /tmp/reaper_sample.txt
# Should return 2 (stereo in + out). 0 = no audio connection.
```

### Step 3: Capture REAPER Output (definitive silence test)
```bash
# Switch REAPER to BlackHole temporarily, capture, check volume
# 1. Edit ~/Library/Application Support/REAPER/reaper.ini:
#    coreaudiooutdevnew=BlackHole 16ch

# 2. Start transport, capture:
ffmpeg -y -f avfoundation -i ":1" -t 2 -af "volumedetect" -f null /dev/null 2>&1 | grep mean_volume

# 3. Restore M-Track in reaper.ini

# -91 dB = silence (rendering zero samples). Anything above -60 dB = real audio.
```

### Step 4: Check System Audio (ruling out hardware)
```bash
# Play a system sound through M-Track:
afplay /System/Library/Sounds/Glass.aiff
# If this works but REAPER doesn't → REAPER-specific issue
# If this doesn't work → hardware/CoreAudio issue
```

### Step 5: Check REAPER Config
```bash
grep -E 'coreaudio.*devnew|coreaudiosrate|coreaudiobs' ~/Library/Application\ Support/REAPER/reaper.ini
# Should show: M-Track Plus, 48000, 96
```

## What Doesn't Work (don't waste time)

- **Restarting coreaudiod alone** — doesn't fix REAPER's internal track states
- **Restarting REAPER alone** — tracks stay muted/zeroed
- **Editing reaper.ini audio settings** — the config is correct, the issue is project-level
- **Sending OSC transport commands** — REAPER's OSC surface may be partially broken post-crash
- **`tccutil reset Microphone`** — only breaks things further (REAPER doesn't need it for output)
- **Restarting usbaudiod** — USB driver is fine

## Key Files

| File | Purpose |
|------|---------|
| `~/Library/Application Support/REAPER/reaper.ini` | Audio device config (lines starting with `coreaudio`) |
| `~/Library/Application Support/REAPER/reaper.ini.bak` | Backup (created during this session) |
| `/tmp/fix_audio.lua` | Emergency unmute/unsolo script |
| `~/Library/Application Support/REAPER/Scripts/Live Show Manager/tools/launch_performance.lua` | Restart LSM runner |
| `~/Library/Application Support/REAPER/Scripts/Live Show Manager/web/control.sh` | Bridge server start/stop/restart |
| `/tmp/test_tone.RPP` | Minimal ReaSynth project for isolation testing |

## Show Optimization Scripts (separate from audio fix)

| Script | Called by | What it does |
|--------|-----------|--------------|
| `scripts/show-optimize start` | TUI Shift+S | Kills Safari, TouchBar, Siri; disables AWDL |
| `scripts/show-optimize stop` | TUI q / SIGINT / start-show cleanup | Re-enables AWDL |

## Recovery Procedure (Full)

If REAPER has no sound after any crash or coreaudiod restart:

```bash
# 1. Verify REAPER is connected to audio (IO threads >= 1)
sudo sample REAPER 1 -file /tmp/samp.txt && grep -c 'IOThread.*client' /tmp/samp.txt

# 2. If IO threads exist but no sound → run emergency unmute:
/Applications/REAPER.app/Contents/MacOS/REAPER -nonewinst /tmp/fix_audio.lua

# 3. Restart LSM bridge (if needed):
bash ~/Library/Application\ Support/REAPER/Scripts/Live\ Show\ Manager/web/control.sh restart

# 4. If still no sound → restart coreaudiod + REAPER + re-apply fix:
sudo killall -9 coreaudiod && sleep 3
sudo killall REAPER && sleep 2
open -a REAPER && sleep 12
/Applications/REAPER.app/Contents/MacOS/REAPER -nonewinst /tmp/fix_audio.lua

# 5. If STILL nothing → isolate with test project:
open -a REAPER /tmp/test_tone.RPP
# (1 track, ReaSynth, MIDI note — bare minimum test)
```

## Diagnostic Commands Quick Reference

```bash
# Audio core health
ps aux | grep coreaudiod | grep -v grep

# USB audio driver
ps aux | grep usbaudiod

# REAPER IO threads (the golden signal)
sudo sample REAPER 1 -file /tmp/s.txt && grep -c 'IOThread.*client' /tmp/s.txt

# Capture REAPER output to verify real audio vs silence
# (requires switching to BlackHole temporarily in reaper.ini)
ffmpeg -y -f avfoundation -i ":1" -t 2 -af "volumedetect" -f null /dev/null 2>&1 | grep mean_volume

# System audio test
afplay /System/Library/Sounds/Glass.aiff

# REAPER config check
grep coreaudio ~/Library/Application\ Support/REAPER/reaper.ini

# AWDL status (known dropout cause — should be DOWN during show)
ifconfig awdl0 | grep flags

# Bridge status
curl -s http://localhost:3000/api/state | python3 -m json.tool
```

## Session Chronology (2026-07-18)

1. **Initial:** User reported no sound at 96 samples/48kHz. System diagnostics found OpenCode (42%), Safari (69%), WindowServer (41%) eating CPU. AWDL active.
2. **Optimization:** Created `show-optimize`, added AWDL toggle to TUI Shift+S / q
3. **Breakage:** `sudo killall -9 coreaudiod` crashed REAPER's audio connection
4. **Diagnosis:** Proved REAPER has IO threads but produces -91 dB silence (via BlackHole capture)
5. **Fix:** Emergency Lua script unmuting all tracks + unsoloing restored audio
6. **Root cause:** Post-crash, tracks load in muted/zeroed state; LSM runner not restarted
