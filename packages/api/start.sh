#!/bin/sh
# The production start path: node as the process that receives the signals.
#
# A host stops a container with SIGTERM (`docker stop`; on the Pi, compose
# under its stop_grace_period). Under `npm start` the signal reached npm and a
# shell first, both of which report a child killed by a signal and exit
# non-zero, which a host shows as a crash. `exec` replaces this shell with
# node, so the server's own handler (src/shutdown.ts) gets the signal and
# exits 0. The image's CMD runs this file (Dockerfile); `npm start` runs it for
# a local check.
#
# No pre-start step: the bundle is built by `npm run build:server`, and the
# server creates its own tables when it boots.
set -e
cd "$(dirname "$0")"
export NODE_ENV=production
exec node dist/server.js
