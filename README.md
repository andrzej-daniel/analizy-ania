# analizy-ania

## Portal lokalnie

Wymagania: `uv` i Python 3.12+.

```bash
uv sync
make portal
```

Portal będzie dostępny pod:

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

Uwaga: portal działa lokalnie, ale biblioteka Plotly jest ładowana z CDN w przeglądarce.

## Metodologia

Portal liczy wyniki bezpośrednio z surowych punktów CSV z Trapezium. Pliki jednej próbki są scalane w jeden pomiar, każdy punkt dostaje `globalIndex`, `sourceFile` i `sourceRow`, a preload jest zachowany jako cykl kondycjonujący/QC.

Najważniejsze wzory są pokazane też w portalu:

```text
σ+ = max(σ, 0)
ε = displacement / h0
Ai = ((σ+i + σ+i-1) / 2) × |εi - εi-1| × 1000  [kJ/m3]
H = Aloading - Aunloading
R = (Aunloading / Aloading) × 100
Esec90 = σ90% / 0.90
Retentionn = (σmax,n / σmax,cycle1) × 100
Softeningn = 100 - Retentionn
Ai,Fd = ((Fi + Fi-1) / 2) × |di - di-1|  [mJ]
HFd = Aloading,Fd - Aunloading,Fd
elastic recovery = RFd = (Aunloading,Fd / Aloading,Fd) × 100
```

Korekcja `σ+ = max(σ, 0)` dotyczy naprężenia. Analiza force-displacement używa surowej siły `F` z CSV, zgodnie ze wzorem powyżej.

Eksporty:

- `summary CSV`: parametry końcowe per cykl, QC, retention/softening, elastic recovery oraz indeksy i wartości punktów użytych do interpolacji `σ10`...`σ90`.
- `trace CSV`: pełna ścieżka punkt-po-punkcie od surowego punktu do trapezu, fazy i parametru końcowego. `source_row` wskazuje rzeczywistą linię w oryginalnym pliku CSV.

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

CI uruchamia `make test` w GitHub Actions dla `pull_request` i pushy do `main`.
