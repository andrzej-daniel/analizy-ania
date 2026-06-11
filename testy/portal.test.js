/* Testy regresyjne logiki portalu (node testy/portal.test.js).
   Porównanie z wynikami notebooka + przypadki walidacji wejścia. */

const fs = require('fs');
const path = require('path');
const { parsujCsv, waliduj, analizuj, dopasujStabilizacje } = require('../portal/app.js');

const KATALOG = path.join(__dirname, '..');
let zaliczone = 0, oblane = 0;

function ok(warunek, opis) {
  if (warunek) { zaliczone++; console.log('  ✓', opis); }
  else { oblane++; console.error('  ✗', opis); }
}
function blisko(a, b, tolProc, opis) {
  ok(Math.abs(a - b) <= Math.abs(b) * tolProc / 100, `${opis} (jest ${a.toFixed(3)}, oczekiwane ${b} ±${tolProc}%)`);
}

function wczytaj(nazwa) {
  // dane są w cp1250 — nagłówki mają krzaki, ale wiersze danych to czyste ASCII
  return parsujCsv(fs.readFileSync(path.join(KATALOG, nazwa), 'latin1'));
}

const NAZWY = ['820 dz-1.csv', '820 dz-2.csv', '820 dz-3.csv'];
const LISTY = NAZWY.map(wczytaj);

console.log('— zgodność z notebookiem (3 pliki) —');
{
  const r = analizuj(LISTY, null, NAZWY);
  ok(r.cykle.length === 6, 'wykryto 6 ściśnięć');
  ok(Math.abs(r.h0 - 3.3135) < 0.001, `h0 = ${r.h0}`);
  // histereza surowa (z adhezją) — wartości z notebooka [kJ/m³]
  const surowe = [165.69, 79.90, 67.49, 52.88, 50.52, 47.17];
  surowe.forEach((w, i) => blisko(r.wyniki[i].wPetlaSurowe * 1000, w, 0.5, `histereza surowa cyklu ${i + 1}`));
  ok(r.ostrzezenia.length === 0, 'brak ostrzeżeń dla kompletu danych');
}

console.log('— sanity nowych wielkości —');
{
  const r = analizuj(LISTY, null, NAZWY);
  const w = r.wyniki;
  ok(w.every(x => x.polePetli > 0), 'histereza σ⁺ dodatnia we wszystkich cyklach');
  ok(w.every(x => x.pracaAdhezji >= 0), 'praca adhezji nieujemna');
  ok(w[0].pracaAdhezjiKJm3 > 5, `praca adhezji w preloadzie istotna (${w[0].pracaAdhezjiKJm3.toFixed(1)} kJ/m³)`);
  ok(w.every(x => x.dyssypacjaPct > 0 && x.dyssypacjaPct < 100), 'dyssypacja (σ⁺) w przedziale (0,100)%');
  ok(w.every(x => x.resiliencePct > 0 && x.resiliencePct < 100), 'resilience w przedziale (0,100)%');
  ok(w.every(x => x.e1030 > 0 && x.e6085 > 0), 'moduły sieczne dodatnie');
  ok(w[0].e1030 > 5 * w[1].e1030, 'preload wyraźnie sztywniejszy niż cykl 1 (Mullins)');
  ok(w.every(x => x.e6085 > x.e1030), 'usztywnienie przy dużych ε (E60-85 > E10-30)');
  const ps = w.map(x => x.permanentSetPp);
  ok(ps[0] === 0, 'permanent set preloadu = 0 (baza)');
  ok(ps[5] > ps[1], 'permanent set rośnie z cyklami');
  // bilans energii: surowa = σ⁺ + adhezja
  w.forEach((x, i) => blisko(x.polePetli + x.pracaAdhezji, x.wPetlaSurowe, 0.01, `bilans energii cyklu ${i + 1}`));
  const fit = dopasujStabilizacje(w.slice(1).map(x => x.poleKJm3));
  ok(fit !== null && fit.winf > 0 && fit.winf < w[1].poleKJm3, `dopasowanie stabilizacji: W∞ = ${fit.winf.toFixed(1)} kJ/m³`);
  ok(fit.r2 > 0.9, `R² dopasowania > 0.9 (jest ${fit.r2.toFixed(3)})`);
}

console.log('— walidacja: 1 plik —');
{
  const r = analizuj([LISTY[0]], null, [NAZWY[0]]);
  ok(r.cykle.length === 3, `sam dz-1 → ${r.cykle.length} cykle (t do 900 s)`);
}

console.log('— walidacja: duplikat pliku —');
{
  const r = analizuj([LISTY[0], LISTY[0], LISTY[1], LISTY[2]], null, ['a.csv', 'a.csv', 'b.csv', 'c.csv']);
  ok(r.ostrzezenia.some(o => o.includes('zduplikowanych')), 'ostrzeżenie o duplikatach');
  ok(r.liczbaPunktow === 199117, `po deduplikacji ${r.liczbaPunktow} punktów (jak dla 3 plików)`);
  blisko(r.wyniki[0].wPetlaSurowe * 1000, 165.69, 0.5, 'wynik cyklu 1 niezmieniony mimo duplikatu');
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
  ok(komunikat.includes('h₀'), 'błąd dla h0 ≤ 0');
}

console.log('— parser: format bez cudzysłowów, separator ; —');
{
  const w = parsujCsv('Czas;Sila;P;N;R\nsec;N;mm;MPa;mm\n0,5;1,25;0,1;0,01;3,0\n1,0;2,5;0,2;0,02;2,9\n');
  ok(w.length === 2 && w[0][1] === 1.25 && w[1][4] === 2.9, 'poprawnie sparsowany wariant ze średnikami');
}

console.log(`\nWynik: ${zaliczone} zaliczonych, ${oblane} oblanych`);
process.exit(oblane ? 1 : 0);
