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
window.__plots = {};
window.Plotly = {
  newPlot: async (target, data, layout) => {
    const element = typeof target === 'string' ? document.getElementById(target) : target;
    if (element) {
      const xTitle = layout?.xaxis?.title?.text || layout?.xaxis?.title || '';
      const yTitle = layout?.yaxis?.title?.text || layout?.yaxis?.title || '';
      const title = typeof layout?.title === 'string' ? layout.title : layout?.title?.text || '';
      window.__plots[element.id] = {
        title,
        xTitle,
        yTitle,
        traceCount: Array.isArray(data) ? data.length : 0,
        traceNames: Array.isArray(data) ? data.map(trace => trace.name) : []
      };
      element.dataset.plotlyRendered = 'true';
      element.dataset.traceCount = String(window.__plots[element.id].traceCount);
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


def read_blob_text(page: Page, selector: str) -> str:
    return page.evaluate(
        """async (selector) => {
            const href = document.querySelector(selector).href;
            return await (await fetch(href)).text();
        }""",
        selector,
    )


def test_portal_analyzes_uploaded_csv_files_with_transparent_outputs(page: Page) -> None:
    expect(page.get_by_role("heading", name="Analiza cyklicznego ściskania")).to_be_visible()
    expect(page.locator("#analizuj")).to_be_disabled()

    page.locator("#pliki").set_input_files([str(path) for path in CSV_FILES])
    expect(page.locator("#lista-plikow li")).to_have_count(3)
    expect(page.locator("#analizuj")).to_be_enabled()

    page.locator("#analizuj").click()

    expect(page.locator("#wyniki")).to_be_visible(timeout=20_000)
    expect(page.locator("#blad")).to_be_empty()
    expect(page.locator("#podsumowanie")).to_contain_text("wykryto cykli: 6")
    expect(page.locator("#podsumowanie")).to_contain_text("pierwszy cykl traktowany jako preload/QC")

    expect(page.locator("#tabela tr")).to_have_count(7)
    expect(page.locator("#tabela-mech tr")).to_have_count(7)
    expect(page.locator("#tabela-qc tr")).to_have_count(7)
    expect(page.locator("#tabela")).to_contain_text("preconditioning/QC")
    expect(page.locator("#tabela")).to_contain_text("elastic recovery")
    expect(page.locator("#tabela-mech")).to_contain_text("stress retention")
    expect(page.locator("#tabela-mech")).to_contain_text("Esec90")
    expect(page.locator("#tabela-qc")).to_contain_text("zeroed negative stress")

    expect(page.locator(".info")).to_have_count(6)
    expect(page.locator("body")).to_contain_text("σ+ = max(σ, 0)")
    expect(page.locator("body")).to_contain_text("Esec90 = σ90% / 0.90")
    expect(page.locator("body")).to_contain_text("Retentionn = (σmax,n / σmax,cycle1) × 100")

    summary_csv = read_blob_text(page, "#pobierz-summary")
    trace_csv = read_blob_text(page, "#pobierz-trace")
    assert "cycle_label;cycle_number;is_preload" in summary_csv
    assert "elastic_recovery_value_pct" in summary_csv
    assert "stress_retention_pct" in summary_csv
    assert "sigma90_left_global_index" in summary_csv
    assert "sigma90_right_stress_plus_mpa" in summary_csv
    assert "raw_point;global_index;source_file" in trace_csv
    assert "trapezoid_area_kJ_m3" in trace_csv
    assert "force_for_fd_n" in trace_csv
    assert "force_plus_n" not in trace_csv
    assert "final_hysteresis_kJ_m3" in trace_csv
    assert "final_stress_retention_pct" in trace_csv
    assert "final_Esec90_MPa" in trace_csv

    plots = page.evaluate("window.__plots")
    assert plots["wykres-zbiorczy"]["traceNames"] == ["cycle 1", "cycle 2", "cycle 3", "cycle 4", "cycle 5"]
    assert plots["wykres-zbiorczy"]["xTitle"] == "Strain [%]"
    assert plots["wykres-zbiorczy"]["yTitle"] == "Stress+ [MPa]"
    assert plots["wykres-force"]["traceNames"] == ["cycle 1", "cycle 2", "cycle 3", "cycle 4", "cycle 5"]
    assert plots["wykres-force"]["yTitle"] == "Force [N]"
    assert "preload" not in plots["wykres-trendy"]["traceNames"]

    expect(page.locator("#wykres-zbiorczy")).to_have_attribute("data-plotly-rendered", "true")
    expect(page.locator("#wykres-force")).to_have_attribute("data-plotly-rendered", "true")
    expect(page.locator("#wykres-trendy")).to_have_attribute("data-plotly-rendered", "true")


def test_portal_shows_error_for_invalid_csv(page: Page, tmp_path: Path) -> None:
    invalid_csv = tmp_path / "smieci.csv"
    invalid_csv.write_text("to,nie,jest\nzaden,pomiar\n", encoding="utf-8")

    page.locator("#pliki").set_input_files(str(invalid_csv))
    page.locator("#analizuj").click()

    expect(page.locator("#blad")).to_contain_text("Błąd:", timeout=20_000)
    expect(page.locator("#blad")).to_contain_text("smieci.csv")
    expect(page.locator("#wyniki")).to_be_hidden()
