# Base image pinned by DIGEST, not just by tag. `node:22-alpine` is a moving
# target: an upstream push changes what every build produces with no commit here,
# which is how CI can go from green to red overnight on an unchanged tree. The tag
# is kept beside the digest for readability; the digest is what actually resolves.
#
# To refresh (deliberately, in its own PR, so a base-image change is reviewable):
#   docker buildx imagetools inspect node:22-alpine --format '{{.Manifest.Digest}}'
# It is a multi-arch index, so amd64 (CI, droplet) and arm64 (Apple silicon) both
# keep working. NOTE: pinning also stops security patches arriving on their own —
# refreshing these is now a real maintenance task, not a nicety.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app

COPY package*.json ./
# npm ci, not npm install: this image is what CI's containerised jobs and local
# dev run, and `npm install` re-resolves every dependency inside its semver range
# on each build, so package-lock.json was only advisory here. Measured 2026-09-03:
# what an install produced differed from the lockfile by 55 packages in backend
# and 38 in frontend. That is how an unchanged tree goes green at 18:20 and red at
# 02:39 with nobody having touched the repo. Production already did the right
# thing (Dockerfile.prod uses `npm ci --omit=dev`); this puts dev and CI on the
# same lockfile, so a green CI means something reproducible.
RUN npm ci

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["npm", "run", "dev"]
