FROM nginx:alpine

COPY index.html /usr/share/nginx/html/
COPY main.js    /usr/share/nginx/html/
COPY lib/       /usr/share/nginx/html/lib/

# All game assets in one mount. .dockerignore filters out source/scratch files
# (data/*.py, data/*.csv, data/archive, data/batches, data/images, data/tags,
# data/chibi_images.zip, etc.) — only the served folders/files come through.
COPY data/      /usr/share/nginx/html/data/

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
