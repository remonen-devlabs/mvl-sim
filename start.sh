#!/bin/sh
# MVL Sim: starts the ride emulator and opens it in the browser.
#   ./start.sh [project-or-folder ...]
# Without a path it uses config.json's "projects", else the current folder. Ctrl+C stops it.
exec node "$(dirname "$0")/server.mjs" --open "$@"
