#!/bin/sh
# Installs a private Node.js LTS (22 or later) for SAIAS in $SAIAS_DATA/node (Linux and macOS).
# The archive is verified against the SHASUMS256.txt published by nodejs.org.
set -e
dest="${SAIAS_DATA:?SAIAS_DATA is not set}/node"

case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "Unsupported system: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "Unsupported processor: $(uname -m)" >&2; exit 1 ;;
esac

# Latest LTS release with a major version of 22 or more.
version=$(curl -fsSL https://nodejs.org/dist/index.json | tr '{' '\n' | grep '"lts":"' \
    | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p' \
    | awk -F. '{ if (substr($1, 2) + 0 >= 22) { print; exit } }')
[ -n "$version" ] || { echo "Could not find a Node.js LTS release." >&2; exit 1; }
name="node-$version-$os-$arch"
echo "Installing Node.js $version for SAIAS..."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://nodejs.org/dist/$version/$name.tar.gz" -o "$tmp/$name.tar.gz"
curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
expected=$(grep " $name.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1)
else
    actual=$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1)
fi
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "Node.js download failed verification." >&2; exit 1; }

tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
mv "$tmp/$name" "$dest"
echo "Node.js $version installed in $dest"
