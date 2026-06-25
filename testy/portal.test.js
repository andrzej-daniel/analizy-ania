/* Testy regresyjne logiki portalu (node testy/portal.test.js).
   Sprawdzaja metodologie punkt-po-punkcie, preload/QC, trace i eksport CSV. */

const fs = require('fs');
const path = require('path');
const {
  parsujCsv,
  analizuj,
  zrobSummaryCsv,
  zrobTraceCsv,
} = require('../portal/app.js');

const KATALOG = path.join(__dirname, '..');
let zaliczone = 0, oblane = 0;

function ok(warunek, opis) {
  if (warunek) { zaliczone++; console.log('  ✓', opis); }
  else { oblane++; console.error('  ✗', opis); }
}

function blisko(a, b, tolProc, opis) {
  const skala = Math.max(Math.abs(b), 1e-12);
  ok(Math.abs(a - b) <= skala * tolProc / 100, `${opis} (jest ${a.toFixed(6)}, oczekiwane ${b.toFixed(6)} ±${tolProc}%)`);
}

function bliskoAbs(a, b, tol, opis) {
  ok(Math.abs(a - b) <= tol, `${opis} (jest ${a}, oczekiwane ${b} ±${tol})`);
}

function wczytaj(nazwa) {
  return parsujCsv(fs.readFileSync(path.join(KATALOG, nazwa), 'latin1'));
}

const NAZWY = ['820 dz-1.csv', '820 dz-2.csv', '820 dz-3.csv'];
const LISTY = NAZWY.map(wczytaj);

console.log('— scalanie i segmentacja —');
{
  const r = analizuj(LISTY, null, NAZWY);
  ok(r.liczbaPunktow === 199117, `globalnie ${r.liczbaPunktow} punktów po scaleniu`);
  ok(r.punkty[0].globalIndex === 1 && r.punkty.at(-1).globalIndex === r.liczbaPunktow, 'utworzono globalny indeks punktów');
  ok(r.punkty.every(p => p.sourceFile && p.sourceRow > 0), 'każdy punkt zachowuje plik źródłowy i wiersz źródłowy');
  ok(r.punkty[0].sourceRow === 4, `sourceRow wskazuje rzeczywistą linię CSV po nagłówkach (${r.punkty[0].sourceRow})`);
  ok(r.wyniki.length === 6, 'wykryto 6 cykli');
  ok(r.hasPreload === true, 'pierwszy cykl jest automatycznie traktowany jako preload');
  ok(r.wyniki[0].cycleLabel === 'preload' && r.wyniki[0].isPreload, 'preload pozostaje w wynikach/QC');
  ok(r.wyniki[1].cycleLabel === 'cycle 1' && r.wyniki[1].cycleNumber === 1, 'cycle 1 to pierwszy cykl po preloadzie');
  ok(r.trace.length === r.wyniki.reduce((s, w) => s + w.points.length, 0), 'trace zawiera każdy punkt z wykrytych cykli');
}

console.log('— metodologia stress-strain i preload —');
{
  const r = analizuj(LISTY, null, NAZWY);
  const preload = r.wyniki[0];
  const c1 = r.wyniki[1];
  ok(preload.stressRetentionPct === null && preload.stressSofteningPct === null, 'preload nie ma retention/softening');
  blisko(c1.stressRetentionPct, 100, 1e-9, 'retention cycle 1 = 100%');
  bliskoAbs(c1.stressSofteningPct, 0, 1e-9, 'softening cycle 1 = 0%');
  ok(r.wyniki.slice(2).every(w => w.stressRetentionPct < 100 && w.stressSofteningPct > 0), 'kolejne cykle miękną względem cycle 1');

  const oczekiwaneH = [142.06, 75.87, 65.10, 51.48, 49.18, 45.67];
  r.wyniki.forEach((w, i) => blisko(w.hysteresisKJm3, oczekiwaneH[i], 0.8, `hysteresis ${w.cycleLabel}`));
  r.wyniki.forEach(w => {
    bliskoAbs(w.hysteresisKJm3, w.aLoadingKJm3 - w.aUnloadingKJm3, 1e-9, `H = Aloading - Aunloading (${w.cycleLabel})`);
    bliskoAbs(w.resiliencePct, 100 * w.aUnloadingKJm3 / w.aLoadingKJm3, 1e-9, `R = Aunloading/Aloading (${w.cycleLabel})`);
  });
}

console.log('— sigma+ i trace punkt-po-punkcie —');
{
  const r = analizuj(LISTY, null, NAZWY);
  const zeroed = r.trace.filter(row => row.negativeStressZeroed);
  ok(zeroed.length === r.wyniki.reduce((s, w) => s + w.negativeStressZeroedCount, 0), 'QC liczy wyzerowane ujemne naprężenia');
  ok(zeroed.every(row => row.stressRaw < 0 && row.stressPlus === 0), 'σ+ = max(σ, 0) dla ujemnych naprężeń');

  const trapez = r.trace.find(row => row.intervalPhase === 'loading' && row.deltaStrain > 0 && row.stressAvg > 0);
  ok(Boolean(trapez), 'znaleziono niezerowy trapez w trace');
  bliskoAbs(trapez.trapezoidAreaKJm3, trapez.stressAvg * trapez.deltaStrain * 1000, 1e-12, 'Ai stress-strain zapisane w trace');
  bliskoAbs(trapez.fdTrapezoidAreaMj, trapez.forceAvg * trapez.deltaDisplacement, 1e-12, 'Ai force-displacement zapisane w trace');
  ok(trapez.prevGlobalIndex !== null && trapez.rawPoint === trapez.globalIndex, 'trace wskazuje punkt surowy i poprzedni punkt interwału');
}

console.log('— force-displacement i elastic recovery —');
{
  const r = analizuj(LISTY, null, NAZWY);
  ok(r.wyniki[0].aUnloadingFdMj < 0, 'preload zachowuje ujemną pracę unloading z surowej siły F');
  ok(r.wyniki[0].elasticEnergyRecoveryPct < 0, 'elastic energy recovery preloadu może być ujemne przy surowym F');
  const oczekiwaneHFd = [97.02, 46.78, 39.52, 30.96, 29.58, 27.62];
  r.wyniki.forEach(w => {
    blisko(w.fdHysteresisMj, oczekiwaneHFd[w.cycleRawIndex - 1], 0.8, `HFd z surowej siły (${w.cycleLabel})`);
    bliskoAbs(w.fdHysteresisMj, w.aLoadingFdMj - w.aUnloadingFdMj, 1e-9, `HFd = Aloading,Fd - Aunloading,Fd (${w.cycleLabel})`);
    bliskoAbs(w.forceResiliencePct, 100 * w.aUnloadingFdMj / w.aLoadingFdMj, 1e-9, `RFd = Aunloading,Fd/Aloading,Fd (${w.cycleLabel})`);
    bliskoAbs(w.elasticEnergyRecoveryPct, w.forceResiliencePct, 1e-12, `elastic energy recovery = RFd (${w.cycleLabel})`);
    bliskoAbs(w.elasticRecoveryValuePct, w.elasticEnergyRecoveryPct, 1e-12, `stary alias elastic_recovery_value_pct zachowany (${w.cycleLabel})`);
    ok(w.elasticDisplacementRecoveryPct !== null, `wyliczono elastic displacement recovery (${w.cycleLabel})`);
    if (!w.isPreload) {
      ok(w.elasticEnergyRecoveryPct > 0 && w.elasticEnergyRecoveryPct < 100, `elastic energy recovery w zakresie (0,100)% (${w.cycleLabel})`);
      ok(w.elasticDisplacementRecoveryPct > 95 && w.elasticDisplacementRecoveryPct <= 105, `displacement recovery blisko powrotu do zera (${w.cycleLabel})`);
    }
  });
}

console.log('— interpolacja i Esec90 —');
{
  const r = analizuj(LISTY, null, NAZWY);
  const c1 = r.wyniki[1];
  const i90 = c1.interpolations['90'];
  ok(i90.leftGlobalIndex !== null && i90.rightGlobalIndex !== null, 'zachowano indeksy punktów interpolacji σ90');
  ok(i90.leftStrainFrac <= 0.90 && i90.rightStrainFrac >= 0.90, 'punkty interpolacji obejmują ε = 0.90');
  ok(i90.stress >= Math.min(i90.leftStressPlus, i90.rightStressPlus) && i90.stress <= Math.max(i90.leftStressPlus, i90.rightStressPlus), 'σ90 leży między punktami interpolacji');
  bliskoAbs(c1.eSec90, c1.sigma90 / 0.90, 1e-12, 'Esec90 = σ90 / 0.90');
  ok(['10', '30', '50', '70', '90'].every(k => c1.interpolations[k].stress !== null), 'wyznaczono σ10/30/50/70/90');
}

console.log('— eksporty CSV —');
{
  const r = analizuj(LISTY, null, NAZWY);
  const summary = zrobSummaryCsv(r);
  const trace = zrobTraceCsv(r);
  ok(summary.startsWith('cycle_label;cycle_number;is_preload'), 'summary CSV ma nagłówek cykli');
  ok(summary.includes('elastic_energy_recovery_pct') && summary.includes('elastic_recovery_value_pct'), 'summary CSV zawiera nową nazwę recovery i alias zgodności');
  ok(summary.includes('elastic_displacement_recovery_pct') && summary.includes('stress_retention_pct'), 'summary CSV zawiera recovery przemieszczenia i retention');
  ok(summary.includes('cycle_detection_threshold_mm') && summary.includes('qc_warnings'), 'summary CSV zawiera próg segmentacji i ostrzeżenia QC');
  ok(summary.includes('sigma90_left_global_index') && summary.includes('sigma90_right_stress_plus_mpa'), 'summary CSV zachowuje punkty interpolacji');
  ok(trace.startsWith('raw_point;global_index;source_file'), 'trace CSV ma nagłówek punktów surowych');
  ok(trace.includes('force_for_fd_n') && !trace.includes('force_plus_n'), 'trace CSV dokumentuje surową siłę używaną w F-d');
  ok(trace.includes('trapezoid_area_kJ_m3') && trace.includes('final_hysteresis_kJ_m3'), 'trace CSV zawiera trapezy i parametry końcowe');
  ok(trace.includes('final_elastic_energy_recovery_pct') && trace.includes('final_elastic_displacement_recovery_pct'), 'trace CSV zawiera obie metryki recovery');
  ok(trace.includes('final_stress_retention_pct') && trace.includes('final_Esec90_MPa'), 'trace CSV zawiera końcowe metryki mechaniczne');
}

console.log('— walidacja: 1 plik —');
{
  const r = analizuj([LISTY[0]], null, [NAZWY[0]]);
  ok(r.wyniki.length === 3, `sam dz-1 → ${r.wyniki.length} cykle`);
  ok(r.hasPreload === true && r.wyniki[1].cycleLabel === 'cycle 1', 'preload działa także dla jednego pliku z wieloma cyklami');
}

console.log('— walidacja: duplikat pliku —');
{
  const r = analizuj([LISTY[0], LISTY[0], LISTY[1], LISTY[2]], null, ['a.csv', 'a.csv', 'b.csv', 'c.csv']);
  ok(r.ostrzezenia.some(o => o.includes('zduplikowanych')), 'ostrzeżenie o duplikatach');
  ok(r.liczbaPunktow === 199117, `po deduplikacji ${r.liczbaPunktow} punktów`);
  blisko(r.wyniki[1].hysteresisKJm3, 75.87, 0.8, 'wynik cycle 1 niezmieniony mimo duplikatu');
}

console.log('— walidacja: dziura w czasie (pliki 1+3 bez 2) —');
{
  const r = analizuj([LISTY[0], LISTY[2]], null, [NAZWY[0], NAZWY[2]]);
  ok(r.ostrzezenia.some(o => o.includes('dziur')), 'ostrzeżenie o dziurze w osi czasu');
}

console.log('— walidacja: plik śmieciowy —');
{
  const smieci = parsujCsv('to,nie,jest\nzaden,pomiar\n1,2\n');
  let komunikat = '';
  try { analizuj([smieci], null, ['smieci.csv']); } catch (e) { komunikat = e.message; }
  ok(komunikat.includes('smieci.csv'), 'błąd wskazuje nazwę wadliwego pliku');
}

console.log('— walidacja: złe h0 —');
{
  let komunikat = '';
  try { analizuj([LISTY[0]], -5, [NAZWY[0]]); } catch (e) { komunikat = e.message; }
  ok(komunikat.includes('h0'), 'błąd dla h0 ≤ 0');
  komunikat = '';
  try { analizuj([LISTY[0]], 0, [NAZWY[0]]); } catch (e) { komunikat = e.message; }
  ok(komunikat.includes('h0'), 'błąd dla jawnego h0 = 0');
}

console.log('— parser: format bez cudzysłowów, separator ; —');
{
  const w = parsujCsv('Czas;Sila;P;N;R\nsec;N;mm;MPa;mm\n0,5;1,25;0,1;0,01;3,0\n1,0;2,5;0,2;0,02;2,9\n');
  ok(w.length === 2 && w[0][1] === 1.25 && w[1][4] === 2.9, 'poprawnie sparsowany wariant ze średnikami');
}

console.log(`\nWynik: ${zaliczone} zaliczonych, ${oblane} oblanych`);
process.exit(oblane ? 1 : 0);
