# Sandbox git workaround — 2026-04-20

## Problem

The Cowork sandbox mounts this repo via FUSE/virtiofs from the host Mac. Mount options show `user_id=0, group_id=0, default_permissions, allow_other`. Files under `.git/` and throughout the working tree are writable (writes succeed), but **`unlink()` is blocked everywhere in the mount** with "Operation not permitted" — even on files the agent itself just created.

Confirmed with:

```bash
echo "test" > .git/canary.txt   # succeeds
rm .git/canary.txt              # "Operation not permitted"
touch working-tree-probe.tmp    # succeeds
rm working-tree-probe.tmp       # "Operation not permitted"
```

This is not `chattr +i`, not a stale lock process, not a permissions bug — it's an explicit sandbox guardrail preventing the agent from destroying files on the host.

## Consequence

Git cannot operate normally from inside the sandbox against this `.git/` directory. Every non-trivial git command needs to remove `.git/index.lock`, replace refs, or rename pack files. All of those fail silently or half-succeed, which is how the working tree ends up in a Frankenstein state (97 files "modified" after one such failure in this session).

The agent also cannot remove tracked files from the working tree, so destructive operations like `git reset --hard` or `git checkout` that need to replace files will fail with "unable to unlink" errors.

## Fix for the sandbox agent

Keep `.git/` outside the mount, in the sandbox filesystem where write + unlink both work. Point it at the mount as the work tree.

Setup:

```bash
git clone --bare https://github.com/hpadilla16/RideFleetManagement \
  /sessions/<agent>/rfm-git

# Convert bare to non-bare so GIT_WORK_TREE can be set
git --git-dir=/sessions/<agent>/rfm-git config core.bare false
git --git-dir=/sessions/<agent>/rfm-git \
  config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=/sessions/<agent>/rfm-git fetch origin
```

Every subsequent git command runs with two env vars:

```bash
export GIT_DIR=/sessions/<agent>/rfm-git
export GIT_WORK_TREE=/sessions/<agent>/mnt/RideFleetManagement

git status
git add <file>              # additive — avoid paths that require unlink
git commit -m "..."
git push -u origin <branch>
```

Use additive operations only. Anything that deletes/replaces files in the work tree (`git checkout`, `git reset --hard`, `git pull` that updates tracked files) will fail on the unlink step. Instead:

- Use `git reset --soft` or `git reset` (mixed, default) — only touches index, not work tree.
- Let the host Mac resolve tracked-file conflicts: after the agent finishes, run `git fetch && git reset --hard origin/<branch>` from the host.

## Host-side cleanup after an agent session

The mount's original `.git/` is **not** updated by the sandbox git dir. They diverge. After an agent session:

```bash
cd ~/Documents/RideFleetManagement
git fetch origin
git reset --hard origin/main       # or whichever branch is current
```

This snaps the host repo to whatever the sandbox pushed.

Also delete any stray probe files left by the agent — they cannot be removed from inside the sandbox once created:

```bash
rm -f unlink-canary-*.tmp
rm -f mobile-car-sharing/unlink-probe.tmp
rm -rf mobile-car-sharing/         # if created inside this repo by mistake
```

## Push credentials

Fetch/`ls-remote` work unauthenticated against public repos. `git push` requires credentials. The sandbox has no `gh` CLI, no credential helper, no SSH keys, no PAT by default. Options:

1. Agent does the commit locally in the sandbox `.git`, user does the push from the host after fetching the branch from the sandbox.
2. User supplies a short-lived PAT via `GIT_ASKPASS` or `.netrc` for the duration of a session, then revokes it.

## First use in this session

Committed CLAUDE.md (monorepo overview) on branch `dev/docs-claude-md` cut from `origin/main` at `4f9294a`. Not pushed from sandbox.

Earlier in the session the agent mistakenly created `mobile-car-sharing/` inside this repo as a monorepo folder. Decision reversed — Flutter car-sharing app is being moved to a dedicated separate repository. The orphaned `mobile-car-sharing/` folder plus probe files (`unlink-canary-*.tmp`, `mobile-car-sharing/unlink-probe.tmp`) should be deleted from the host Mac:

```bash
cd ~/Documents/RideFleetManagement
rm -rf mobile-car-sharing/
rm -f unlink-canary-*.tmp
```
