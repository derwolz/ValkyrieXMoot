FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

ARG BUILD_TIME=dev
RUN sed -i "s/__BUILD_TIME__/${BUILD_TIME}/" /dev/null || true

COPY index.html /usr/share/nginx/html/
COPY main.js    /usr/share/nginx/html/
COPY lib/       /usr/share/nginx/html/lib/

# All game assets in one mount. .dockerignore filters out source/scratch files
# (data/*.py, data/*.csv, data/archive, data/batches, data/images, data/tags,
# data/chibi_images.zip, etc.) — only the served folders/files come through.
COPY data/      /usr/share/nginx/html/data/

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ || exit 1
