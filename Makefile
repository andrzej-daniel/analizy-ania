HOST ?= 127.0.0.1
PORT ?= 8000
STREAMLIT_PORT ?= 8501

.PHONY: portal streamlit playwright-install test-js test-e2e test
portal:
	uv run python scripts/serve_portal.py --host $(HOST) --port $(PORT)

streamlit:
	uv run --with streamlit streamlit run streamlit_app.py --server.address $(HOST) --server.port $(STREAMLIT_PORT)

playwright-install:
	uv run python -m playwright install chromium

test-js:
	node testy/portal.test.js

test-e2e: playwright-install
	uv run python -m pytest tests/e2e

test: test-js test-e2e
