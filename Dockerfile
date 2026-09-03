FROM node:20-slim

# ffmpeg for every transcode, mix, mux and hardsub.
#
# FONTS ARE NOT OPTIONAL FOR A HARDSUB CONTAINER. libass resolves the ASS style's
# font through fontconfig, and node:20-slim ships NO fonts at all — so a burn in a
# non-Latin language rendered as tofu boxes (□□□) while still producing a
# perfectly valid MP4 and reporting success. That is the worst failure shape
# available: the deliverable looks fine to the pipeline and is unusable to the
# customer, and nothing on the audit row says so.
#
#   fontconfig        — the resolver libass actually calls
#   fonts-liberation  — Arial/Times/Courier metric-compatible Latin faces
#   fonts-dejavu-core — broad Latin/Greek/Cyrillic fallback
#   fonts-noto-core   — Arabic, Hebrew, Thai, Devanagari, Vietnamese, etc.
#   fonts-noto-cjk    — Korean, Japanese, Simplified + Traditional Chinese
#
# Noto CJK is ~100 MB of image size. That cost is accepted deliberately: this is a
# media-localization platform, CJK is a first-class delivery language set, and an
# automatic fontconfig fallback is the only way a burn in any language renders
# real glyphs without the operator having to know which font covers their script.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
      fonts-noto-cjk \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY *.js ./
EXPOSE 3000
CMD ["node", "index.js"]
