import math
import re

import altair as alt
import pandas as pd
import streamlit as st


PROG_MM = 0.02
MIN_PUNKTOW = 200
POZIOMY_ODKSZTALCENIA = [0.10, 0.30, 0.50, 0.70, 0.90]
LICZBA_CYKLI_PUBLIKACYJNYCH = 5

alt.data_transformers.disable_max_rows()


def parsuj_csv(tekst):
    wiersze = []
    for nr, surowa in enumerate(tekst.splitlines(), start=1):
        linia = surowa.strip()
        if not linia:
            continue
        if '"' in linia:
            pola = re.findall(r'"([^"]*)"', linia)
        elif ";" in linia:
            pola = linia.split(";")
        else:
            pola = linia.split(",")
        if len(pola) < 5:
            continue
        wartosci = []
        poprawny = True
        for pole in pola[:5]:
            try:
                wartosci.append(float(pole.strip().replace(",", ".")))
            except ValueError:
                poprawny = False
                break
        if poprawny:
            wiersze.append({"values": wartosci, "sourceLine": nr})
    return wiersze


def dekoduj_plik(uploaded_file):
    bufor = uploaded_file.getvalue()
    for kodowanie in ("cp1250", "utf-8", "latin1"):
        try:
            return bufor.decode(kodowanie)
        except UnicodeDecodeError:
            continue
    return bufor.decode("latin1", errors="replace")


def waliduj(listy_wierszy, nazwy):
    bledy = []
    ostrzezenia = []
    zakresy = []
    punkty = []

    for i, wiersze in enumerate(listy_wierszy):
        nazwa = nazwy[i] if nazwy and i < len(nazwy) else f"plik {i + 1}"
        if not wiersze:
            bledy.append(
                f'Plik "{nazwa}" nie zawiera zadnych wierszy z 5 wartosciami liczbowymi '
                "- to na pewno eksport z maszyny (Czas, Sila, Przemieszczenie, Naprezenie, Rozstaw)?"
            )
            continue
        czasy = [w["values"][0] for w in wiersze]
        zakresy.append({"nazwa": nazwa, "od": min(czasy), "do": max(czasy), "n": len(wiersze)})
        for j, w in enumerate(wiersze):
            czas, sila, przemieszczenie, naprezenie, rozstaw = w["values"]
            punkty.append(
                {
                    "time": czas,
                    "force": sila,
                    "displacement": przemieszczenie,
                    "stressRaw": naprezenie,
                    "spacing": rozstaw,
                    "sourceFile": nazwa,
                    "sourceFileIndex": i,
                    "sourceRow": w.get("sourceLine", j + 1),
                }
            )

    if bledy:
        return {"bledy": bledy, "ostrzezenia": ostrzezenia, "zakresy": zakresy, "dane": []}

    punkty.sort(key=lambda p: (p["time"], p["sourceFileIndex"], p["sourceRow"]))

    przed = len(punkty)
    widziane = set()
    dane = []
    for p in punkty:
        klucz = (p["time"], p["force"], p["displacement"], p["stressRaw"], p["spacing"])
        if klucz in widziane:
            continue
        widziane.add(klucz)
        dane.append(p)

    usuniete = przed - len(dane)
    if usuniete > 0:
        ostrzezenia.append(
            f"Usunieto {usuniete:,} zduplikowanych wierszy - mozliwe, ze ten sam plik zostal wgrany wiecej niz raz."
        )

    if not dane:
        bledy.append("Po scaleniu plikow nie zostaly zadne dane.")
        return {"bledy": bledy, "ostrzezenia": ostrzezenia, "zakresy": zakresy, "dane": dane}

    kolizje = sum(1 for i in range(1, len(dane)) if dane[i]["time"] == dane[i - 1]["time"])
    if kolizje > 0:
        ostrzezenia.append(
            f"{kolizje:,} punktow ma ten sam czas, ale rozne wartosci - pliki nakladaja sie zakresami. "
            "Sprawdz, czy wszystkie pochodza z tego samego pomiaru."
        )

    dt = [dane[i]["time"] - dane[i - 1]["time"] for i in range(1, len(dane))]
    if dt:
        dt_sort = sorted(dt)
        mediana_dt = dt_sort[len(dt_sort) // 2] or 0
        if mediana_dt > 0:
            dziury = [
                {"t": dane[i]["time"], "dlugosc": delta}
                for i, delta in enumerate(dt)
                if delta > 10 * mediana_dt
            ]
            if dziury:
                opis = "; ".join(f'{d["dlugosc"]:.1f} s przy t = {d["t"]:.1f} s' for d in dziury[:3])
                ogon = "; ..." if len(dziury) > 3 else ""
                ostrzezenia.append(
                    f"Wykryto {len(dziury)} dziur(y) w osi czasu ({opis}{ogon}) - prawdopodobnie brakuje "
                    "czesci pomiaru. Wyniki cykli przecietych dziura beda bledne."
                )

    for i, p in enumerate(dane, start=1):
        p["globalIndex"] = i

    if any(p["spacing"] <= 0 for p in dane):
        ostrzezenia.append("W danych wystepuje rozstaw <= 0 mm - sprawdz kolumny pliku.")
    if any(abs(p["force"]) > 10000 for p in dane):
        ostrzezenia.append("Sila przekracza 10 kN - to nie wyglada na ten typ badania, sprawdz jednostki.")
    if all(abs(p["stressRaw"]) < 1e-9 for p in dane):
        ostrzezenia.append("Kolumna naprezenia jest wszedzie zerowa - maszyna nie zapisala naprezen.")
    if len(dane) < 1000:
        ostrzezenia.append(f"Bardzo krotki pomiar ({len(dane)} punktow) - wyniki moga byc niemiarodajne.")

    return {"bledy": bledy, "ostrzezenia": ostrzezenia, "zakresy": zakresy, "dane": dane}


def wzbogac_punkty(dane, h0):
    return [
        {
            **p,
            "strainFrac": p["displacement"] / h0,
            "strainPct": 100 * p["displacement"] / h0,
            "stressPlus": max(p["stressRaw"], 0),
            "forceForFd": p["force"],
            "negativeStressZeroed": p["stressRaw"] < 0,
        }
        for p in dane
    ]


def wykryj_cykle(dane):
    segmenty = []
    start = None
    for i in range(len(dane) + 1):
        kontakt = i < len(dane) and dane[i]["displacement"] > PROG_MM
        if kontakt and start is None:
            start = max(0, i - 1)
        elif not kontakt and start is not None:
            end = i if i < len(dane) else len(dane) - 1
            if end - start + 1 >= MIN_PUNKTOW:
                segmenty.append(dane[start : end + 1])
            start = None
    return segmenty


def etykieta_cyklu(raw_index, has_preload):
    if has_preload and raw_index == 0:
        return {"isPreload": True, "cycleNumber": None, "cycleLabel": "preload"}
    cycle_number = raw_index if has_preload else raw_index + 1
    return {"isPreload": False, "cycleNumber": cycle_number, "cycleLabel": f"cycle {cycle_number}"}


def interpoluj_poziom(punkty_loading, target_strain_frac):
    rosnace = []
    for p in punkty_loading:
        if not rosnace or p["strainFrac"] > rosnace[-1]["strainFrac"]:
            rosnace.append(p)

    brak = {
        "targetStrainFrac": target_strain_frac,
        "targetStrainPct": target_strain_frac * 100,
        "stress": None,
        "leftGlobalIndex": None,
        "rightGlobalIndex": None,
        "leftStrainFrac": None,
        "rightStrainFrac": None,
        "leftStressPlus": None,
        "rightStressPlus": None,
    }
    if not rosnace or target_strain_frac < rosnace[0]["strainFrac"] or target_strain_frac > rosnace[-1]["strainFrac"]:
        return brak

    lo = 0
    hi = len(rosnace) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if rosnace[m]["strainFrac"] <= target_strain_frac:
            lo = m
        else:
            hi = m

    left = rosnace[lo]
    right = rosnace[hi]
    mianownik = right["strainFrac"] - left["strainFrac"]
    u = (target_strain_frac - left["strainFrac"]) / (mianownik or 1)
    stress = left["stressPlus"] + u * (right["stressPlus"] - left["stressPlus"])
    return {
        "targetStrainFrac": target_strain_frac,
        "targetStrainPct": target_strain_frac * 100,
        "stress": stress,
        "leftGlobalIndex": left["globalIndex"],
        "rightGlobalIndex": right["globalIndex"],
        "leftStrainFrac": left["strainFrac"],
        "rightStrainFrac": right["strainFrac"],
        "leftStressPlus": left["stressPlus"],
        "rightStressPlus": right["stressPlus"],
    }


def policz_cykl(seg, raw_index=0, has_preload=False):
    etykieta = etykieta_cyklu(raw_index, has_preload)
    max_disp = max(p["displacement"] for p in seg)
    i_max = next(i for i, p in enumerate(seg) if p["displacement"] == max_disp)
    punkty = []
    for i, p in enumerate(seg):
        punkty.append(
            {
                **p,
                "cycleRawIndex": raw_index + 1,
                "cycleNumber": etykieta["cycleNumber"],
                "cycleLabel": etykieta["cycleLabel"],
                "isPreload": etykieta["isPreload"],
                "pointIndexInCycle": i + 1,
                "phase": "loading" if i <= i_max else "unloading",
            }
        )

    loading_points = punkty[: i_max + 1]
    a_loading_kjm3 = 0
    a_unloading_kjm3 = 0
    a_loading_fd_mj = 0
    a_unloading_fd_mj = 0
    trace_rows = []

    for i, p in enumerate(punkty):
        prev = punkty[i - 1] if i > 0 else None
        interval_phase = "loading" if prev and i <= i_max else ("unloading" if prev else "")
        delta_strain = abs(p["strainFrac"] - prev["strainFrac"]) if prev else 0
        stress_avg = 0.5 * (p["stressPlus"] + prev["stressPlus"]) if prev else None
        trapezoid_area_kjm3 = stress_avg * delta_strain * 1000 if prev else 0
        delta_displacement = abs(p["displacement"] - prev["displacement"]) if prev else 0
        force_avg = 0.5 * (p["forceForFd"] + prev["forceForFd"]) if prev else None
        fd_trapezoid_area_mj = force_avg * delta_displacement if prev else 0

        if interval_phase == "loading":
            a_loading_kjm3 += trapezoid_area_kjm3
            a_loading_fd_mj += fd_trapezoid_area_mj
        elif interval_phase == "unloading":
            a_unloading_kjm3 += trapezoid_area_kjm3
            a_unloading_fd_mj += fd_trapezoid_area_mj

        trace_rows.append(
            {
                "rawPoint": p["globalIndex"],
                "globalIndex": p["globalIndex"],
                "sourceFile": p["sourceFile"],
                "sourceRow": p["sourceRow"],
                "time": p["time"],
                "cycleRawIndex": p["cycleRawIndex"],
                "cycleNumber": p["cycleNumber"],
                "cycleLabel": p["cycleLabel"],
                "isPreload": p["isPreload"],
                "pointIndexInCycle": p["pointIndexInCycle"],
                "phase": p["phase"],
                "intervalPhase": interval_phase,
                "displacement": p["displacement"],
                "forceRaw": p["force"],
                "forceForFd": p["forceForFd"],
                "strainFrac": p["strainFrac"],
                "strainPct": p["strainPct"],
                "stressRaw": p["stressRaw"],
                "stressPlus": p["stressPlus"],
                "negativeStressZeroed": p["negativeStressZeroed"],
                "prevGlobalIndex": prev["globalIndex"] if prev else None,
                "deltaStrain": delta_strain,
                "stressAvg": stress_avg,
                "trapezoidAreaKJm3": trapezoid_area_kjm3,
                "deltaDisplacement": delta_displacement,
                "forceAvg": force_avg,
                "fdTrapezoidAreaMj": fd_trapezoid_area_mj,
                "cumulativeLoadingKJm3": a_loading_kjm3,
                "cumulativeUnloadingKJm3": a_unloading_kjm3,
                "cumulativeLoadingFdMj": a_loading_fd_mj,
                "cumulativeUnloadingFdMj": a_unloading_fd_mj,
            }
        )

    hysteresis_kjm3 = a_loading_kjm3 - a_unloading_kjm3
    resilience_pct = 100 * a_unloading_kjm3 / a_loading_kjm3 if a_loading_kjm3 > 0 else None
    fd_hysteresis_mj = a_loading_fd_mj - a_unloading_fd_mj
    force_resilience_pct = 100 * a_unloading_fd_mj / a_loading_fd_mj if a_loading_fd_mj > 0 else None
    interpolations = {
        str(round(poziom * 100)): interpoluj_poziom(loading_points, poziom)
        for poziom in POZIOMY_ODKSZTALCENIA
    }
    sigma90 = interpolations["90"]["stress"]
    e_sec90 = sigma90 / 0.90 if sigma90 is not None else None
    first = punkty[0]
    last = punkty[-1]
    qc_complete = (
        len(loading_points) > 1
        and len(punkty) - len(loading_points) > 1
        and first["displacement"] <= PROG_MM
        and last["displacement"] <= PROG_MM
    )
    source_files = list(dict.fromkeys(p["sourceFile"] for p in punkty))

    wynik = {
        "cycleRawIndex": raw_index + 1,
        "cycleNumber": etykieta["cycleNumber"],
        "cycleLabel": etykieta["cycleLabel"],
        "isPreload": etykieta["isPreload"],
        "points": punkty,
        "traceRows": trace_rows,
        "tStart": first["time"],
        "tKoniec": last["time"],
        "sourceFiles": source_files,
        "loadingPointCount": len(loading_points),
        "unloadingPointCount": len(punkty) - len(loading_points),
        "negativeStressZeroedCount": sum(1 for p in punkty if p["negativeStressZeroed"]),
        "complete": qc_complete,
        "maxStrainFrac": max(p["strainFrac"] for p in punkty),
        "maxStrainPct": max(p["strainPct"] for p in punkty),
        "sigmaMax": max(p["stressPlus"] for p in punkty),
        "stressRawMin": min(p["stressRaw"] for p in punkty),
        "fMax": max(p["force"] for p in punkty),
        "aLoadingKJm3": a_loading_kjm3,
        "aUnloadingKJm3": a_unloading_kjm3,
        "hysteresisKJm3": hysteresis_kjm3,
        "resiliencePct": resilience_pct,
        "aLoadingFdMj": a_loading_fd_mj,
        "aUnloadingFdMj": a_unloading_fd_mj,
        "fdHysteresisMj": fd_hysteresis_mj,
        "forceResiliencePct": force_resilience_pct,
        "elasticRecoveryValuePct": force_resilience_pct,
        "interpolations": interpolations,
        "sigma10": interpolations["10"]["stress"],
        "sigma30": interpolations["30"]["stress"],
        "sigma50": interpolations["50"]["stress"],
        "sigma70": interpolations["70"]["stress"],
        "sigma90": sigma90,
        "eSec90": e_sec90,
        "stressRetentionPct": None,
        "stressSofteningPct": None,
    }

    for row in wynik["traceRows"]:
        row["finalLoadingAreaKJm3"] = a_loading_kjm3
        row["finalUnloadingAreaKJm3"] = a_unloading_kjm3
        row["finalHysteresisKJm3"] = hysteresis_kjm3
        row["finalResiliencePct"] = resilience_pct
        row["finalLoadingFdMj"] = a_loading_fd_mj
        row["finalUnloadingFdMj"] = a_unloading_fd_mj
        row["finalFdHysteresisMj"] = fd_hysteresis_mj
        row["finalElasticRecoveryPct"] = force_resilience_pct

    return wynik


def analizuj(listy_wierszy, h0_wejsciowe, nazwy):
    walidacja = waliduj(listy_wierszy, nazwy)
    if walidacja["bledy"]:
        raise ValueError("\n".join(walidacja["bledy"]))

    dane = walidacja["dane"]
    h0 = dane[0]["spacing"] if h0_wejsciowe is None else h0_wejsciowe
    if not h0 > 0:
        raise ValueError(f"Nieprawidlowe h0 (rozstaw w danych: {dane[0]['spacing']} mm).")

    punkty = wzbogac_punkty(dane, h0)
    segmenty = wykryj_cykle(punkty)
    if not segmenty:
        raise ValueError(f"Nie wykryto zadnych cykli sciskania (przemieszczenie nigdy nie przekracza {PROG_MM} mm).")

    has_preload = len(segmenty) >= 2
    wyniki = [policz_cykl(seg, i, has_preload) for i, seg in enumerate(segmenty)]
    cycle1 = next((w for w in wyniki if not w["isPreload"]), None)
    sigma_ref = cycle1["sigmaMax"] if cycle1 else None

    for w in wyniki:
        if not w["isPreload"] and sigma_ref and sigma_ref > 0:
            w["stressRetentionPct"] = 100 * w["sigmaMax"] / sigma_ref
            w["stressSofteningPct"] = 100 - w["stressRetentionPct"]
            if abs(w["stressSofteningPct"]) < 1e-10:
                w["stressSofteningPct"] = 0
            if abs(w["stressRetentionPct"] - 100) < 1e-10:
                w["stressRetentionPct"] = 100
        for row in w["traceRows"]:
            row["finalStressRetentionPct"] = w["stressRetentionPct"]
            row["finalStressSofteningPct"] = w["stressSofteningPct"]
            row["finalESec90"] = w["eSec90"]
            row["finalSigma90"] = w["sigma90"]

    return {
        "h0": h0,
        "liczbaPunktow": len(punkty),
        "punkty": punkty,
        "cykle": [w["points"] for w in wyniki],
        "wyniki": wyniki,
        "trace": [row for w in wyniki for row in w["traceRows"]],
        "ostrzezenia": walidacja["ostrzezenia"],
        "zakresy": walidacja["zakresy"],
        "hasPreload": has_preload,
    }


def round_finite(v, n=12):
    return round(v, n) if isinstance(v, (int, float)) and math.isfinite(v) else v


def csv_value(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    tekst = str(round_finite(v)).replace(".", ",") if isinstance(v, (int, float)) else str(v)
    if any(znak in tekst for znak in [';', '"', "\n", "\r"]):
        return f'"{tekst.replace(chr(34), chr(34) + chr(34))}"'
    return tekst


def zrob_csv(naglowki, wiersze):
    linie = [";".join(naglowki)]
    for w in wiersze:
        linie.append(";".join(csv_value(w.get(h)) for h in naglowki))
    return "\n".join(linie)


def zrob_summary_csv(rezultat):
    interp_headers = []
    for poziom in POZIOMY_ODKSZTALCENIA:
        pct = round(poziom * 100)
        interp_headers.extend(
            [
                f"sigma{pct}_left_global_index",
                f"sigma{pct}_right_global_index",
                f"sigma{pct}_left_strain_frac",
                f"sigma{pct}_right_strain_frac",
                f"sigma{pct}_left_stress_plus_mpa",
                f"sigma{pct}_right_stress_plus_mpa",
            ]
        )
    naglowki = [
        "cycle_label",
        "cycle_number",
        "is_preload",
        "h0_mm",
        "total_points",
        "source_files",
        "t_start_s",
        "t_end_s",
        "complete",
        "loading_points",
        "unloading_points",
        "negative_stress_zeroed_points",
        "max_strain_frac",
        "max_strain_pct",
        "max_stress_plus_mpa",
        "max_force_n",
        "Aloading_kJ_m3",
        "Aunloading_kJ_m3",
        "hysteresis_kJ_m3",
        "resilience_pct",
        "Aloading_Fd_mJ",
        "Aunloading_Fd_mJ",
        "hysteresis_Fd_mJ",
        "force_resilience_pct",
        "elastic_recovery_value_pct",
        "stress_retention_pct",
        "stress_softening_pct",
        "Esec90_MPa",
        "sigma10_MPa",
        "sigma30_MPa",
        "sigma50_MPa",
        "sigma70_MPa",
        "sigma90_MPa",
        *interp_headers,
        "preload_policy",
    ]
    preload_policy = (
        "first detected cycle kept for QC and excluded from publication/reference metrics"
        if rezultat["hasPreload"]
        else "no separate preload detected"
    )
    wiersze = []
    for w in rezultat["wyniki"]:
        row = {
            "cycle_label": w["cycleLabel"],
            "cycle_number": w["cycleNumber"],
            "is_preload": w["isPreload"],
            "h0_mm": rezultat["h0"],
            "total_points": rezultat["liczbaPunktow"],
            "source_files": ", ".join(w["sourceFiles"]),
            "t_start_s": w["tStart"],
            "t_end_s": w["tKoniec"],
            "complete": w["complete"],
            "loading_points": w["loadingPointCount"],
            "unloading_points": w["unloadingPointCount"],
            "negative_stress_zeroed_points": w["negativeStressZeroedCount"],
            "max_strain_frac": w["maxStrainFrac"],
            "max_strain_pct": w["maxStrainPct"],
            "max_stress_plus_mpa": w["sigmaMax"],
            "max_force_n": w["fMax"],
            "Aloading_kJ_m3": w["aLoadingKJm3"],
            "Aunloading_kJ_m3": w["aUnloadingKJm3"],
            "hysteresis_kJ_m3": w["hysteresisKJm3"],
            "resilience_pct": w["resiliencePct"],
            "Aloading_Fd_mJ": w["aLoadingFdMj"],
            "Aunloading_Fd_mJ": w["aUnloadingFdMj"],
            "hysteresis_Fd_mJ": w["fdHysteresisMj"],
            "force_resilience_pct": w["forceResiliencePct"],
            "elastic_recovery_value_pct": w["elasticRecoveryValuePct"],
            "stress_retention_pct": w["stressRetentionPct"],
            "stress_softening_pct": w["stressSofteningPct"],
            "Esec90_MPa": w["eSec90"],
            "sigma10_MPa": w["sigma10"],
            "sigma30_MPa": w["sigma30"],
            "sigma50_MPa": w["sigma50"],
            "sigma70_MPa": w["sigma70"],
            "sigma90_MPa": w["sigma90"],
            "preload_policy": preload_policy,
        }
        for poziom in POZIOMY_ODKSZTALCENIA:
            pct = round(poziom * 100)
            interp = w["interpolations"][str(pct)]
            row[f"sigma{pct}_left_global_index"] = interp["leftGlobalIndex"]
            row[f"sigma{pct}_right_global_index"] = interp["rightGlobalIndex"]
            row[f"sigma{pct}_left_strain_frac"] = interp["leftStrainFrac"]
            row[f"sigma{pct}_right_strain_frac"] = interp["rightStrainFrac"]
            row[f"sigma{pct}_left_stress_plus_mpa"] = interp["leftStressPlus"]
            row[f"sigma{pct}_right_stress_plus_mpa"] = interp["rightStressPlus"]
        wiersze.append(row)
    return zrob_csv(naglowki, wiersze)


def zrob_trace_csv(rezultat):
    naglowki = [
        "raw_point",
        "global_index",
        "source_file",
        "source_row",
        "time_s",
        "cycle_label",
        "cycle_number",
        "is_preload",
        "point_in_cycle",
        "phase",
        "interval_phase",
        "displacement_mm",
        "force_raw_n",
        "force_for_fd_n",
        "strain_frac",
        "strain_pct",
        "stress_raw_mpa",
        "stress_plus_mpa",
        "negative_stress_zeroed",
        "previous_global_index",
        "delta_strain_abs",
        "stress_avg_mpa",
        "trapezoid_area_kJ_m3",
        "delta_displacement_abs_mm",
        "force_avg_n",
        "fd_trapezoid_area_mJ",
        "cumulative_loading_kJ_m3",
        "cumulative_unloading_kJ_m3",
        "cumulative_loading_Fd_mJ",
        "cumulative_unloading_Fd_mJ",
        "final_loading_area_kJ_m3",
        "final_unloading_area_kJ_m3",
        "final_hysteresis_kJ_m3",
        "final_resilience_pct",
        "final_loading_Fd_mJ",
        "final_unloading_Fd_mJ",
        "final_Fd_hysteresis_mJ",
        "final_elastic_recovery_pct",
        "final_stress_retention_pct",
        "final_stress_softening_pct",
        "final_Esec90_MPa",
        "final_sigma90_MPa",
    ]
    wiersze = []
    for r in rezultat["trace"]:
        wiersze.append(
            {
                "raw_point": r["rawPoint"],
                "global_index": r["globalIndex"],
                "source_file": r["sourceFile"],
                "source_row": r["sourceRow"],
                "time_s": r["time"],
                "cycle_label": r["cycleLabel"],
                "cycle_number": r["cycleNumber"],
                "is_preload": r["isPreload"],
                "point_in_cycle": r["pointIndexInCycle"],
                "phase": r["phase"],
                "interval_phase": r["intervalPhase"],
                "displacement_mm": r["displacement"],
                "force_raw_n": r["forceRaw"],
                "force_for_fd_n": r["forceForFd"],
                "strain_frac": r["strainFrac"],
                "strain_pct": r["strainPct"],
                "stress_raw_mpa": r["stressRaw"],
                "stress_plus_mpa": r["stressPlus"],
                "negative_stress_zeroed": r["negativeStressZeroed"],
                "previous_global_index": r["prevGlobalIndex"],
                "delta_strain_abs": r["deltaStrain"],
                "stress_avg_mpa": r["stressAvg"],
                "trapezoid_area_kJ_m3": r["trapezoidAreaKJm3"],
                "delta_displacement_abs_mm": r["deltaDisplacement"],
                "force_avg_n": r["forceAvg"],
                "fd_trapezoid_area_mJ": r["fdTrapezoidAreaMj"],
                "cumulative_loading_kJ_m3": r["cumulativeLoadingKJm3"],
                "cumulative_unloading_kJ_m3": r["cumulativeUnloadingKJm3"],
                "cumulative_loading_Fd_mJ": r["cumulativeLoadingFdMj"],
                "cumulative_unloading_Fd_mJ": r["cumulativeUnloadingFdMj"],
                "final_loading_area_kJ_m3": r["finalLoadingAreaKJm3"],
                "final_unloading_area_kJ_m3": r["finalUnloadingAreaKJm3"],
                "final_hysteresis_kJ_m3": r["finalHysteresisKJm3"],
                "final_resilience_pct": r["finalResiliencePct"],
                "final_loading_Fd_mJ": r["finalLoadingFdMj"],
                "final_unloading_Fd_mJ": r["finalUnloadingFdMj"],
                "final_Fd_hysteresis_mJ": r["finalFdHysteresisMj"],
                "final_elastic_recovery_pct": r["finalElasticRecoveryPct"],
                "final_stress_retention_pct": r["finalStressRetentionPct"],
                "final_stress_softening_pct": r["finalStressSofteningPct"],
                "final_Esec90_MPa": r["finalESec90"],
                "final_sigma90_MPa": r["finalSigma90"],
            }
        )
    return zrob_csv(naglowki, wiersze)


def fmt(x, n=4):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return ""
    if isinstance(x, (int, float)):
        return round(x, n)
    return x


def tabela_energia(wyniki):
    return pd.DataFrame(
        [
            {
                "cykl": w["cycleLabel"],
                "rola": "preconditioning/QC" if w["isPreload"] else "publication",
                "sigma max [MPa]": fmt(w["sigmaMax"]),
                "strain max [%]": fmt(w["maxStrainPct"], 2),
                "Aloading [kJ/m3]": fmt(w["aLoadingKJm3"], 2),
                "Aunloading [kJ/m3]": fmt(w["aUnloadingKJm3"], 2),
                "hysteresis H [kJ/m3]": fmt(w["hysteresisKJm3"], 2),
                "resilience [%]": fmt(w["resiliencePct"], 1),
                "Aloading F-d [mJ]": fmt(w["aLoadingFdMj"], 2),
                "Aunloading F-d [mJ]": fmt(w["aUnloadingFdMj"], 2),
                "HFd [mJ]": fmt(w["fdHysteresisMj"], 2),
                "elastic recovery [%]": fmt(w["elasticRecoveryValuePct"], 1),
                "max force [N]": fmt(w["fMax"], 2),
            }
            for w in wyniki
        ]
    )


def tabela_mechanika(wyniki):
    return pd.DataFrame(
        [
            {
                "cykl": w["cycleLabel"],
                "Esec90 [MPa]": fmt(w["eSec90"]),
                "sigma10 [MPa]": fmt(w["sigma10"]),
                "sigma30 [MPa]": fmt(w["sigma30"]),
                "sigma50 [MPa]": fmt(w["sigma50"]),
                "sigma70 [MPa]": fmt(w["sigma70"]),
                "sigma90 [MPa]": fmt(w["sigma90"]),
                "stress retention [%]": fmt(w["stressRetentionPct"], 1),
                "stress softening [%]": fmt(w["stressSofteningPct"], 1),
            }
            for w in wyniki
        ]
    )


def tabela_qc(wyniki):
    return pd.DataFrame(
        [
            {
                "cykl": w["cycleLabel"],
                "complete": "tak" if w["complete"] else "nie",
                "loading pts": w["loadingPointCount"],
                "unloading pts": w["unloadingPointCount"],
                "zeroed negative stress": w["negativeStressZeroedCount"],
                "raw stress min [MPa]": fmt(w["stressRawMin"]),
                "source files": ", ".join(w["sourceFiles"]),
            }
            for w in wyniki
        ]
    )


def decymuj(tablica, cel=2000):
    if len(tablica) <= cel:
        return tablica
    krok = math.ceil(len(tablica) / cel)
    wynik = [p for i, p in enumerate(tablica) if i % krok == 0]
    if wynik[-1] is not tablica[-1]:
        wynik.append(tablica[-1])
    return wynik


def wykres_linie(wyniki, x_col, y_col, tytul, x_title, y_title):
    rows = []
    for w in wyniki:
        for p in decymuj(w["points"]):
            rows.append({x_col: p[x_col], y_col: p[y_col], "cykl": w["cycleLabel"]})
    if not rows:
        return
    df = pd.DataFrame(rows)
    chart = (
        alt.Chart(df)
        .mark_line()
        .encode(
            x=alt.X(f"{x_col}:Q", title=x_title),
            y=alt.Y(f"{y_col}:Q", title=y_title),
            color=alt.Color("cykl:N", title="cykl"),
        )
        .properties(title=tytul, height=420)
        .interactive()
    )
    st.altair_chart(chart, use_container_width=True)


def wykres_trendy(wyniki):
    metrics = [
        ("Hysteresis [kJ/m3]", "hysteresisKJm3"),
        ("Resilience [%]", "resiliencePct"),
        ("Stress retention [%]", "stressRetentionPct"),
        ("Stress softening [%]", "stressSofteningPct"),
        ("Esec90 [MPa]", "eSec90"),
        ("F-d hysteresis [mJ]", "fdHysteresisMj"),
        ("Elastic recovery [%]", "elasticRecoveryValuePct"),
        ("Max force [N]", "fMax"),
    ]
    rows = []
    for w in wyniki:
        for label, key in metrics:
            rows.append({"cycle": w["cycleNumber"], "metric": label, "value": w[key]})
    df = pd.DataFrame(rows).dropna()
    if df.empty:
        return
    chart = (
        alt.Chart(df)
        .mark_line(point=True)
        .encode(
            x=alt.X("cycle:O", title="Cycle"),
            y=alt.Y("value:Q", title="wartosc"),
            color=alt.Color("metric:N", legend=None),
        )
        .properties(height=180)
        .facet(facet=alt.Facet("metric:N", title=None), columns=2)
        .resolve_scale(y="independent")
    )
    st.altair_chart(chart, use_container_width=True)


st.set_page_config(page_title="Analiza cyklicznego sciskania - Streamlit", layout="wide")

st.title("Analiza cyklicznego ściskania")
st.caption(
    "Wersja Streamlit liczy parametry z surowych punktów CSV z Trapezium. Dane są scalane w jeden ciągły "
    "pomiar jednej próbki, a eksport trace pozwala przeaudytować każdy punkt."
)

with st.expander("Metodologia i wzory", expanded=True):
    st.write(
        "Każdy cykl jest liczony z surowych punktów. Ujemne naprężenia z odrywania głowicy są zerowane "
        "tylko w analizie stress-strain, bo nie są traktowane jako odpowiedź mechaniczna hydrożelu. "
        "Analiza force-displacement używa surowej siły z CSV."
    )
    st.code(
        """stressPlus = max(stressRaw, 0)
strainFrac = displacement / h0
Ai = ((stressPlus_i + stressPlus_i-1) / 2) * |strainFrac_i - strainFrac_i-1| * 1000
H = Aloading - Aunloading
R = (Aunloading / Aloading) * 100
Esec90 = sigma90 / 0.90
Retention_n = (sigmaMax_n / sigmaMax_cycle1) * 100
Softening_n = 100 - Retention_n
Ai,Fd = ((force_i + force_i-1) / 2) * |displacement_i - displacement_i-1|
HFd = Aloading,Fd - Aunloading,Fd
elastic recovery = RFd = (Aunloading,Fd / Aloading,Fd) * 100""",
        language="text",
    )
    st.write(
        "Mnożnik 1000 wynika z jednostek: MPa × strain_frac = MJ/m3, więc MJ/m3 × 1000 = kJ/m3. "
        "Odkształcenie do obliczeń jest ułamkiem, a strain_% służy tylko do prezentacji."
    )
    st.write(
        "Preload: jeżeli pomiar ma co najmniej dwa cykle, pierwszy wykryty cykl zostaje w danych i QC, "
        "ale nie jest punktem odniesienia dla retention/softening i nie pojawia się na głównych wykresach "
        "publikacyjnych."
    )

pliki = st.file_uploader(
    "Wgraj pliki CSV jednej próbki",
    type=["csv", "txt"],
    accept_multiple_files=True,
)
h0_text = st.text_input("h0 - wysokość próbki [mm]; zostaw puste, aby użyć pierwszego rozstawu z danych", "")

if pliki:
    try:
        h0_value = None
        if h0_text.strip():
            h0_value = float(h0_text.strip().replace(",", "."))

        nazwy = [plik.name for plik in pliki]
        listy = [parsuj_csv(dekoduj_plik(plik)) for plik in pliki]
        rezultat = analizuj(listy, h0_value, nazwy)
    except Exception as exc:
        st.error(f"Błąd: {exc}")
    else:
        if rezultat["ostrzezenia"]:
            st.warning("\n".join(f"- {ostrzezenie}" for ostrzezenie in rezultat["ostrzezenia"]))

        zakres_df = pd.DataFrame(rezultat["zakresy"]).rename(
            columns={"nazwa": "plik", "od": "t od [s]", "do": "t do [s]", "n": "punkty"}
        )
        st.subheader("Wczytane pliki")
        st.dataframe(zakres_df, use_container_width=True, hide_index=True)

        st.write(
            f"Punktów pomiarowych: {rezultat['liczbaPunktow']:,} · h0 = {rezultat['h0']:.4f} mm · "
            f"wykryto cykli: {len(rezultat['cykle'])}"
            + (" · pierwszy cykl traktowany jako preload/QC" if rezultat["hasPreload"] else "")
        )

        summary_csv = "\ufeff" + zrob_summary_csv(rezultat)
        trace_csv = "\ufeff" + zrob_trace_csv(rezultat)
        col_a, col_b = st.columns(2)
        with col_a:
            st.download_button("Pobierz summary CSV", summary_csv, "wyniki_summary.csv", "text/csv")
        with col_b:
            st.download_button("Pobierz trace CSV", trace_csv, "trace_punkt_po_punkcie.csv", "text/csv")

        st.subheader("Energia i odzysk mechaniczny")
        st.info(
            "Każdy cykl jest liczony z surowych punktów. Ujemne naprężenia z odrywania głowicy są zerowane: "
            "stressPlus = max(stressRaw, 0). Ta korekcja dotyczy wyłącznie naprężenia. Pole stress-strain "
            "dla interwału: Ai = ((stressPlus_i + stressPlus_i-1) / 2) * |strainFrac_i - strainFrac_i-1| * 1000 "
            "[kJ/m3]. Następnie: H = Aloading - Aunloading oraz R = (Aunloading / Aloading) * 100. "
            "Dla force-displacement: Ai,Fd = ((F_i + F_i-1) / 2) * |d_i - d_i-1| [mJ], "
            "HFd = Aloading,Fd - Aunloading,Fd, elastic recovery = RFd = "
            "(Aunloading,Fd / Aloading,Fd) * 100. Używana jest surowa siła F z eksportu Trapezium; "
            "ujemne wartości siły pozostają w trace."
        )
        st.dataframe(tabela_energia(rezultat["wyniki"]), use_container_width=True, hide_index=True)

        st.subheader("Sztywność, retention i softening")
        st.info(
            "Odkształcenie do obliczeń jest ułamkiem: strainFrac = displacement / h0. Naprężenia przy "
            "strainFrac = 0.10, 0.30, 0.50, 0.70, 0.90 są wyznaczane interpolacją liniową na gałęzi loading. "
            "Moduł sieczny: Esec90 = sigma90 / 0.90. Retention i softening są liczone względem cycle 1, "
            "czyli pierwszego cyklu po preloadzie: Retention_n = (sigmaMax_n / sigmaMax_cycle1) * 100, "
            "Softening_n = 100 - Retention_n. Preload nie ma retention ani softening, bo jest cyklem "
            "kondycjonującym."
        )
        st.dataframe(tabela_mechanika(rezultat["wyniki"]), use_container_width=True, hide_index=True)

        st.subheader("QC cykli")
        st.info(
            "Preload jest zachowany jako cykl kondycjonujący i kontrola jakości, ale nie jest punktem "
            "odniesienia dla retention/softening i nie jest pokazywany na głównych wykresach publikacyjnych. "
            "QC sprawdza maksymalny strain, maksymalny stressPlus, liczby punktów loading/unloading, liczbę "
            "punktów z naprężeniem stressRaw < 0 wyzerowanych do stressPlus = 0 oraz kompletność cyklu. "
            "Kolumna source_row w trace CSV wskazuje rzeczywistą linię w pliku CSV, więc można wrócić do "
            "oryginalnego eksportu."
        )
        st.dataframe(tabela_qc(rezultat["wyniki"]), use_container_width=True, hide_index=True)

        publikacyjne = [w for w in rezultat["wyniki"] if not w["isPreload"]][:LICZBA_CYKLI_PUBLIKACYJNYCH]
        wlasciwe = [w for w in rezultat["wyniki"] if not w["isPreload"]]

        st.subheader("Stress-strain loops")
        st.info(
            "Wykres pokazuje tylko cykle publikacyjne 1-5, bez preloadu: x = strain_% = "
            "100 * displacement / h0, y = stressPlus [MPa]."
        )
        wykres_linie(
            publikacyjne,
            "strainPct",
            "stressPlus",
            "Stress-strain loops (cycles 1-5, no preload)",
            "Strain [%]",
            "Stress+ [MPa]",
        )

        st.subheader("Force-displacement loops")
        st.info(
            "Wykres force-displacement pokazuje tylko cykle publikacyjne 1-5, bez preloadu. Oś Y i całka "
            "używają surowej siły F [N]. Ujemne fragmenty siły są zachowane, dlatego RFd może spaść albo "
            "przyjąć wartość ujemną, jeśli odrywanie głowicy dominuje w unloading."
        )
        wykres_linie(
            publikacyjne,
            "displacement",
            "forceForFd",
            "Force-displacement loops (cycles 1-5, no preload)",
            "Displacement [mm]",
            "Force [N]",
        )

        st.subheader("Trendy parametrów")
        st.info(
            "Trendy pokazują parametry końcowe per cycle 1..n bez preloadu: hysteresis, resilience, retention, "
            "softening, Esec90, HFd, elastic recovery i max force."
        )
        wykres_trendy(wlasciwe)
else:
    st.info("Wgraj jeden lub kilka plików CSV jednej próbki, żeby uruchomić analizę.")
