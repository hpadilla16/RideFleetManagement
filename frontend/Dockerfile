FROM node:22-alpine
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
