#!/usr/bin/env bash
# panel-excerpt.sh — region-bound extraction of companion toast panels.
#
# Both companions render toasts in a bordered panel whose title line carries
# the brand word. A whole-pane grep for a toast phrase can be satisfied by the
# agent's own transcript echoing the phrase, so wording assertions extract the
# PANEL REGION first: the title line plus the following lines that still carry
# the panel's right border at the title line's column, sliced to the panel's
# column. Text outside the panel is not evidence about the panel.
#
# Sourced by drive-f2.sh and drive.sh. Knows nothing about goals — only about
# box drawing — so it is not a restated product predicate.

# Print every panel region in a capture, separated by a marker line.
# Usage: panel_regions <capture-file> <title-regex>
panel_regions() {
  local file="$1" title="$2"
  python3 - "$file" "$title" <<'PY'
import re, sys
path, title = sys.argv[1], sys.argv[2]
data = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', open(path, encoding='utf-8', errors='replace').read())
lines = data.split('\n')
titlere = re.compile(title)
for i, line in enumerate(lines):
    for m in titlere.finditer(line):
        col = m.start()
        left = line.rfind('\u2503', 0, col)
        right = line.find('\u2503', m.end())
        if left == -1 or right == -1:
            continue
 # A BOX'S TITLE LINE CARRIES NOTHING BUT THE TITLE. The word can appear
 # inside a box that is not a titled box: the v2 companion names the
 # synthetic message it sends "Fixate: <command>", so the agent's own
 # transcript sits in the conversation box with the brand word in it, and
 # the toast panel is drawn on the same line beside it. Taking the first
 # match on the line found the conversation, not the panel — and the
 # panel was then never extracted at all, so a toast that was on screen
 # read as a toast that was not.
        if line[left + 1:col].strip() or line[m.end():right].strip():
            continue
        out = []
        for j in range(i, min(len(lines), i + 8)):
            lj = lines[j]
            if j > i and lj[right-1:right+2].find('\u2503') == -1:
                break
            seg = lj[left+1:right].strip(' \u2503')
            if j == i:
                seg = re.sub(r'\s*x$', '', seg)
            out.append(seg)
        print('\n'.join(out))
        print('\u2503-PANEL-END\u2503')
PY
}

# Print the first panel region containing a fixed phrase (evidence excerpt).
# Usage: panel_excerpt <capture-file> <title-regex> <phrase>
panel_excerpt() {
  local file="$1" title="$2" phrase="$3"
  panel_regions "$file" "$title" | python3 -c "
import sys
blocks = sys.stdin.read().split('\u2503-PANEL-END\u2503')
phrase = sys.argv[1]
for b in blocks:
    if phrase in b:
        print(b.strip())
        sys.exit(0)
" "$phrase" 2>/dev/null
}

# Print the first frame of a sampled sequence whose panel region holds a phrase.
# Usage: panel_first_frame <directory> <frame-prefix> <title-regex> <phrase>
#
# A toast is TRANSIENT: it appears for a few seconds and is then gone. A frame
# captured after the event can therefore show nothing while the event happened.
# Sampling the pane across the window the event can occur in and reading the
# whole sequence is what makes the observation mean "it was rendered" rather
# than "it was still on screen when I looked".
#
# Nothing here knows what a goal is: the phrase and the panel title are the
# caller's, so this stays a box-drawing helper.
panel_first_frame() {
  local dir="$1" prefix="$2" title="$3" phrase="$4"
  local frame
  for frame in "$dir/$prefix"*.ansi; do
    [ -f "$frame" ] || continue
    if panel_regions "$frame" "$title" | grep -aq "$phrase"; then
      echo "$frame"
      return 0
    fi
  done
  return 1
}
