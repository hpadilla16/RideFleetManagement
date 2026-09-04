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
RUN npm install

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["npm", "run", "dev"]
