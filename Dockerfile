FROM caddy:2-alpine

RUN setcap -r /usr/bin/caddy
RUN addgroup -S -g 10001 caddy && adduser -S -D -H -u 10001 -G caddy caddy

ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data

COPY --chown=caddy:caddy Caddyfile /etc/caddy/Caddyfile
COPY --chown=caddy:caddy public/ /srv/

USER caddy
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
