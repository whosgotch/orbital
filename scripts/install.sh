#!/bin/sh
# Orbital installer.
#   curl -fsSL https://raw.githubusercontent.com/whosgotch/orbital/main/scripts/install.sh | sh
# Downloads the latest release for this OS/arch and installs it.
set -eu

REPO="whosgotch/orbital"
API="https://api.github.com/repos/$REPO/releases/latest"

fail() { echo "error: $1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

# Resolve the download URL of the asset whose name contains $1.
asset_url() {
  curl -fsSL "$API" |
    grep -o "\"browser_download_url\": *\"[^\"]*$1[^\"]*\"" |
    head -1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin)
    case "$arch" in
      arm64) pattern="aarch64.app.tar.gz" ;;
      x86_64) pattern="x86_64.app.tar.gz" ;;
      *) fail "unsupported macOS architecture: $arch" ;;
    esac

    url=$(asset_url "$pattern")
    [ -n "$url" ] || fail "no macOS release asset found (looked for $pattern)"

    echo "Downloading $url"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fSL --progress-bar "$url" -o "$tmp/orbital.app.tar.gz"

    echo "Installing to /Applications/Orbital.app"
    rm -rf /Applications/Orbital.app
    tar -xzf "$tmp/orbital.app.tar.gz" -C /Applications

    echo "Done. Launch with: open -a Orbital"
    ;;

  Linux)
    [ "$arch" = "x86_64" ] || fail "unsupported Linux architecture: $arch (x86_64 only for now)"

    url=$(asset_url "amd64.AppImage")
    [ -n "$url" ] || fail "no Linux release asset found"

    bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
    mkdir -p "$bin_dir"

    echo "Downloading $url"
    curl -fSL --progress-bar "$url" -o "$bin_dir/orbital"
    chmod +x "$bin_dir/orbital"

    echo "Installed to $bin_dir/orbital"
    case ":$PATH:" in
      *":$bin_dir:"*) echo "Done. Launch with: orbital" ;;
      *) echo "Note: $bin_dir is not on your PATH — add it, then launch with: orbital" ;;
    esac
    ;;

  MINGW*|MSYS*|CYGWIN*)
    fail "Windows is not supported yet"
    ;;

  *)
    fail "unsupported OS: $os"
    ;;
esac
