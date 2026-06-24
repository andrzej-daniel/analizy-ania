/* Analiza cyklicznego sciskania hydrozeli.
   Wszystkie parametry sa liczone z surowych punktow CSV, a eksport trace pozwala
   przejsc od punktu pomiarowego do trapezu, fazy cyklu i parametru koncowego. */

const PROG_MM = 0.02;
const MIN_PUNKTOW = 200;
const POZIOMY_ODKSZTALCENIA = [0.10, 0.30, 0.50, 0.70, 0.90];
const LICZBA_CYKLI_PUBLIKACYJNYCH = 5;

// ---------- parsowanie ----------

function parsujCsv(tekst) {
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
  const punkty = [];

  listyWierszy.forEach((wiersze, i) => {
    const nazwa = nazwy?.[i] ?? `plik ${i + 1}`;
    if (!wiersze.length) {
      bledy.push(`Plik „${nazwa}" nie zawiera zadnych wierszy z 5 wartosciami liczbowymi — to na pewno eksport z maszyny (Czas, Sila, Przemieszczenie, Naprezenie, Rozstaw)?`);
      return;
    }
    const t = wiersze.map(w => w[0]);
    zakresy.push({ nazwa, od: Math.min(...t), do: Math.max(...t), n: wiersze.length });
    wiersze.forEach((w, j) => {
      punkty.push({
        time: w[0],
        force: w[1],
        displacement: w[2],
        stressRaw: w[3],
        spacing: w[4],
        sourceFile: nazwa,
        sourceFileIndex: i,
        sourceRow: j + 1,
      });
    });
  });
  if (bledy.length) return { bledy, ostrzezenia, zakresy, dane: [] };

  punkty.sort((a, b) =>
    a.time - b.time ||
    a.sourceFileIndex - b.sourceFileIndex ||
    a.sourceRow - b.sourceRow
  );

  const przed = punkty.length;
  const widziane = new Set();
  let dane = [];
  for (const p of punkty) {
    const klucz = [p.time, p.force, p.displacement, p.stressRaw, p.spacing].join('|');
    if (widziane.has(klucz)) continue;
    widziane.add(klucz);
    dane.push(p);
  }
  const usuniete = przed - dane.length;
  if (usuniete > 0) {
    ostrzezenia.push(`Usunieto ${usuniete.toLocaleString('pl-PL')} zduplikowanych wierszy — mozliwe, ze ten sam plik zostal wgrany wiecej niz raz.`);
  }

  if (!dane.length) {
    bledy.push('Po scaleniu plikow nie zostaly zadne dane.');
    return { bledy, ostrzezenia, zakresy, dane };
  }

  let kolizje = 0;
  for (let i = 1; i < dane.length; i++) if (dane[i].time === dane[i - 1].time) kolizje++;
  if (kolizje > 0) {
    ostrzezenia.push(`${kolizje.toLocaleString('pl-PL')} punktow ma ten sam czas, ale rozne wartosci — pliki nakladaja sie zakresami. Sprawdz, czy wszystkie pochodza z tego samego pomiaru.`);
  }

  const dt = [];
  for (let i = 1; i < dane.length; i++) dt.push(dane[i].time - dane[i - 1].time);
  const dtSort = [...dt].sort((a, b) => a - b);
  const medianaDt = dtSort[Math.floor(dtSort.length / 2)] || 0;
  if (medianaDt > 0) {
    const dziury = [];
    for (let i = 0; i < dt.length; i++) {
      if (dt[i] > 10 * medianaDt) dziury.push({ t: dane[i].time, dlugosc: dt[i] });
    }
    if (dziury.length) {
      const opis = dziury.slice(0, 3).map(d => `${d.dlugosc.toFixed(1)} s przy t = ${d.t.toFixed(1)} s`).join('; ');
      ostrzezenia.push(`Wykryto ${dziury.length} dziur(y) w osi czasu (${opis}${dziury.length > 3 ? '; ...' : ''}) — prawdopodobnie brakuje czesci pomiaru. Wyniki cykli przecietych dziura beda bledne.`);
    }
  }

  dane = dane.map((p, i) => ({ ...p, globalIndex: i + 1 }));

  if (dane.some(p => p.spacing <= 0)) ostrzezenia.push('W danych wystepuje rozstaw <= 0 mm — sprawdz kolumny pliku.');
  if (dane.some(p => Math.abs(p.force) > 10000)) ostrzezenia.push('Sila przekracza 10 kN — to nie wyglada na ten typ badania, sprawdz jednostki.');
  if (dane.every(p => Math.abs(p.stressRaw) < 1e-9)) ostrzezenia.push('Kolumna naprezenia jest wszedzie zerowa — maszyna nie zapisala naprezen.');
  if (dane.length < 1000) ostrzezenia.push(`Bardzo krotki pomiar (${dane.length} punktow) — wyniki moga byc niemiarodajne.`);

  return { bledy, ostrzezenia, zakresy, dane };
}

// ---------- narzedzia numeryczne ----------

function trapz(y, x) {
  let s = 0;
  for (let i = 1; i < y.length; i++) s += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
  return s;
}

function srSrednia(y, okno) {
  const pol = Math.floor(okno / 2);
  const wynik = new Array(y.length);
  let suma = 0, a = 0, b = -1;
  for (let i = 0; i < y.length; i++) {
    const na = Math.max(0, i - pol), nb = Math.min(y.length - 1, i + pol);
    while (b < nb) suma += y[++b];
    while (a < na) suma -= y[a++];
    wynik[i] = suma / (b - a + 1);
  }
  return wynik;
}

function interpolator(xs, ys) {
  const X = [], Y = [];
  for (let i = 0; i < xs.length; i++) {
    if (!X.length || xs[i] > X[X.length - 1]) { X.push(xs[i]); Y.push(ys[i]); }
  }
  return x => {
    const r = interpolujPoziom(
      X.map((strainFrac, i) => ({ strainFrac, stressPlus: Y[i], globalIndex: i + 1 })),
      x
    );
    return r.stress;
  };
}

function roundFinite(x, n = 12) {
  return Number.isFinite(x) ? Number(x.toFixed(n)) : x;
}

// ---------- detekcja cykli i wielkosci per cykl ----------

function wykryjCykle(dane) {
  const segmenty = [];
  let start = null;
  for (let i = 0; i <= dane.length; i++) {
    const kontakt = i < dane.length && dane[i].displacement > PROG_MM;
    if (kontakt && start === null) {
      start = Math.max(0, i - 1);
    } else if (!kontakt && start !== null) {
      const end = i < dane.length ? i : dane.length - 1;
      if (end - start + 1 >= MIN_PUNKTOW) segmenty.push(dane.slice(start, end + 1));
      start = null;
    }
  }
  return segmenty;
}

function interpolujPoziom(punktyLoading, targetStrainFrac) {
  const rosnace = [];
  for (const p of punktyLoading) {
    if (!rosnace.length || p.strainFrac > rosnace[rosnace.length - 1].strainFrac) rosnace.push(p);
  }
  const brak = {
    targetStrainFrac,
    targetStrainPct: targetStrainFrac * 100,
    stress: null,
    leftGlobalIndex: null,
    rightGlobalIndex: null,
    leftStrainFrac: null,
    rightStrainFrac: null,
    leftStressPlus: null,
    rightStressPlus: null,
  };
  if (!rosnace.length || targetStrainFrac < rosnace[0].strainFrac || targetStrainFrac > rosnace[rosnace.length - 1].strainFrac) {
    return brak;
  }

  let lo = 0, hi = rosnace.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (rosnace[m].strainFrac <= targetStrainFrac) lo = m;
    else hi = m;
  }
  const left = rosnace[lo], right = rosnace[hi];
  const u = (targetStrainFrac - left.strainFrac) / (right.strainFrac - left.strainFrac || 1);
  const stress = left.stressPlus + u * (right.stressPlus - left.stressPlus);
  return {
    targetStrainFrac,
    targetStrainPct: targetStrainFrac * 100,
    stress,
    leftGlobalIndex: left.globalIndex,
    rightGlobalIndex: right.globalIndex,
    leftStrainFrac: left.strainFrac,
    rightStrainFrac: right.strainFrac,
    leftStressPlus: left.stressPlus,
    rightStressPlus: right.stressPlus,
  };
}

function wzbogacPunkty(dane, h0) {
  return dane.map(p => ({
    ...p,
    strainFrac: p.displacement / h0,
    strainPct: 100 * p.displacement / h0,
    stressPlus: Math.max(p.stressRaw, 0),
    forcePlus: Math.max(p.force, 0),
    negativeStressZeroed: p.stressRaw < 0,
  }));
}

function etykietaCyklu(rawIndex, hasPreload) {
  if (hasPreload && rawIndex === 0) {
    return { isPreload: true, cycleNumber: null, cycleLabel: 'preload' };
  }
  const cycleNumber = hasPreload ? rawIndex : rawIndex + 1;
  return { isPreload: false, cycleNumber, cycleLabel: `cycle ${cycleNumber}` };
}

function policzCykl(seg, h0, rawIndex = 0, hasPreload = false) {
  const { isPreload, cycleNumber, cycleLabel } = etykietaCyklu(rawIndex, hasPreload);
  const maxDisp = Math.max(...seg.map(p => p.displacement));
  const iMax = seg.findIndex(p => p.displacement === maxDisp);
  const punkty = seg.map((p, i) => ({
    ...p,
    cycleRawIndex: rawIndex + 1,
    cycleNumber,
    cycleLabel,
    isPreload,
    pointIndexInCycle: i + 1,
    phase: i <= iMax ? 'loading' : 'unloading',
  }));
  const loadingPoints = punkty.slice(0, iMax + 1);

  let aLoadingKJm3 = 0;
  let aUnloadingKJm3 = 0;
  let aLoadingFdMj = 0;
  let aUnloadingFdMj = 0;
  const traceRows = [];

  for (let i = 0; i < punkty.length; i++) {
    const p = punkty[i];
    const prev = i > 0 ? punkty[i - 1] : null;
    const intervalPhase = prev ? (i <= iMax ? 'loading' : 'unloading') : '';
    const deltaStrain = prev ? Math.abs(p.strainFrac - prev.strainFrac) : 0;
    const stressAvg = prev ? 0.5 * (p.stressPlus + prev.stressPlus) : null;
    const trapezoidAreaKJm3 = prev ? stressAvg * deltaStrain * 1000 : 0;
    const deltaDisplacement = prev ? Math.abs(p.displacement - prev.displacement) : 0;
    const forceAvg = prev ? 0.5 * (p.forcePlus + prev.forcePlus) : null;
    const fdTrapezoidAreaMj = prev ? forceAvg * deltaDisplacement : 0;

    if (intervalPhase === 'loading') {
      aLoadingKJm3 += trapezoidAreaKJm3;
      aLoadingFdMj += fdTrapezoidAreaMj;
    } else if (intervalPhase === 'unloading') {
      aUnloadingKJm3 += trapezoidAreaKJm3;
      aUnloadingFdMj += fdTrapezoidAreaMj;
    }

    traceRows.push({
      rawPoint: p.globalIndex,
      globalIndex: p.globalIndex,
      sourceFile: p.sourceFile,
      sourceRow: p.sourceRow,
      time: p.time,
      cycleRawIndex: p.cycleRawIndex,
      cycleNumber: p.cycleNumber,
      cycleLabel: p.cycleLabel,
      isPreload: p.isPreload,
      pointIndexInCycle: p.pointIndexInCycle,
      phase: p.phase,
      intervalPhase,
      displacement: p.displacement,
      forceRaw: p.force,
      forcePlus: p.forcePlus,
      strainFrac: p.strainFrac,
      strainPct: p.strainPct,
      stressRaw: p.stressRaw,
      stressPlus: p.stressPlus,
      negativeStressZeroed: p.negativeStressZeroed,
      prevGlobalIndex: prev?.globalIndex ?? null,
      deltaStrain,
      stressAvg,
      trapezoidAreaKJm3,
      deltaDisplacement,
      forceAvg,
      fdTrapezoidAreaMj,
      cumulativeLoadingKJm3: aLoadingKJm3,
      cumulativeUnloadingKJm3: aUnloadingKJm3,
      cumulativeLoadingFdMj: aLoadingFdMj,
      cumulativeUnloadingFdMj: aUnloadingFdMj,
    });
  }

  const hysteresisKJm3 = aLoadingKJm3 - aUnloadingKJm3;
  const resiliencePct = aLoadingKJm3 > 0 ? 100 * aUnloadingKJm3 / aLoadingKJm3 : null;
  const fdHysteresisMj = aLoadingFdMj - aUnloadingFdMj;
  const forceResiliencePct = aLoadingFdMj > 0 ? 100 * aUnloadingFdMj / aLoadingFdMj : null;
  const interpolations = {};
  for (const poziom of POZIOMY_ODKSZTALCENIA) {
    interpolations[String(Math.round(poziom * 100))] = interpolujPoziom(loadingPoints, poziom);
  }
  const sigma90 = interpolations['90'].stress;
  const eSec90 = sigma90 !== null ? sigma90 / 0.90 : null;
  const first = punkty[0], last = punkty[punkty.length - 1];
  const qcComplete = loadingPoints.length > 1 &&
    punkty.length - loadingPoints.length > 1 &&
    first.displacement <= PROG_MM &&
    last.displacement <= PROG_MM;
  const sources = [...new Set(punkty.map(p => p.sourceFile))];

  const wynik = {
    cycleRawIndex: rawIndex + 1,
    cycleNumber,
    cycleLabel,
    isPreload,
    points: punkty,
    traceRows,
    tStart: first.time,
    tKoniec: last.time,
    sourceFiles: sources,
    loadingPointCount: loadingPoints.length,
    unloadingPointCount: punkty.length - loadingPoints.length,
    negativeStressZeroedCount: punkty.filter(p => p.negativeStressZeroed).length,
    complete: qcComplete,
    maxStrainFrac: Math.max(...punkty.map(p => p.strainFrac)),
    maxStrainPct: Math.max(...punkty.map(p => p.strainPct)),
    sigmaMax: Math.max(...punkty.map(p => p.stressPlus)),
    stressRawMin: Math.min(...punkty.map(p => p.stressRaw)),
    fMax: Math.max(...punkty.map(p => p.force)),
    forcePlusMax: Math.max(...punkty.map(p => p.forcePlus)),
    aLoadingKJm3,
    aUnloadingKJm3,
    hysteresisKJm3,
    resiliencePct,
    aLoadingFdMj,
    aUnloadingFdMj,
    fdHysteresisMj,
    forceResiliencePct,
    elasticRecoveryValuePct: forceResiliencePct,
    interpolations,
    sigmaPoziomy: POZIOMY_ODKSZTALCENIA.map(p => interpolations[String(Math.round(p * 100))].stress),
    sigma10: interpolations['10'].stress,
    sigma30: interpolations['30'].stress,
    sigma50: interpolations['50'].stress,
    sigma70: interpolations['70'].stress,
    sigma90,
    eSec90,
    stressRetentionPct: null,
    stressSofteningPct: null,
    // Alias dla starszych wykresow/testow lokalnych.
    poleKJm3: hysteresisKJm3,
  };

  for (const row of wynik.traceRows) {
    row.finalLoadingAreaKJm3 = aLoadingKJm3;
    row.finalUnloadingAreaKJm3 = aUnloadingKJm3;
    row.finalHysteresisKJm3 = hysteresisKJm3;
    row.finalResiliencePct = resiliencePct;
    row.finalLoadingFdMj = aLoadingFdMj;
    row.finalUnloadingFdMj = aUnloadingFdMj;
    row.finalFdHysteresisMj = fdHysteresisMj;
    row.finalElasticRecoveryPct = forceResiliencePct;
  }

  return wynik;
}

// dopasowanie W_n = Winf + A*exp(-(n-1)/tau) — grid po tau + liniowe LSQ
function dopasujStabilizacje(W) {
  if (W.length < 3) return null;
  const n = W.length;
  let najlepsze = null;
  for (let k = 0; k <= 300; k++) {
    const tau = Math.exp(Math.log(0.2) + (Math.log(50) - Math.log(0.2)) * k / 300);
    const f = Array.from({ length: n }, (_, i) => Math.exp(-i / tau));
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

// ---------- eksport CSV ----------

function csvValue(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  const tekst = typeof v === 'number' ? String(roundFinite(v)).replace('.', ',') : String(v);
  return /[;"\n\r]/.test(tekst) ? `"${tekst.replace(/"/g, '""')}"` : tekst;
}

function zrobCsv(naglowki, wiersze) {
  return [naglowki.join(';')]
    .concat(wiersze.map(w => naglowki.map(h => csvValue(w[h])).join(';')))
    .join('\n');
}

function zrobSummaryCsv({ h0, liczbaPunktow, wyniki, hasPreload }) {
  const interpHeaders = POZIOMY_ODKSZTALCENIA.flatMap(poziom => {
    const pct = Math.round(poziom * 100);
    return [
      `sigma${pct}_left_global_index`,
      `sigma${pct}_right_global_index`,
      `sigma${pct}_left_strain_frac`,
      `sigma${pct}_right_strain_frac`,
      `sigma${pct}_left_stress_plus_mpa`,
      `sigma${pct}_right_stress_plus_mpa`,
    ];
  });
  const naglowki = [
    'cycle_label', 'cycle_number', 'is_preload', 'h0_mm', 'total_points',
    'source_files', 't_start_s', 't_end_s', 'complete',
    'loading_points', 'unloading_points', 'negative_stress_zeroed_points',
    'max_strain_frac', 'max_strain_pct', 'max_stress_plus_mpa', 'max_force_n',
    'Aloading_kJ_m3', 'Aunloading_kJ_m3', 'hysteresis_kJ_m3', 'resilience_pct',
    'Aloading_Fd_mJ', 'Aunloading_Fd_mJ', 'hysteresis_Fd_mJ',
    'force_resilience_pct', 'elastic_recovery_value_pct',
    'stress_retention_pct', 'stress_softening_pct', 'Esec90_MPa',
    'sigma10_MPa', 'sigma30_MPa', 'sigma50_MPa', 'sigma70_MPa', 'sigma90_MPa',
    ...interpHeaders,
    'preload_policy',
  ];
  const preloadPolicy = hasPreload
    ? 'first detected cycle kept for QC and excluded from publication/reference metrics'
    : 'no separate preload detected';
  const wiersze = wyniki.map(w => {
    const row = {
      cycle_label: w.cycleLabel,
      cycle_number: w.cycleNumber,
      is_preload: w.isPreload,
      h0_mm: h0,
      total_points: liczbaPunktow,
      source_files: w.sourceFiles.join(', '),
      t_start_s: w.tStart,
      t_end_s: w.tKoniec,
      complete: w.complete,
      loading_points: w.loadingPointCount,
      unloading_points: w.unloadingPointCount,
      negative_stress_zeroed_points: w.negativeStressZeroedCount,
      max_strain_frac: w.maxStrainFrac,
      max_strain_pct: w.maxStrainPct,
      max_stress_plus_mpa: w.sigmaMax,
      max_force_n: w.fMax,
      Aloading_kJ_m3: w.aLoadingKJm3,
      Aunloading_kJ_m3: w.aUnloadingKJm3,
      hysteresis_kJ_m3: w.hysteresisKJm3,
      resilience_pct: w.resiliencePct,
      Aloading_Fd_mJ: w.aLoadingFdMj,
      Aunloading_Fd_mJ: w.aUnloadingFdMj,
      hysteresis_Fd_mJ: w.fdHysteresisMj,
      force_resilience_pct: w.forceResiliencePct,
      elastic_recovery_value_pct: w.elasticRecoveryValuePct,
      stress_retention_pct: w.stressRetentionPct,
      stress_softening_pct: w.stressSofteningPct,
      Esec90_MPa: w.eSec90,
      sigma10_MPa: w.sigma10,
      sigma30_MPa: w.sigma30,
      sigma50_MPa: w.sigma50,
      sigma70_MPa: w.sigma70,
      sigma90_MPa: w.sigma90,
      preload_policy: preloadPolicy,
    };
    for (const poziom of POZIOMY_ODKSZTALCENIA) {
      const pct = Math.round(poziom * 100);
      const interp = w.interpolations[String(pct)];
      row[`sigma${pct}_left_global_index`] = interp.leftGlobalIndex;
      row[`sigma${pct}_right_global_index`] = interp.rightGlobalIndex;
      row[`sigma${pct}_left_strain_frac`] = interp.leftStrainFrac;
      row[`sigma${pct}_right_strain_frac`] = interp.rightStrainFrac;
      row[`sigma${pct}_left_stress_plus_mpa`] = interp.leftStressPlus;
      row[`sigma${pct}_right_stress_plus_mpa`] = interp.rightStressPlus;
    }
    return row;
  });
  return zrobCsv(naglowki, wiersze);
}

function zrobTraceCsv({ trace }) {
  const naglowki = [
    'raw_point', 'global_index', 'source_file', 'source_row',
    'time_s', 'cycle_label', 'cycle_number', 'is_preload', 'point_in_cycle',
    'phase', 'interval_phase', 'displacement_mm', 'force_raw_n', 'force_plus_n',
    'strain_frac', 'strain_pct', 'stress_raw_mpa', 'stress_plus_mpa',
    'negative_stress_zeroed', 'previous_global_index', 'delta_strain_abs',
    'stress_avg_mpa', 'trapezoid_area_kJ_m3', 'delta_displacement_abs_mm',
    'force_avg_n', 'fd_trapezoid_area_mJ', 'cumulative_loading_kJ_m3',
    'cumulative_unloading_kJ_m3', 'cumulative_loading_Fd_mJ',
    'cumulative_unloading_Fd_mJ', 'final_loading_area_kJ_m3',
    'final_unloading_area_kJ_m3', 'final_hysteresis_kJ_m3',
    'final_resilience_pct', 'final_loading_Fd_mJ', 'final_unloading_Fd_mJ',
    'final_Fd_hysteresis_mJ', 'final_elastic_recovery_pct',
    'final_stress_retention_pct', 'final_stress_softening_pct',
    'final_Esec90_MPa', 'final_sigma90_MPa',
  ];
  const wiersze = trace.map(r => ({
    raw_point: r.rawPoint,
    global_index: r.globalIndex,
    source_file: r.sourceFile,
    source_row: r.sourceRow,
    time_s: r.time,
    cycle_label: r.cycleLabel,
    cycle_number: r.cycleNumber,
    is_preload: r.isPreload,
    point_in_cycle: r.pointIndexInCycle,
    phase: r.phase,
    interval_phase: r.intervalPhase,
    displacement_mm: r.displacement,
    force_raw_n: r.forceRaw,
    force_plus_n: r.forcePlus,
    strain_frac: r.strainFrac,
    strain_pct: r.strainPct,
    stress_raw_mpa: r.stressRaw,
    stress_plus_mpa: r.stressPlus,
    negative_stress_zeroed: r.negativeStressZeroed,
    previous_global_index: r.prevGlobalIndex,
    delta_strain_abs: r.deltaStrain,
    stress_avg_mpa: r.stressAvg,
    trapezoid_area_kJ_m3: r.trapezoidAreaKJm3,
    delta_displacement_abs_mm: r.deltaDisplacement,
    force_avg_n: r.forceAvg,
    fd_trapezoid_area_mJ: r.fdTrapezoidAreaMj,
    cumulative_loading_kJ_m3: r.cumulativeLoadingKJm3,
    cumulative_unloading_kJ_m3: r.cumulativeUnloadingKJm3,
    cumulative_loading_Fd_mJ: r.cumulativeLoadingFdMj,
    cumulative_unloading_Fd_mJ: r.cumulativeUnloadingFdMj,
    final_loading_area_kJ_m3: r.finalLoadingAreaKJm3,
    final_unloading_area_kJ_m3: r.finalUnloadingAreaKJm3,
    final_hysteresis_kJ_m3: r.finalHysteresisKJm3,
    final_resilience_pct: r.finalResiliencePct,
    final_loading_Fd_mJ: r.finalLoadingFdMj,
    final_unloading_Fd_mJ: r.finalUnloadingFdMj,
    final_Fd_hysteresis_mJ: r.finalFdHysteresisMj,
    final_elastic_recovery_pct: r.finalElasticRecoveryPct,
    final_stress_retention_pct: r.finalStressRetentionPct,
    final_stress_softening_pct: r.finalStressSofteningPct,
    final_Esec90_MPa: r.finalESec90,
    final_sigma90_MPa: r.finalSigma90,
  }));
  return zrobCsv(naglowki, wiersze);
}

// ---------- analiza calosci ----------

function analizuj(listyWierszy, h0Wejsciowe, nazwy) {
  const { bledy, ostrzezenia, zakresy, dane } = waliduj(listyWierszy, nazwy);
  if (bledy.length) throw new Error(bledy.join('\n'));

  const h0 = h0Wejsciowe || dane[0].spacing;
  if (!(h0 > 0)) throw new Error(`Nieprawidlowe h0 (rozstaw w danych: ${dane[0].spacing} mm).`);

  const punkty = wzbogacPunkty(dane, h0);
  const segmenty = wykryjCykle(punkty);
  if (!segmenty.length) throw new Error(`Nie wykryto zadnych cykli sciskania (przemieszczenie nigdy nie przekracza ${PROG_MM} mm).`);

  const hasPreload = segmenty.length >= 2;
  const wyniki = segmenty.map((seg, i) => policzCykl(seg, h0, i, hasPreload));
  const cycle1 = wyniki.find(w => !w.isPreload);
  const sigmaRef = cycle1?.sigmaMax || null;
  wyniki.forEach(w => {
    if (!w.isPreload && sigmaRef > 0) {
      w.stressRetentionPct = 100 * w.sigmaMax / sigmaRef;
      w.stressSofteningPct = 100 - w.stressRetentionPct;
      if (Math.abs(w.stressSofteningPct) < 1e-10) w.stressSofteningPct = 0;
      if (Math.abs(w.stressRetentionPct - 100) < 1e-10) w.stressRetentionPct = 100;
    }
    for (const row of w.traceRows) {
      row.finalStressRetentionPct = w.stressRetentionPct;
      row.finalStressSofteningPct = w.stressSofteningPct;
      row.finalESec90 = w.eSec90;
      row.finalSigma90 = w.sigma90;
    }
  });
  const trace = wyniki.flatMap(w => w.traceRows);

  return {
    h0,
    liczbaPunktow: punkty.length,
    punkty,
    cykle: wyniki.map(w => w.points),
    wyniki,
    trace,
    ostrzezenia,
    zakresy,
    hasPreload,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    parsujCsv,
    waliduj,
    wykryjCykle,
    trapz,
    srSrednia,
    interpolator,
    interpolujPoziom,
    policzCykl,
    dopasujStabilizacje,
    analizuj,
    zrobSummaryCsv,
    zrobTraceCsv,
    POZIOMY_ODKSZTALCENIA,
  };
}

// ---------- UI ----------

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

  function escapeHtml(tekst) {
    return String(tekst).replace(/[&<>"']/g, z => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]));
  }

  function ustawPliki(pliki) {
    wybranePliki = pliki.filter(p => /\.(csv|txt)$/i.test(p.name) || p.type.includes('csv') || p.type === 'text/plain');
    lista.innerHTML = wybranePliki.map((p, i) => `<li id="plik-${i}">${escapeHtml(p.name)} (${(p.size / 1e6).toFixed(1)} MB)</li>`).join('');
    przycisk.disabled = wybranePliki.length === 0;
    blad.textContent = wybranePliki.length === pliki.length ? '' : 'Pominieto pliki niebedace CSV/TXT.';
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
    przycisk.textContent = 'Liczenie...';
    try {
      const listy = await Promise.all(wybranePliki.map(odczytajPlik));
      const h0Pole = parseFloat(document.getElementById('h0').value.replace(',', '.'));
      const rezultat = analizuj(listy, Number.isFinite(h0Pole) ? h0Pole : null, wybranePliki.map(p => p.name));
      rezultat.zakresy.forEach((z, i) => {
        const li = document.getElementById(`plik-${i}`);
        if (li) li.textContent = `${z.nazwa} — t = ${z.od.toFixed(1)}-${z.do.toFixed(1)} s, ${z.n.toLocaleString('pl-PL')} punktow`;
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

  function ustawPobieranie(id, nazwa, tekst) {
    const a = document.getElementById(id);
    a.download = nazwa;
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + tekst], { type: 'text/csv;charset=utf-8' }));
  }

  function pokazWyniki(rezultat) {
    const { h0, liczbaPunktow, cykle, wyniki, ostrzezenia, hasPreload } = rezultat;
    const publikacyjne = wyniki.filter(w => !w.isPreload).slice(0, LICZBA_CYKLI_PUBLIKACYJNYCH);
    const kolory = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#17becf', '#7f7f7f'];

    if (ostrzezenia.length) {
      panelOstrzezen.innerHTML = '<strong>Ostrzezenia:</strong><ul>' + ostrzezenia.map(o => `<li>${escapeHtml(o)}</li>`).join('') + '</ul>';
      panelOstrzezen.style.display = 'block';
    }

    const kolEnergia = ['', 'rola', 'sigma max [MPa]', 'strain max [%]', 'Aloading [kJ/m3]', 'Aunloading [kJ/m3]',
      'hysteresis H [kJ/m3]', 'resilience [%]', 'Aloading F-d [mJ]', 'Aunloading F-d [mJ]',
      'HFd [mJ]', 'elastic recovery [%]', 'max force [N]'];
    let html = '<tr>' + kolEnergia.map(h => `<th>${h}</th>`).join('') + '</tr>';
    wyniki.forEach(w => {
      const klasa = w.isPreload ? ' class="preload"' : '';
      html += `<tr${klasa}><td>${w.cycleLabel}</td><td>${w.isPreload ? 'preconditioning/QC' : 'publication'}</td>` +
        `<td>${fmt(w.sigmaMax)}</td><td>${fmt(w.maxStrainPct, 2)}</td>` +
        `<td>${fmt(w.aLoadingKJm3, 2)}</td><td>${fmt(w.aUnloadingKJm3, 2)}</td><td>${fmt(w.hysteresisKJm3, 2)}</td>` +
        `<td>${fmt(w.resiliencePct, 1)}</td><td>${fmt(w.aLoadingFdMj, 2)}</td><td>${fmt(w.aUnloadingFdMj, 2)}</td>` +
        `<td>${fmt(w.fdHysteresisMj, 2)}</td><td>${fmt(w.elasticRecoveryValuePct, 1)}</td><td>${fmt(w.fMax, 2)}</td></tr>`;
    });
    document.getElementById('tabela').innerHTML = html;

    const kolMech = ['', 'Esec90 [MPa]', 'sigma10 [MPa]', 'sigma30 [MPa]', 'sigma50 [MPa]',
      'sigma70 [MPa]', 'sigma90 [MPa]', 'stress retention [%]', 'stress softening [%]'];
    let html2 = '<tr>' + kolMech.map(h => `<th>${h}</th>`).join('') + '</tr>';
    wyniki.forEach(w => {
      const klasa = w.isPreload ? ' class="preload"' : '';
      html2 += `<tr${klasa}><td>${w.cycleLabel}</td><td>${fmt(w.eSec90)}</td>` +
        `<td>${fmt(w.sigma10)}</td><td>${fmt(w.sigma30)}</td><td>${fmt(w.sigma50)}</td>` +
        `<td>${fmt(w.sigma70)}</td><td>${fmt(w.sigma90)}</td>` +
        `<td>${fmt(w.stressRetentionPct, 1)}</td><td>${fmt(w.stressSofteningPct, 1)}</td></tr>`;
    });
    document.getElementById('tabela-mech').innerHTML = html2;

    const kolQc = ['', 'complete', 'loading pts', 'unloading pts', 'zeroed negative stress',
      'raw stress min [MPa]', 'source files'];
    let htmlQc = '<tr>' + kolQc.map(h => `<th>${h}</th>`).join('') + '</tr>';
    wyniki.forEach(w => {
      const klasa = w.isPreload ? ' class="preload"' : '';
      htmlQc += `<tr${klasa}><td>${w.cycleLabel}</td><td>${w.complete ? 'tak' : 'nie'}</td>` +
        `<td>${w.loadingPointCount}</td><td>${w.unloadingPointCount}</td><td>${w.negativeStressZeroedCount}</td>` +
        `<td>${fmt(w.stressRawMin)}</td><td>${escapeHtml(w.sourceFiles.join(', '))}</td></tr>`;
    });
    document.getElementById('tabela-qc').innerHTML = htmlQc;

    const wlasciwe = wyniki.filter(w => !w.isPreload);
    const fit = dopasujStabilizacje(wlasciwe.map(w => w.hysteresisKJm3));
    const elFit = document.getElementById('stabilizacja');
    if (fit) {
      elFit.textContent = `Stabilizacja histerezy (bez preloadu): Winf = ${fmt(fit.winf, 1)} kJ/m3, ` +
        `tau = ${fmt(fit.tau, 1)} cykli (R2 = ${fmt(fit.r2, 3)}).`;
    } else {
      elFit.textContent = 'Stabilizacja histerezy: za malo cykli wlasciwych do dopasowania (potrzebne >= 3).';
    }

    document.getElementById('podsumowanie').textContent =
      `Punktow pomiarowych: ${liczbaPunktow.toLocaleString('pl-PL')} · h0 = ${fmt(h0)} mm · ` +
      `wykryto cykli: ${cykle.length}` + (hasPreload ? ' · pierwszy cykl traktowany jako preload/QC' : '');

    ustawPobieranie('pobierz-summary', 'wyniki_summary.csv', zrobSummaryCsv(rezultat));
    ustawPobieranie('pobierz-trace', 'trace_punkt_po_punkcie.csv', zrobTraceCsv(rezultat));

    rysujStressStrain(publikacyjne, kolory);
    rysujForceDisplacement(publikacyjne, kolory);
    rysujTrendy(wlasciwe, kolory);

    document.getElementById('wyniki').style.display = 'block';
    document.getElementById('wyniki').scrollIntoView({ behavior: 'smooth' });
  }

  function rysujStressStrain(wyniki, kolory) {
    const slady = wyniki.map((w, i) => {
      const s = decymuj(w.points);
      return {
        x: s.map(p => p.strainPct),
        y: s.map(p => p.stressPlus),
        name: w.cycleLabel,
        mode: 'lines',
        line: { color: kolory[i % kolory.length], width: 1.5 },
      };
    });
    Plotly.newPlot('wykres-zbiorczy', slady, {
      title: 'Stress-strain loops (cycles 1-5, no preload)',
      xaxis: { title: { text: 'Strain [%]', standoff: 8 }, rangemode: 'tozero' },
      yaxis: { title: 'Stress+ [MPa]' },
      legend: { orientation: 'h', yanchor: 'top', y: -0.22 },
      margin: { t: 55, b: 95 },
    }, { responsive: true, displaylogo: false });
  }

  function rysujForceDisplacement(wyniki, kolory) {
    const slady = wyniki.map((w, i) => {
      const s = decymuj(w.points);
      return {
        x: s.map(p => p.displacement),
        y: s.map(p => p.forcePlus),
        name: w.cycleLabel,
        mode: 'lines',
        line: { color: kolory[i % kolory.length], width: 1.5 },
      };
    });
    Plotly.newPlot('wykres-force', slady, {
      title: 'Force-displacement loops (cycles 1-5, no preload)',
      xaxis: { title: { text: 'Displacement [mm]', standoff: 8 }, rangemode: 'tozero' },
      yaxis: { title: 'Force+ [N]' },
      legend: { orientation: 'h', yanchor: 'top', y: -0.22 },
      margin: { t: 55, b: 95 },
    }, { responsive: true, displaylogo: false });
  }

  function rysujTrendy(wyniki, kolory) {
    const xs = wyniki.map(w => w.cycleNumber);
    const metryki = [
      ['Hysteresis [kJ/m3]', wyniki.map(w => w.hysteresisKJm3)],
      ['Resilience [%]', wyniki.map(w => w.resiliencePct)],
      ['Stress retention [%]', wyniki.map(w => w.stressRetentionPct)],
      ['Stress softening [%]', wyniki.map(w => w.stressSofteningPct)],
      ['Esec90 [MPa]', wyniki.map(w => w.eSec90)],
      ['F-d hysteresis [mJ]', wyniki.map(w => w.fdHysteresisMj)],
      ['Elastic recovery [%]', wyniki.map(w => w.elasticRecoveryValuePct)],
      ['Max force [N]', wyniki.map(w => w.fMax)],
    ];
    const slady = metryki.map((m, i) => ({
      x: xs,
      y: m[1],
      name: m[0],
      mode: 'lines+markers',
      marker: { size: 7, color: kolory[i % kolory.length] },
      line: { color: kolory[i % kolory.length], width: 1.4 },
      xaxis: 'x' + (i > 0 ? i + 1 : ''),
      yaxis: 'y' + (i > 0 ? i + 1 : ''),
    }));
    const osie = {};
    for (let i = 0; i < metryki.length; i++) {
      osie['xaxis' + (i > 0 ? i + 1 : '')] = { tickvals: xs, title: i >= 4 ? 'Cycle' : '' };
    }
    Plotly.newPlot('wykres-trendy', slady, {
      grid: { rows: 3, columns: 3, pattern: 'independent', ygap: 0.25 },
      title: 'Publication metrics (preload excluded)',
      height: 760,
      margin: { t: 70, b: 75 },
      showlegend: false,
      ...osie,
      annotations: metryki.map((m, i) => ({
        text: m[0],
        xref: 'x' + (i > 0 ? i + 1 : '') + ' domain',
        yref: 'y' + (i > 0 ? i + 1 : '') + ' domain',
        x: 0.5,
        y: 1.14,
        showarrow: false,
        font: { size: 12 },
      })),
    }, { responsive: true, displaylogo: false });
  }
}
