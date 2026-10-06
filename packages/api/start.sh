#!/bin/sh
# The production start path: node as the process that receives the signals.
#
# Railway stops a deployment with SIGTERM. Under `npm start` the signal reached
# npm and a shell first, both of which report a child killed by a signal and
# exit non-zero, which Railway shows as a crash. `exec` replaces this shell
# with node, so the server's own handler (src/shutdown.ts) gets the signal and
# exits 0. The service's Custom Start Command runs this file with `exec` too
# (docs/deployment.md, section 4); `npm start` runs it for a local check.
#
# No pre-start step: the bundle is built by `npm run build:railway`, and the
# server creates its own tables when it boots.
set -e
cd "$(dirname "$0")"
export NODE_ENV=production
exec node dist/server.js
