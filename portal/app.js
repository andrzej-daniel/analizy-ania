/* Analiza cyklicznego ściskania — logika 1:1 z notebooka analiza_sciskanie_cykliczne.ipynb.
   Czysty JS, bez backendu: parsowanie CSV, detekcja cykli, całka trapezów ∮σ dε. */

const PROG_MM = 0.02;     // margines na szum wokół zera przemieszczenia
const MIN_PUNKTOW = 200;  // minimalna długość segmentu uznawanego za cykl

// ---------- analiza (czyste funkcje, używane też w testach node) ----------

function parsujCsv(tekst) {
  // Wiersze nagłówkowe (aq, nazwy kolumn, jednostki) odpadają same — nie parsują się do 5 liczb.
  // Obsługa: pola w cudzysłowach z przecinkiem dziesiętnym, albo bez cudzysłowów (separator ; lub ,).
  const wiersze = [];
  for (const surowa of tekst.split(/\r?\n/)) {
    const linia = surowa.trim();
    if (!linia) continue;
    let pola;
    if (linia.includes('"')) {
      pola = [...linia.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    } else if (linia.includes(';')) {
      pola = linia.split(';');
    } else {
      pola = linia.split(',');
    }
    if (pola.length < 5) continue;
    const w = pola.slice(0, 5).map(p => Number(p.trim().replace(',', '.')));
    if (w.some(Number.isNaN)) continue;
    wiersze.push(w); // [czas, sila, przemieszczenie, naprezenie, rozstaw]
  }
  return wiersze;
}

function polaczISortuj(listyWierszy) {
  const dane = listyWierszy.flat();
  dane.sort((a, b) => a[0] - b[0]);
  return dane;
}

function wykryjCykle(dane) {
  const segmenty = [];
  let start = null;
  for (let i = 0; i <= dane.length; i++) {
    const kontakt = i < dane.length && dane[i][2] > PROG_MM;
    if (kontakt && start === null) start = i;
    else if (!kontakt && start !== null) {
      if (i - start >= MIN_PUNKTOW) segmenty.push(dane.slice(start, i));
      start = null;
    }
  }
  return segmenty;
}

function trapz(y, x) {
  let s = 0;
  for (let i = 1; i < y.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
  return s;
}

function policzCykl(seg, h0) {
  const eps = seg.map(w => w[2] / h0);
  const sig = seg.map(w => w[3]);
  const d = seg.map(w => w[2]);
  const F = seg.map(w => w[1]);
  const iMax = eps.indexOf(Math.max(...eps));

  const wObc = trapz(sig.slice(0, iMax + 1), eps.slice(0, iMax + 1));  // [mJ/mm³]
  const wOdc = -trapz(sig.slice(iMax), eps.slice(iMax));
  const wPetla = trapz(sig, eps);                                      // pole pętli = wObc - wOdc
  const pracaMj = trapz(F, d);                                         // [N·mm = mJ]

  return {
    sigmaMax: Math.max(...sig),
    epsMaxPct: Math.max(...eps) * 100,
    polePetli: wPetla,            // [mJ/mm³ = MJ/m³]
    poleKJm3: wPetla * 1000,      // [kJ/m³]
    wObc, wOdc,
    dyssypacjaPct: 100 * wPetla / wObc,
    pracaMj,
    tStart: seg[0][0], tKoniec: seg[seg.length - 1][0],
    fMax: Math.max(...F),
  };
}

function analizuj(listyWierszy, h0Wejsciowe) {
  const dane = polaczISortuj(listyWierszy);
  if (!dane.length) throw new Error('Nie udało się odczytać żadnych danych liczbowych z plików.');
  const h0 = h0Wejsciowe || dane[0][4]; // rozstaw na początku pomiaru
  if (!(h0 > 0)) throw new Error('Nieprawidłowe h₀ (rozstaw w danych: ' + dane[0][4] + ' mm).');
  const cykle = wykryjCykle(dane);
  if (!cykle.length) throw new Error('Nie wykryto żadnych cykli ściskania (przemieszczenie nigdy nie przekracza ' + PROG_MM + ' mm).');
  return { h0, liczbaPunktow: dane.length, cykle, wyniki: cykle.map(seg => policzCykl(seg, h0)) };
}

// eksport do testów w node (w przeglądarce module nie istnieje)
if (typeof module !== 'undefined') {
  module.exports = { parsujCsv, polaczISortuj, wykryjCykle, trapz, policzCykl, analizuj };
}

// ---------- UI (tylko w przeglądarce) ----------

if (typeof document !== 'undefined') {
  const dropzone = document.getElementById('dropzone');
  const inputPliki = document.getElementById('pliki');
  const lista = document.getElementById('lista-plikow');
  const przycisk = document.getElementById('analizuj');
  const blad = document.getElementById('blad');
  let wybranePliki = [];

  dropzone.addEventListener('click', () => inputPliki.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('aktywny'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('aktywny'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('aktywny');
    ustawPliki([...e.dataTransfer.files]);
  });
  inputPliki.addEventListener('change', () => ustawPliki([...inputPliki.files]));

  function ustawPliki(pliki) {
    wybranePliki = pliki.filter(p => /\.csv$/i.test(p.name) || p.type.includes('csv') || p.type === 'text/plain');
    lista.innerHTML = wybranePliki.map(p => `<li>${p.name} (${(p.size / 1e6).toFixed(1)} MB)</li>`).join('');
    przycisk.disabled = wybranePliki.length === 0;
    blad.textContent = wybranePliki.length === pliki.length ? '' : 'Pominięto pliki niebędące CSV.';
  }

  async function odczytajPlik(plik) {
    const bufor = await plik.arrayBuffer();
    let tekst;
    try { tekst = new TextDecoder('windows-1250', { fatal: false }).decode(bufor); }
    catch { tekst = new TextDecoder('utf-8').decode(bufor); }
    return parsujCsv(tekst);
  }

  przycisk.addEventListener('click', async () => {
    blad.textContent = '';
    przycisk.disabled = true;
    przycisk.textContent = 'Liczenie…';
    try {
      const listy = await Promise.all(wybranePliki.map(odczytajPlik));
      const h0Pole = parseFloat(document.getElementById('h0').value.replace(',', '.'));
      const rezultat = analizuj(listy, Number.isFinite(h0Pole) ? h0Pole : null);
      pokazWyniki(rezultat);
    } catch (e) {
      blad.textContent = 'Błąd: ' + e.message;
      document.getElementById('wyniki').style.display = 'none';
    } finally {
      przycisk.disabled = false;
      przycisk.textContent = 'Analizuj';
    }
  });

  function etykiety(n, preload) {
    if (preload && n >= 2) return ['preload', ...Array.from({ length: n - 1 }, (_, i) => `cykl ${i + 1}`)];
    return Array.from({ length: n }, (_, i) => `cykl ${i + 1}`);
  }

  function decymuj(tablica, cel = 2000) {
    if (tablica.length <= cel) return tablica;
    const krok = Math.ceil(tablica.length / cel);
    const wynik = tablica.filter((_, i) => i % krok === 0);
    if (wynik[wynik.length - 1] !== tablica[tablica.length - 1]) wynik.push(tablica[tablica.length - 1]);
    return wynik;
  }

  const fmt = (x, n = 4) => x.toLocaleString('pl-PL', { minimumFractionDigits: n, maximumFractionDigits: n });

  function pokazWyniki({ h0, liczbaPunktow, cykle, wyniki }) {
    const preload = document.getElementById('preload').checked;
    const nazwy = etykiety(cykle.length, preload);
    const kolory = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

    // tabela
    const naglowki = ['', 'σ_max [MPa]', 'ε_max [%]', 'pole histerezy [mJ/mm³]', 'pole histerezy [kJ/m³]',
      'W obciążania [mJ/mm³]', 'W odciążania [mJ/mm³]', 'dyssypacja [%]', 'praca pętli [N·mm]'];
    let html = '<tr>' + naglowki.map(h => `<th>${h}</th>`).join('') + '</tr>';
    wyniki.forEach((w, i) => {
      const klasa = preload && i === 0 ? ' class="preload"' : '';
      html += `<tr${klasa}><td>${nazwy[i]}</td><td>${fmt(w.sigmaMax)}</td><td>${fmt(w.epsMaxPct, 2)}</td>` +
        `<td>${fmt(w.polePetli, 5)}</td><td>${fmt(w.poleKJm3, 2)}</td><td>${fmt(w.wObc, 5)}</td>` +
        `<td>${fmt(w.wOdc, 5)}</td><td>${fmt(w.dyssypacjaPct, 1)}</td><td>${fmt(w.pracaMj, 2)}</td></tr>`;
    });
    document.getElementById('tabela').innerHTML = html;
    document.getElementById('podsumowanie').textContent =
      `Punktów pomiarowych: ${liczbaPunktow.toLocaleString('pl-PL')} · h₀ = ${fmt(h0)} mm · ` +
      `wykryto ściśnięć: ${cykle.length}` + (preload && cykle.length >= 2 ? ' (pierwsze jako preload)' : '');

    // CSV do pobrania
    const csv = [naglowki.join(';')].concat(wyniki.map((w, i) =>
      [nazwy[i], w.sigmaMax, w.epsMaxPct, w.polePetli, w.poleKJm3, w.wObc, w.wOdc, w.dyssypacjaPct, w.pracaMj]
        .map(v => typeof v === 'number' ? String(v).replace('.', ',') : v).join(';'))).join('\n');
    document.getElementById('pobierz-csv').href =
      URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));

    // wykres zbiorczy σ–ε
    const slady = cykle.map((seg, i) => {
      const s = decymuj(seg);
      return {
        x: s.map(w => w[2] / h0 * 100), y: s.map(w => w[3]),
        name: nazwy[i], mode: 'lines',
        line: { color: kolory[i % kolory.length], width: 1.4, dash: preload && i === 0 ? 'dot' : 'solid' },
      };
    });
    Plotly.newPlot('wykres-zbiorczy', slady, {
      title: 'Krzywe naprężenie–odkształcenie',
      xaxis: { title: 'Odkształcenie / Strain [%]', rangemode: 'tozero' },
      yaxis: { title: 'Naprężenie / Stress [MPa]' },
      legend: { orientation: 'h' }, margin: { t: 50 },
    }, { responsive: true, displaylogo: false });

    // pętle histerezy — małe wykresy w siatce
    const kolumn = Math.min(3, cykle.length);
    const wierszy = Math.ceil(cykle.length / kolumn);
    const sladyPetli = [];
    const uklad = {
      grid: { rows: wierszy, columns: kolumn, pattern: 'independent' },
      title: 'Pętle histerezy (wypełnienie = energia rozproszona)',
      showlegend: false, margin: { t: 70 }, height: Math.max(480, wierszy * 260),
      annotations: [],
    };
    cykle.forEach((seg, i) => {
      const s = decymuj(seg);
      const os = i === 0 ? '' : String(i + 1);
      sladyPetli.push({
        x: s.map(w => w[2] / h0 * 100), y: s.map(w => w[3]),
        xaxis: 'x' + os, yaxis: 'y' + os,
        mode: 'lines', fill: 'toself',
        line: { color: kolory[i % kolory.length], width: 1.2 },
        fillcolor: kolory[i % kolory.length] + '33',
      });
      uklad.annotations.push({
        text: `${nazwy[i]}: ${fmt(wyniki[i].poleKJm3, 1)} kJ/m³`,
        xref: 'x' + os + ' domain', yref: 'y' + os + ' domain',
        x: 0.05, y: 0.95, showarrow: false, font: { size: 12 },
      });
    });
    Plotly.newPlot('wykres-petle', sladyPetli, uklad, { responsive: true, displaylogo: false });

    document.getElementById('wyniki').style.display = 'block';
    document.getElementById('wyniki').scrollIntoView({ behavior: 'smooth' });
  }
}
