#!/usr/bin/env bash
# Opens PromptForge in the default browser. For the Linux deployment box.
#
# It does NOT start the server, unlike start.sh and start.bat. On the
# deployment box promptforge.service starts it at boot and restarts it on
# failure, so there is nothing for a desktop icon to launch — the only job
# left is opening a browser at it.
#
# It still waits for the port first, for the same reason start.bat does:
# clicking the icon straight after login can beat the service to the port, and
# a browser opened a second early shows "unable to connect" over a service
# that is about to work.
#
# Gives up quietly after ~30 tries. An icon that opens nothing is a small
# annoyance; one that pops an error over a service that is coming up is worse.
#
# Install the icon with promptforge.desktop.example; the steps are in that file.

URL="http://localhost:8090"

for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 "$URL" 2>/dev/null; then
    xdg-open "$URL" >/dev/null 2>&1 &
    exit 0
  fi
  sleep 1
done

exit 0
