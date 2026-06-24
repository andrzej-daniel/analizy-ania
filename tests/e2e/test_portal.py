from __future__ import annotations

import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import pytest
from playwright.sync_api import Page, expect, sync_playwright


ROOT_DIR = Path(__file__).resolve().parents[2]
PORTAL_DIR = ROOT_DIR / "portal"
CSV_FILES = [
    ROOT_DIR / "820 dz-1.csv",
    ROOT_DIR / "820 dz-2.csv",
    ROOT_DIR / "820 dz-3.csv",
]

PLOTLY_STUB = """
window.Plotly = {
  newPlot: async (target, data, layout) => {
    const element = typeof target === 'string' ? document.getElementById(target) : target;
    if (element) {
      element.dataset.plotlyRendered = 'true';
      element.dataset.traceCount = String(Array.isArray(data) ? data.length : 0);
      const title = typeof layout?.title === 'string' ? layout.title : layout?.title?.text || '';
      element.textContent = title;
    }
    return { data, layout };
  }
};
"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        return


@pytest.fixture(scope="session")
def portal_url() -> Iterator[str]:
    handler = partial(QuietHandler, directory=str(PORTAL_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


@pytest.fixture()
def page(portal_url: str) -> Iterator[Page]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(locale="pl-PL")
        context.route(
            "https://cdn.plot.ly/**",
            lambda route: route.fulfill(
                status=200,
                content_type="application/javascript",
                body=PLOTLY_STUB,
            ),
        )
        page = context.new_page()
        page.goto(portal_url)

        try:
            yield page
        finally:
            context.close()
            browser.close()


def test_portal_analyzes_uploaded_csv_files(page: Page) -> None:
    expect(page.get_by_role("heading", name="Analiza cyklicznego ściskania")).to_be_visible()
    expect(page.locator("#analizuj")).to_be_disabled()

    page.locator("#pliki").set_input_files([str(path) for path in CSV_FILES])
    expect(page.locator("#lista-plikow li")).to_have_count(3)
    expect(page.locator("#analizuj")).to_be_enabled()

    page.locator("#analizuj").click()

    expect(page.locator("#wyniki")).to_be_visible(timeout=20_000)
    expect(page.locator("#blad")).to_be_empty()
    expect(page.locator("#podsumowanie")).to_contain_text("wykryto ściśnięć: 6")
    expect(page.locator("#tabela tr")).to_have_count(7)
    expect(page.locator("#tabela-mech tr")).to_have_count(7)
    expect(page.locator("#tabela")).to_contain_text("preload")
    expect(page.locator("#stabilizacja")).to_contain_text("W∞")

    download_href = page.locator("#pobierz-csv").get_attribute("href")
    assert download_href is not None
    assert download_href.startswith("blob:")

    expect(page.locator("#wykres-zbiorczy")).to_have_attribute("data-plotly-rendered", "true")
    expect(page.locator("#wykres-petle")).to_have_attribute("data-plotly-rendered", "true")
    expect(page.locator("#wykres-trendy")).to_have_attribute("data-plotly-rendered", "true")


def test_portal_shows_error_for_invalid_csv(page: Page, tmp_path: Path) -> None:
    invalid_csv = tmp_path / "smieci.csv"
    invalid_csv.write_text("to,nie,jest\nzaden,pomiar\n", encoding="utf-8")

    page.locator("#pliki").set_input_files(str(invalid_csv))
    page.locator("#analizuj").click()

    expect(page.locator("#blad")).to_contain_text("Błąd:", timeout=20_000)
    expect(page.locator("#blad")).to_contain_text("smieci.csv")
    expect(page.locator("#wyniki")).to_be_hidden()
