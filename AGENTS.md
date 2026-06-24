# Instrukcje dla Codexa

Ten projekt jest portalem do transparentnej analizy cyklicznego sciskania hydrozeli. Z aplikacji beda korzystac glownie osoby nietechniczne, a wyniki moga byc czytane przez recenzentow naukowych. Priorytetem jest jasnosc: obliczenia maja byc policzone z surowych punktow, opisane wzorami i mozliwe do przeaudytowania przez eksporty CSV.

## Najwazniejsze komendy

- Uruchom portal lokalnie: `make portal`
- Testy logiki obliczen: `make test-js`
- Testy E2E w Playwright: `make test-e2e`
- Pelny zestaw testow: `make test`

Portal jest statyczny i serwowany przez `uv run python scripts/serve_portal.py`. Biblioteka Plotly jest ladowana w przegladarce z CDN.

## Standard pracy

- Przed zmianami sprawdz `git status --short --branch`.
- Nie nadpisuj ani nie cofaj zmian, ktorych sam nie zrobiles.
- Pracuj na osobnym branchu `codex/<krotki-opis-zadania>`, chyba ze runner Codexa juz utworzyl branch dla zadania.
- Zmiany trzymaj male i zrozumiale. Dla osob nietechnicznych wazniejszy jest czytelny portal i jasny opis niz sprytna abstrakcja.
- Jesli zmieniasz metodologie obliczen, zaktualizuj jednoczesnie:
  - widoczne wyjasnienia i wzory w portalu,
  - eksporty `summary CSV` i `trace CSV`, jesli zmienia sie ich znaczenie,
  - testy JS i E2E,
  - README, jesli zmienia sie sposob uruchamiania albo interpretacji wynikow.

## Zasady metodologii

- Wyniki licz bezposrednio z surowych punktow CSV z Trapezium, nie z gotowych parametrow raportowanych przez aparat.
- Jesli pomiar ma kilka plikow CSV, traktuj je jako jeden ciagly pomiar jednej probki.
- Zachowuj `globalIndex`, `sourceFile` i `sourceRow`, zeby kazdy wynik dal sie powiazac z punktem zrodlowym.
- Pierwszy wykryty cykl traktuj jako preload/preconditioning, jesli pomiar ma co najmniej dwa cykle.
- Preload zostaje w danych i QC, ale nie jest punktem odniesienia dla retention/softening i nie pojawia sie na glownych wykresach publikacyjnych.
- Do obliczen stress-strain uzywaj `stressPlus = max(stressRaw, 0)` oraz `strainFrac = displacement / h0`.
- `strain_%` sluzy tylko do prezentacji.
- Retention i softening licz wzgledem `cycle 1`, czyli pierwszego cyklu po preloadzie.
- Nie usuwaj eksportu `trace CSV`. To kluczowy element transparentnosci recenzenckiej.

Najwazniejsze wzory, ktore powinny pozostac widoczne w portalu:

```text
stressPlus = max(stressRaw, 0)
strainFrac = displacement / h0
Ai = ((stressPlus_i + stressPlus_i-1) / 2) * |strainFrac_i - strainFrac_i-1| * 1000
H = Aloading - Aunloading
R = (Aunloading / Aloading) * 100
Esec90 = sigma90 / 0.90
Retention_n = (sigmaMax_n / sigmaMax_cycle1) * 100
Softening_n = 100 - Retention_n
Ai,Fd = ((forcePlus_i + forcePlus_i-1) / 2) * |displacement_i - displacement_i-1|
HFd = Aloading,Fd - Aunloading,Fd
elastic recovery = RFd = (Aunloading,Fd / Aloading,Fd) * 100
```

## Workflow PR w webowym Codexie

1. Zrozum prosbe i sprawdz odpowiednie pliki.
2. Wprowadz zmiany na branchu zadania.
3. Uruchom testy:
   - dla zmian w kodzie, metodologii, UI albo testach: `make test`;
   - dla zmian tylko dokumentacyjnych: testy nie sa wymagane, ale napisz to jasno w podsumowaniu.
4. Jesli testy nie przejda, napraw problem i uruchom je ponownie. Nie wystawiaj PR jako gotowego, gdy testy sa czerwone.
5. Zacommituj zmiany czytelnym komunikatem.
6. Wystaw PR do `main`.
7. Poczekaj na GitHub Actions.
8. Jesli CI przejdzie, napisz po polsku, ze PR jest gotowy do merge.
9. Jesli CI nie przejdzie, napraw problem albo jasno opisz, co blokuje dalsza prace.

Domyslnie nie merge'uj PR automatycznie. Osoba nietechniczna powinna dostac jasny komunikat, ze moze kliknac merge po zielonych testach.

## Komunikacja z uzytkownikiem

- Pisz krotko i konkretnie.
- Unikaj zargonu albo od razu tlumacz, co oznacza.
- Na koniec zawsze podaj:
  - co zostalo zmienione,
  - jakie testy zostaly uruchomione,
  - czy testy przeszly,
  - czy PR jest gotowy do merge albo co go blokuje.
- Jesli potrzebujesz decyzji uzytkownika, zadaj jedno konkretne pytanie.
- Jesli cos jest ryzykowne metodologicznie, nazwij ryzyko prostym jezykiem.
