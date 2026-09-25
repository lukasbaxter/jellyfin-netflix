#!/bin/sh
# Concatenate theme/src/*.css (in name order) into theme/dist/netflix.css.
# No toolchain needed. Version comes from theme/VERSION.
set -eu
cd "$(dirname "$0")"
ver=$(tr -d ' \n' < VERSION)
mkdir -p dist
{
    printf '/* jellyfin-netflix theme v%s */\n' "$ver"
    printf '/* Netflix-style theme for Jellyfin 12. Source: theme/src. GPL-3.0. */\n'
    # light minify: drop comments, indentation and blank lines (perl is on macOS and Debian)
    cat src/*.css | perl -0777 -pe 's{/\*.*?\*/}{}gs; s/^[ \t]+//mg; s/[ \t]+$//mg; s/\n{2,}/\n/g; s/\s*\{\s*/{/g; s/;\s*\n/;/g; s/\s*\}\s*/}\n/g; s/,[ \t]+/,/g; s/:[ \t]+/:/g; s/[ \t]*>[ \t]*/>/g; s/;\}/}/g;'
} > dist/netflix.css
size=$(wc -c < dist/netflix.css | tr -d ' ')
echo "dist/netflix.css v$ver ($size bytes)"
if [ "$size" -gt 61440 ]; then
    echo "WARNING: over the 60KB budget" >&2
fi
