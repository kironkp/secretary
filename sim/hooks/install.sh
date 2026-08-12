#!/bin/sh
# Install the post-commit simulation hook.
set -e
root="$(git rev-parse --show-toplevel)"
hook="$root/.git/hooks/post-commit"
if [ -f "$hook" ] && ! grep -q "Simulation flywheel" "$hook"; then
  echo "WARNING: an existing post-commit hook is present — not overwriting."
  echo "Merge sim/hooks/post-commit into it manually."
  exit 1
fi
cp "$root/sim/hooks/post-commit" "$hook"
chmod +x "$hook"
echo "installed .git/hooks/post-commit (disable: touch sim/.disabled or SIM_DISABLE=1)"
