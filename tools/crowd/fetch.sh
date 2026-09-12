#!/bin/sh
# Downloads the audience recordings the clips in public/audio/ are cut from.
# Usage: sh tools/crowd/fetch.sh <dest-dir>
set -e
dest="${1:?usage: fetch.sh <dest-dir>}"
mkdir -p "$dest"
base=https://upload.wikimedia.org/wikipedia/commons
ua="crowd-says/1.0 (audience clips; see tools/crowd/ATTRIBUTION.md)"

fetch() { curl -fsSL -A "$ua" -o "$dest/$2" "$base/$1"; echo "  fetched $2"; }
fetch 6/6d/277021_sandermotions_applause-2.wav applause_cc0.wav
fetch a/a8/Clapping_hurray.ogg hurray_pd.ogg
fetch e/e5/Soundgoats_-_Audience_Booing.wav booing_pd.wav
fetch e/e5/72844_lonemonk_approx-800-laughter-and-clapter-1.wav bigcrowd_ccby.wav

# The build script reads plain PCM, so normalise the containers first.
for f in "$dest"/*.wav "$dest"/*.ogg; do
  [ -e "$f" ] || continue
  stem=$(basename "$f"); stem=${stem%.*}
  afconvert -f WAVE -d LEI16@44100 -c 2 "$f" "$dest/pcm-$stem.wav"
done
echo "Now run: python3 tools/crowd/build.py $dest public/audio"
