#!/usr/bin/env bash
set -euo pipefail

PORT=8080
PIDFILE=".dev-server.pid"

start() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Server already running (pid $(cat "$PIDFILE")) at http://localhost:$PORT"
    exit 0
  fi
  python3 -m http.server "$PORT" &>/dev/null &
  echo $! > "$PIDFILE"
  echo "Started at http://localhost:$PORT (pid $!)"
}

stop() {
  if [[ ! -f "$PIDFILE" ]]; then
    echo "No server pidfile found: Nothing to stop."
    exit 0
  fi
  local pid
  pid=$(cat "$PIDFILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped (pid $pid)"
  else
    echo "Process $pid not running."
  fi
  rm -f "$PIDFILE"
}

setup() {
  echo "Installing dependencies..."
  npm install
  echo "Installing Playwright browsers..."
  npx playwright install --with-deps chromium
  echo "Setup complete."
}

run_tests() {
  # Ensure the dev server is running for the duration of the tests,
  # then restore its original state when done.
  local server_started=0
  if [[ ! -f "$PIDFILE" ]] || ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    start
    server_started=1
  fi

  echo "Running tests..."
  local exit_code=0
  npx playwright test --reporter=list || exit_code=$?

  if [[ $server_started -eq 1 ]]; then
    stop
  fi

  if [[ $exit_code -eq 0 ]]; then
    echo "All tests passed."
  else
    echo "Tests failed (exit code $exit_code)."
  fi
  exit $exit_code
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  setup)   setup ;;
  test)    run_tests ;;
  *)
    echo "Usage: $0 {start|stop|restart|setup|test}"
    exit 1
    ;;
esac
