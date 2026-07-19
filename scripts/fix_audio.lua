-- Emergency audio fix
-- Unmute master
local master = reaper.GetMasterTrack(0)
if master then
  reaper.SetMediaTrackInfo_Value(master, "B_MUTE", 0)
  reaper.SetMediaTrackInfo_Value(master, "D_VOL", 1.0)
end

-- Unmute all tracks, set volume to 0dB
for i = 0, reaper.CountTracks(0) - 1 do
  local tr = reaper.GetTrack(0, i)
  if tr then
    reaper.SetMediaTrackInfo_Value(tr, "B_MUTE", 0)
    reaper.SetMediaTrackInfo_Value(tr, "D_VOL", 1.0)
  end
end

-- Unsolo all tracks (action 40340 = Track: Unsolo all tracks)
reaper.Main_OnCommand(40340, 0)

-- Unmute all tracks (action 40339 = Track: Unmute all tracks)
reaper.Main_OnCommand(40339, 0)

reaper.ShowConsoleMsg("Audio fix applied. Test sound now.\n")
