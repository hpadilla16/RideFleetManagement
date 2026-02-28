# Version Control + Release Flow (Beta)

## Branches
- `main`: live beta
- `develop`: integration
- `feature/*`: planned work
- `hotfix/*`: urgent live fixes

## Release tagging
- Beta release: `v0.9.0-beta.N`
- Emergency patch: `v0.9.0-beta.N+hotfix.M`

## Hotfix flow
1. `git checkout main && git pull`
2. `git checkout -b hotfix/<issue>`
3. Implement minimal fix
4. Validate (`frontend build`, key smoke checks)
5. Merge to `main`
6. Tag + push
7. Deploy with `ops/deploy-beta.ps1 -Tag <tag>`

## Merge policy
- Keep commits small and topic-specific.
- One concern per PR.
- Every deploy must map to a git tag.

## Release note template
- Tag:
- Date/time:
- Scope:
- Risks:
- Rollback tag:
- Validation done:
- Known issues: