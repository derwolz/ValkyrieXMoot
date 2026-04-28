FROM nginx:alpine

COPY index.html /usr/share/nginx/html/
COPY main.js    /usr/share/nginx/html/
COPY lib/       /usr/share/nginx/html/lib/

COPY data/moots.json    /usr/share/nginx/html/data/moots.json
COPY data/chibi_images/ /usr/share/nginx/html/data/chibi_images/

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
