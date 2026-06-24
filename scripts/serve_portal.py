from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
PORTAL_DIR = ROOT_DIR / "portal"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the local analysis portal.")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to.")
    parser.add_argument("--port", default=8000, type=int, help="Port to bind to.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not (PORTAL_DIR / "index.html").is_file():
        raise SystemExit(f"Portal index not found: {PORTAL_DIR / 'index.html'}")

    handler = partial(SimpleHTTPRequestHandler, directory=str(PORTAL_DIR))
    address = (args.host, args.port)

    try:
        with ThreadingHTTPServer(address, handler) as server:
            port = server.server_address[1]
            print(f"Portal running at http://{args.host}:{port}/", flush=True)
            print("Press Ctrl+C to stop.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    except OSError as exc:
        raise SystemExit(f"Could not start portal at {args.host}:{args.port}: {exc}") from exc


if __name__ == "__main__":
    main()
