#!/usr/bin/env bash
# Run Procedura Studio as a detached, session-independent service.
#
#   ./host.sh start | stop | restart | status | log
#
# Uses setsid so the server survives the shell/SSH session that launched it.
# For reboot persistence, add a `@reboot /path/to/web/host.sh start` crontab.
set -uo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
PIDFILE="$WEB_DIR/.studio.pid"
LOGFILE="$WEB_DIR/.studio.log"

export PORT="${PORT:-8080}"
export HOST="${HOST:-127.0.0.1}"
export NODE_ENV=production
# Generations inherit this environment. A shell proxy would swallow calls to a
# loopback endpoint (a local gateway, LM Studio, Ollama), so the service runs
# proxy-free; set NO_PROXY yourself if your endpoint needs one.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

start() {
  if is_running; then
    echo "already running (pid $(cat "$PIDFILE")) on :$PORT"
    return 0
  fi
  cd "$WEB_DIR" || exit 1
  setsid nohup "$BUN" run server.ts "$@" >"$LOGFILE" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  sleep 1.5
  if is_running; then
    echo "started (pid $(cat "$PIDFILE")) → http://${HOST}:${PORT}"
    echo "logs: $LOGFILE"
  else
    echo "FAILED to start — last log lines:"
    tail -n 20 "$LOGFILE" 2>/dev/null
    rm -f "$PIDFILE"
    exit 1
  fi
}

stop() {
  if is_running; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do is_running || break; sleep 0.5; done
    is_running && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  echo "stopped"
}

cmd="${1:-start}"; shift || true
case "$cmd" in
  start)   start "$@" ;;
  stop)    stop ;;
  restart) stop; start "$@" ;;
  status)  if is_running; then echo "running (pid $(cat "$PIDFILE")) on :$PORT"; else echo "not running"; fi ;;
  log)     tail -n "${1:-40}" "$LOGFILE" 2>/dev/null || echo "no log yet" ;;
  *)       echo "usage: $0 {start|stop|restart|status|log} [server args]"; exit 1 ;;
esac
