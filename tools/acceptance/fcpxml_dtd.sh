#!/bin/sh
# Validate an FCPXML file against the DTD shipped inside Final Cut Pro (local only; the DTD is Apple's and not in the repo).
# xmllint cannot open a --dtdvalid path containing spaces, and the FCP bundle path has them, so the DTD is copied first.
# Usage: sh tools/acceptance/fcpxml_dtd.sh <file.fcpxml>
f="$1"; v=$(sed -n 's/.*<fcpxml version="\([0-9.]*\)".*/\1/p' "$f" | head -1 | tr . _)
src=$(find "/Applications/Final Cut Pro.app/Contents" -name "FCPXMLv${v}.dtd" 2>/dev/null | head -1)
[ -n "$src" ] || { echo "DTD for version $v not found"; exit 2; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; cp "$src" "$tmp/fcpxml.dtd"
xmllint --noout --dtdvalid "$tmp/fcpxml.dtd" "$f" && echo "valid against FCPXMLv${v}.dtd"
