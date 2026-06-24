# analizy-ania

## Portal lokalnie

Wymagania: `uv` i Python 3.12+.

```bash
uv sync
make portal
```

Portal bedzie dostepny pod:

```text
http://127.0.0.1:8000/
```

Inny port:

```bash
make portal PORT=8080
```

Bez `make`:

```bash
uv run python scripts/serve_portal.py --port 8000
```

Uwaga: portal dziala lokalnie, ale biblioteka Plotly jest ladowana z CDN w przegladarce.

## Testy

Regresja logiki:

```bash
make test-js
```

E2E w Playwright:

```bash
make test-e2e
```

Wszystkie testy:

```bash
make test
```
