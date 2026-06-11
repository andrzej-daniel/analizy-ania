/* Analiza cyklicznego ściskania — logika 1:1 z notebooka analiza_sciskanie_cykliczne.ipynb.
   Czysty JS, bez backendu: parsowanie CSV, walidacja, detekcja cykli, całka trapezów ∮σ dε,
   rozdzielenie adhezji, moduły sieczne, zmiękczenie, odkształcenie trwałe, stabilizacja histerezy. */

const PROG_MM = 0.02;       // margines na szum wokół zera przemieszczenia
const MIN_PUNKTOW = 200;    // minimalna długość segmentu uznawanego za cykl
const OKNO_WYGLADZANIA = 51; // okno średniej ruchomej do modułów/progów (całki liczone na surowych danych)

// ---------- parsowanie ----------

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

// ---------- walidacja i scalanie ----------

function waliduj(listyWierszy, nazwy) {
  const bledy = [];
  const ostrzezenia = [];
  const zakresy = [];

  listyWierszy.forEach((wiersze, i) => {
    const nazwa = nazwy?.[i] ?? `plik ${i + 1}`;
    if (!wiersze.length) {
      bledy.push(`Plik „${nazwa}" nie zawiera żadnych wierszy z 5 wartościami liczbowymi — to na pewno eksport z maszyny (Czas, Siła, Przemieszczenie, Naprężenie, Rozstaw)?`);
      return;
    }
    const t = wiersze.map(w => w[0]);
    zakresy.push({ nazwa, od: Math.min(...t), do: Math.max(...t), n: wiersze.length });
  });
  if (bledy.length) return { bledy, ostrzezenia, zakresy, dane: [] };

  // scalenie + sort + deduplikacja identycznych wierszy (np. ten sam plik wgrany 2×)
  let dane = listyWierszy.flat();
  dane.sort((a, b) => a[0] - b[0]);
  const przed = dane.length;
  dane = dane.filter((w, i) => i === 0 || !(w[0] === dane[i - 1][0] && w[1] === dane[i - 1][1] && w[2] === dane[i - 1][2]));
  const usuniete = przed - dane.length;
  if (usuniete > 0) {
    ostrzezenia.push(`Usunięto ${usuniete.toLocaleString('pl-PL')} zduplikowanych wierszy — możliwe, że ten sam plik został wgrany więcej niż raz.`);
  }

  if (!dane.length) {
    bledy.push('Po scaleniu plików nie zostały żadne dane.');
    return { bledy, ostrzezenia, zakresy, dane };
  }

  // powtórzone czasy z różnymi wartościami (nakładające się, ale niespójne pliki)
  let kolizje = 0;
  for (let i = 1; i < dane.length; i++) if (dane[i][0] === dane[i - 1][0]) kolizje++;
  if (kolizje > 0) {
    ostrzezenia.push(`${kolizje.toLocaleString('pl-PL')} punktów ma ten sam czas, ale różne wartości — pliki nakładają się zakresami. Sprawdź, czy wszystkie pochodzą z tego samego pomiaru.`);
  }

  // dziury w czasie (np. wgrano część 1 i 3 bez 2)
  const dt = [];
  for (let i = 1; i < dane.length; i++) dt.push(dane[i][0] - dane[i - 1][0]);
  const dtSort = [...dt].sort((a, b) => a - b);
  const medianaDt = dtSort[Math.floor(dtSort.length / 2)] || 0;
  if (medianaDt > 0) {
    const dziury = [];
    for (let i = 0; i < dt.length; i++) {
      if (dt[i] > 10 * medianaDt) dziury.push({ t: dane[i][0], dlugosc: dt[i] });
    }
    if (dziury.length) {
      const opis = dziury.slice(0, 3).map(d => `${d.dlugosc.toFixed(1)} s przy t = ${d.t.toFixed(1)} s`).join('; ');
      ostrzezenia.push(`Wykryto ${dziury.length} dziur(y) w osi czasu (${opis}${dziury.length > 3 ? '; …' : ''}) — prawdopodobnie brakuje części pomiaru (np. środkowego pliku). Wyniki cykli przeciętych dziurą będą błędne.`);
    }
  }

  // podejrzane wartości
  if (dane.some(w => w[4] <= 0)) ostrzezenia.push('W danych występuje rozstaw ≤ 0 mm — sprawdź kolumny pliku.');
  if (dane.some(w => Math.abs(w[1]) > 10000)) ostrzezenia.push('Siła przekracza 10 kN — to nie wygląda na ten typ badania, sprawdź jednostki.');
  if (dane.every(w => Math.abs(w[3]) < 1e-9)) ostrzezenia.push('Kolumna naprężenia jest wszędzie zerowa — maszyna nie zapisała naprężeń.');
  if (dane.length < 1000) ostrzezenia.push(`Bardzo krótki pomiar (${dane.length} punktów) — wyniki mogą być niemiarodajne.`);

  return { bledy, ostrzezenia, zakresy, dane };
}

// ---------- narzędzia numeryczne ----------

function trapz(y, x) {
  let s = 0;
  for (let i = 1; i < y.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
  return s;
}

function srSrednia(y, okno) {
  const pol = Math.floor(okno / 2);
  const wynik = new Array(y.length);
  let suma = 0, a = 0, b = -1; // okno [a, b]
  for (let i = 0; i < y.length; i++) {
    const na = Math.max(0, i - pol), nb = Math.min(y.length - 1, i + pol);
    while (b < nb) suma += y[++b];
    while (a < na) suma -= y[a++];
    wynik[i] = suma / (b - a + 1);
  }
  return wynik;
}

// interpolacja liniowa po gałęzi (xs niekoniecznie ściśle rosnące — czyścimy do rosnących)
function interpolator(xs, ys) {
  const X = [], Y = [];
  for (let i = 0; i < xs.length; i++) {
    if (!X.length || xs[i] > X[X.length - 1]) { X.push(xs[i]); Y.push(ys[i]); }
  }
  return x => {
    if (!X.length || x < X[0] || x > X[X.length - 1]) return null;
    let lo = 0, hi = X.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X[m] <= x) lo = m; else hi = m; }
    const u = (x - X[lo]) / (X[hi] - X[lo] || 1);
    return Y[lo] + u * (Y[hi] - Y[lo]);
  };
}

// ---------- detekcja cykli i wielkości per cykl ----------

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

const POZIOMY_ZMIEKCZENIA = [0.30, 0.60, 0.85]; // poziomy ε do śledzenia zmiękczenia

function policzCykl(seg, h0) {
  const eps = seg.map(w => w[2] / h0);
  const sig = seg.map(w => w[3]);
  const d = seg.map(w => w[2]);
  const F = seg.map(w => w[1]);
  const iMax = eps.indexOf(Math.max(...eps));
  const sigPlus = sig.map(v => Math.max(v, 0));
  const sigMinus = sig.map(v => Math.min(v, 0));

  // energie — surowe i z odciętą adhezją (σ⁺); jednostka mJ/mm³ = MJ/m³
  const wPetlaSurowe = trapz(sig, eps);
  const wObc = trapz(sigPlus.slice(0, iMax + 1), eps.slice(0, iMax + 1));
  const wOdc = -trapz(sigPlus.slice(iMax), eps.slice(iMax));
  const polePetli = trapz(sigPlus, eps);          // histereza materiału (bez adhezji)
  const pracaAdhezji = trapz(sigMinus, eps);      // energia odrywania od płyty (≥ 0, bo σ<0 przy dε<0)
  const pracaMj = trapz(F, d);                    // pętla siła–przemieszczenie [N·mm = mJ]

  // gałąź obciążania, wygładzona — do modułów, zmiękczenia i progu kontaktu
  const epsObc = eps.slice(0, iMax + 1);
  const sigObcWygl = srSrednia(sig.slice(0, iMax + 1), OKNO_WYGLADZANIA);
  const sigPrzy = interpolator(epsObc, sigObcWygl);

  const modulSieczny = (e1, e2) => {
    const s1 = sigPrzy(e1), s2 = sigPrzy(e2);
    return s1 !== null && s2 !== null ? (s2 - s1) / (e2 - e1) : null;
  };
  const sigmaPoziomy = POZIOMY_ZMIEKCZENIA.map(e => sigPrzy(e));

  // odkształcenie kontaktu: pierwsze ε, przy którym wygładzone σ przekracza próg
  const sigmaMax = Math.max(...sig);
  const prog = Math.max(0.005 * sigmaMax, 0.001);
  let epsKontakt = null;
  for (let i = 0; i < epsObc.length; i++) {
    if (sigObcWygl[i] > prog) { epsKontakt = epsObc[i]; break; }
  }

  return {
    sigmaMax,
    epsMaxPct: Math.max(...eps) * 100,
    polePetli, poleKJm3: polePetli * 1000,
    pracaAdhezji, pracaAdhezjiKJm3: pracaAdhezji * 1000,
    wPetlaSurowe,
    wObc, wOdc,
    dyssypacjaPct: wObc > 0 ? 100 * polePetli / wObc : null,
    resiliencePct: wObc > 0 ? 100 * wOdc / wObc : null,
    pracaMj,
    e1030: modulSieczny(0.10, 0.30),
    e6085: modulSieczny(0.60, 0.85),
    sigmaPoziomy,
    epsKontaktPct: epsKontakt !== null ? epsKontakt * 100 : null,
    fMax: Math.max(...F),
    tStart: seg[0][0], tKoniec: seg[seg.length - 1][0],
  };
}

// dopasowanie W_n = Winf + A·exp(-(n-1)/τ) — grid po τ + liniowe LSQ na [Winf, A]
function dopasujStabilizacje(W) {
  if (W.length < 3) return null;
  const n = W.length;
  let najlepsze = null;
  for (let k = 0; k <= 300; k++) {
    const tau = Math.exp(Math.log(0.2) + (Math.log(50) - Math.log(0.2)) * k / 300);
    const f = Array.from({ length: n }, (_, i) => Math.exp(-i / tau));
    // normalne równania dla [Winf, A]
    let s1 = n, sf = 0, sff = 0, sw = 0, swf = 0;
    for (let i = 0; i < n; i++) { sf += f[i]; sff += f[i] * f[i]; sw += W[i]; swf += W[i] * f[i]; }
    const det = s1 * sff - sf * sf;
    if (Math.abs(det) < 1e-12) continue;
    const winf = (sw * sff - swf * sf) / det;
    const A = (s1 * swf - sf * sw) / det;
    let sse = 0;
    for (let i = 0; i < n; i++) { const r = W[i] - (winf + A * f[i]); sse += r * r; }
    if (!najlepsze || sse < najlepsze.sse) najlepsze = { winf, A, tau, sse };
  }
  if (!najlepsze) return null;
  const sr = W.reduce((a, b) => a + b, 0) / n;
  const sst = W.reduce((a, w) => a + (w - sr) ** 2, 0);
  najlepsze.r2 = sst > 0 ? 1 - najlepsze.sse / sst : 1;
  najlepsze.przewidywana = i => najlepsze.winf + najlepsze.A * Math.exp(-i / najlepsze.tau);
  return najlepsze;
}

// ---------- analiza całości ----------

function analizuj(listyWierszy, h0Wejsciowe, nazwy) {
  const { bledy, ostrzezenia, zakresy, dane } = waliduj(listyWierszy, nazwy);
  if (bledy.length) throw new Error(bledy.join('\n'));

  const h0 = h0Wejsciowe || dane[0][4]; // rozstaw na początku pomiaru
  if (!(h0 > 0)) throw new Error(`Nieprawidłowe h₀ (rozstaw w danych: ${dane[0][4]} mm).`);

  const cykle = wykryjCykle(dane);
  if (!cykle.length) throw new Error(`Nie wykryto żadnych cykli ściskania (przemieszczenie nigdy nie przekracza ${PROG_MM} mm).`);

  const wyniki = cykle.map(seg => policzCykl(seg, h0));
  const bazaKontakt = wyniki[0].epsKontaktPct;
  wyniki.forEach(w => {
    w.permanentSetPp = (w.epsKontaktPct !== null && bazaKontakt !== null) ? w.epsKontaktPct - bazaKontakt : null;
  });

  return { h0, liczbaPunktow: dane.length, cykle, wyniki, ostrzezenia, zakresy };
}

// eksport do testów w node (w przeglądarce module nie istnieje)
if (typeof module !== 'undefined') {
  module.exports = { parsujCsv, waliduj, wykryjCykle, trapz, srSrednia, interpolator, policzCykl, dopasujStabilizacje, analizuj, POZIOMY_ZMIEKCZENIA };
}

// ---------- UI (tylko w przeglądarce) ----------

if (typeof document !== 'undefined') {
  const dropzone = document.getElementById('dropzone');
  const inputPliki = document.getElementById('pliki');
  const lista = document.getElementById('lista-plikow');
  const przycisk = document.getElementById('analizuj');
  const blad = document.getElementById('blad');
  const panelOstrzezen = document.getElementById('ostrzezenia');
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
    wybranePliki = pliki.filter(p => /\.(csv|txt)$/i.test(p.name) || p.type.includes('csv') || p.type === 'text/plain');
    lista.innerHTML = wybranePliki.map((p, i) => `<li id="plik-${i}">${p.name} (${(p.size / 1e6).toFixed(1)} MB)</li>`).join('');
    przycisk.disabled = wybranePliki.length === 0;
    blad.textContent = wybranePliki.length === pliki.length ? '' : 'Pominięto pliki niebędące CSV/TXT.';
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
    panelOstrzezen.style.display = 'none';
    przycisk.disabled = true;
    przycisk.textContent = 'Liczenie…';
    try {
      const listy = await Promise.all(wybranePliki.map(odczytajPlik));
      const h0Pole = parseFloat(document.getElementById('h0').value.replace(',', '.'));
      const rezultat = analizuj(listy, Number.isFinite(h0Pole) ? h0Pole : null, wybranePliki.map(p => p.name));
      // dopisz zakres czasu do listy plików
      rezultat.zakresy.forEach((z, i) => {
        const li = document.getElementById(`plik-${i}`);
        if (li) li.textContent = `${z.nazwa} — t = ${z.od.toFixed(1)}–${z.do.toFixed(1)} s, ${z.n.toLocaleString('pl-PL')} punktów`;
      });
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

  const fmt = (x, n = 4) => x === null || x === undefined || Number.isNaN(x)
    ? '—'
    : x.toLocaleString('pl-PL', { minimumFractionDigits: n, maximumFractionDigits: n });

  function pokazWyniki({ h0, liczbaPunktow, cykle, wyniki, ostrzezenia }) {
    let preload = document.getElementById('preload').checked;
    if (preload && cykle.length < 2) {
      ostrzezenia = [...ostrzezenia, 'Wykryto tylko 1 cykl — opcja „pierwsze ściśnięcie to preload" została zignorowana.'];
      preload = false;
    }
    const nazwy = etykiety(cykle.length, preload);
    const kolory = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];

    // panel ostrzeżeń
    if (ostrzezenia.length) {
      panelOstrzezen.innerHTML = '<strong>⚠ Ostrzeżenia:</strong><ul>' + ostrzezenia.map(o => `<li>${o}</li>`).join('') + '</ul>';
      panelOstrzezen.style.display = 'block';
    }

    // tabela energetyczna
    const kolEnergia = ['', 'σ_max [MPa]', 'ε_max [%]', 'histereza σ⁺ [kJ/m³]', 'praca adhezji [kJ/m³]',
      'dyssypacja [%]', 'resilience [%]', 'praca pętli [N·mm]'];
    let html = '<tr>' + kolEnergia.map(h => `<th>${h}</th>`).join('') + '</tr>';
    wyniki.forEach((w, i) => {
      const klasa = preload && i === 0 ? ' class="preload"' : '';
      html += `<tr${klasa}><td>${nazwy[i]}</td><td>${fmt(w.sigmaMax)}</td><td>${fmt(w.epsMaxPct, 2)}</td>` +
        `<td>${fmt(w.poleKJm3, 2)}</td><td>${fmt(w.pracaAdhezjiKJm3, 2)}</td>` +
        `<td>${fmt(w.dyssypacjaPct, 1)}</td><td>${fmt(w.resiliencePct, 1)}</td><td>${fmt(w.pracaMj, 2)}</td></tr>`;
    });
    document.getElementById('tabela').innerHTML = html;

    // tabela sztywności i zmiękczenia
    const pozProc = POZIOMY_ZMIEKCZENIA.map(p => Math.round(p * 100));
    const kolMech = ['', 'E₁₀₋₃₀ [MPa]', 'E₆₀₋₈₅ [MPa]',
      ...pozProc.map(p => `σ(${p}%) [MPa]`),
      `σ(${pozProc[1]}%) vs 1. ściśnięcie [%]`, 'ε kontaktu [%]', 'permanent set [p.p.]'];
    let html2 = '<tr>' + kolMech.map(h => `<th>${h}</th>`).join('') + '</tr>';
    const bazaSigma = wyniki[0].sigmaPoziomy[1];
    wyniki.forEach((w, i) => {
      const klasa = preload && i === 0 ? ' class="preload"' : '';
      const wzgledne = (w.sigmaPoziomy[1] !== null && bazaSigma) ? 100 * w.sigmaPoziomy[1] / bazaSigma : null;
      html2 += `<tr${klasa}><td>${nazwy[i]}</td><td>${fmt(w.e1030)}</td><td>${fmt(w.e6085)}</td>` +
        w.sigmaPoziomy.map(s => `<td>${fmt(s)}</td>`).join('') +
        `<td>${fmt(wzgledne, 1)}</td><td>${fmt(w.epsKontaktPct, 2)}</td><td>${fmt(w.permanentSetPp, 2)}</td></tr>`;
    });
    document.getElementById('tabela-mech').innerHTML = html2;

    // stabilizacja histerezy (bez preloadu)
    const wlasciwe = preload ? wyniki.slice(1) : wyniki;
    const fit = dopasujStabilizacje(wlasciwe.map(w => w.poleKJm3));
    const elFit = document.getElementById('stabilizacja');
    if (fit) {
      elFit.textContent = `Stabilizacja histerezy (bez preloadu): W∞ = ${fmt(fit.winf, 1)} kJ/m³, ` +
        `stała zaniku τ = ${fmt(fit.tau, 1)} cykli (R² = ${fmt(fit.r2, 3)}). ` +
        `Materiał zmierza asymptotycznie do ~${fmt(fit.winf, 0)} kJ/m³ rozpraszanej energii na cykl.`;
    } else {
      elFit.textContent = 'Stabilizacja histerezy: za mało cykli właściwych do dopasowania (potrzebne ≥ 3).';
    }

    document.getElementById('podsumowanie').textContent =
      `Punktów pomiarowych: ${liczbaPunktow.toLocaleString('pl-PL')} · h₀ = ${fmt(h0)} mm · ` +
      `wykryto ściśnięć: ${cykle.length}` + (preload ? ' (pierwsze jako preload)' : '');

    // CSV do pobrania (wszystkie wielkości, także surowe)
    const kolCsv = ['cykl', 'sigma_max [MPa]', 'eps_max [%]', 'histereza sigma+ [mJ/mm3]', 'histereza sigma+ [kJ/m3]',
      'praca adhezji [kJ/m3]', 'histereza surowa [mJ/mm3]', 'W obciazania [mJ/mm3]', 'W odciazania [mJ/mm3]',
      'dyssypacja [%]', 'resilience [%]', 'praca petli [N*mm]', 'E10-30 [MPa]', 'E60-85 [MPa]',
      ...pozProc.map(p => `sigma(${p}%) [MPa]`), 'eps kontaktu [%]', 'permanent set [pp]'];
    const csv = [kolCsv.join(';')].concat(wyniki.map((w, i) =>
      [nazwy[i], w.sigmaMax, w.epsMaxPct, w.polePetli, w.poleKJm3, w.pracaAdhezjiKJm3, w.wPetlaSurowe,
        w.wObc, w.wOdc, w.dyssypacjaPct, w.resiliencePct, w.pracaMj, w.e1030, w.e6085,
        ...w.sigmaPoziomy, w.epsKontaktPct, w.permanentSetPp]
        .map(v => v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : v).join(';'))).join('\n');
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
      xaxis: { title: { text: 'Odkształcenie / Strain [%]', standoff: 8 }, rangemode: 'tozero' },
      yaxis: { title: 'Naprężenie / Stress [MPa]' },
      legend: { orientation: 'h', yanchor: 'top', y: -0.22 },
      margin: { t: 50, b: 95 },
    }, { responsive: true, displaylogo: false });

    // pętle histerezy — małe wykresy w siatce
    const kolumn = Math.min(3, cykle.length);
    const wierszy = Math.ceil(cykle.length / kolumn);
    const sladyPetli = [];
    const ukladPetli = {
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
      ukladPetli.annotations.push({
        text: `${nazwy[i]}: ${fmt(wyniki[i].poleKJm3, 1)} kJ/m³`,
        xref: 'x' + os + ' domain', yref: 'y' + os + ' domain',
        x: 0.05, y: 0.95, showarrow: false, font: { size: 12 },
      });
    });
    Plotly.newPlot('wykres-petle', sladyPetli, ukladPetli, { responsive: true, displaylogo: false });

    // trendy vs numer cyklu (2×2)
    rysujTrendy(wyniki, nazwy, preload, fit, kolory);

    document.getElementById('wyniki').style.display = 'block';
    document.getElementById('wyniki').scrollIntoView({ behavior: 'smooth' });
  }

  function rysujTrendy(wyniki, nazwy, preload, fit, kolory) {
    // oś x: preload przy 0 (pusty znacznik), cykle właściwe 1..K
    const xs = wyniki.map((_, i) => preload ? i : i + 1);
    const znaczniki = wyniki.map((_, i) => preload && i === 0 ? 'circle-open' : 'circle');
    const punkt = (osNr, ys, nazwa, kolor) => ({
      x: xs, y: ys, name: nazwa, mode: 'lines+markers',
      marker: { symbol: znaczniki, size: 8, color: kolor }, line: { color: kolor, width: 1.5 },
      xaxis: 'x' + (osNr > 1 ? osNr : ''), yaxis: 'y' + (osNr > 1 ? osNr : ''),
    });
    const slady = [
      punkt(1, wyniki.map(w => w.poleKJm3), 'histereza σ⁺', kolory[0]),
      punkt(2, wyniki.map(w => w.e1030), 'E₁₀₋₃₀', kolory[1]),
      punkt(2, wyniki.map(w => w.e6085), 'E₆₀₋₈₅', kolory[2]),
      ...POZIOMY_ZMIEKCZENIA.map((p, k) =>
        punkt(3, wyniki.map(w => w.sigmaPoziomy[k]), `σ(${Math.round(p * 100)}%)`, kolory[3 + k])),
      punkt(4, wyniki.map(w => w.permanentSetPp), 'permanent set', kolory[6]),
    ];
    if (fit) {
      const xFit = [], yFit = [];
      const K = preload ? wyniki.length - 1 : wyniki.length;
      for (let u = 0; u <= 40; u++) {
        const n = 1 + (K - 1) * u / 40;
        xFit.push(n); yFit.push(fit.przewidywana(n - 1));
      }
      slady.push({ x: xFit, y: yFit, name: 'dopasowanie', mode: 'lines', line: { color: kolory[0], dash: 'dash', width: 1 }, xaxis: 'x', yaxis: 'y' });
      slady.push({ x: [xs[0], xs[xs.length - 1]], y: [fit.winf, fit.winf], name: 'W∞', mode: 'lines', line: { color: '#555', dash: 'dot', width: 1 }, xaxis: 'x', yaxis: 'y' });
    }
    // bez podpisu „cykl" pod osiami — etykiety preload/1/2/… mówią same za siebie,
    // a podpisy osi kolidowały z legendą i tytułami dolnego wiersza siatki
    const tickvals = xs, ticktext = nazwy.map(n => n.replace('cykl ', ''));
    const osie = {};
    for (let k = 1; k <= 4; k++) {
      osie['xaxis' + (k > 1 ? k : '')] = { tickvals, ticktext };
    }
    const tytuly = ['Pole histerezy σ⁺ [kJ/m³]', 'Moduły sieczne [MPa]', 'σ przy zadanym ε [MPa]', 'Permanent set [p.p.]'];
    Plotly.newPlot('wykres-trendy', slady, {
      grid: { rows: 2, columns: 2, pattern: 'independent', ygap: 0.22 },
      title: 'Ewolucja parametrów z numerem cyklu' + (preload ? ' (pusty znacznik = preload)' : ''),
      height: 640, margin: { t: 70, b: 80 },
      legend: { orientation: 'h', yanchor: 'top', y: -0.07 },
      ...osie,
      annotations: tytuly.map((t, k) => ({
        text: t, xref: 'x' + (k > 0 ? k + 1 : '') + ' domain', yref: 'y' + (k > 0 ? k + 1 : '') + ' domain',
        x: 0.5, y: 1.14, showarrow: false, font: { size: 13 },
      })),
    }, { responsive: true, displaylogo: false });
  }
}
