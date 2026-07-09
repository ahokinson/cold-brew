// CVSS base-score calculator. Handles v4.0 (preferred) and v3.1 (fallback).
//
// The v4 implementation is a direct TypeScript port of FIRST's reference
// calculator (https://github.com/FIRSTdotorg/cvss-v4-calculator). Lookup
// tables are copied verbatim from that repo under BSD-2-Clause.
//
// v3.1 follows https://www.first.org/cvss/v3.1/specification-document

type Metrics = Record<string, string>

function parseVector(vector: string): Metrics | null {
  const parts = vector.split("/")
  if (parts.length < 2) return null
  const metrics: Metrics = {}
  for (const part of parts.slice(1)) {
    const [key, value] = part.split(":")
    if (!key || !value) return null
    metrics[key] = value
  }
  return metrics
}

// ---------- CVSS v3.1 ----------

const V3_AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as const
const V3_AC = { L: 0.77, H: 0.44 } as const
const V3_PR_U = { N: 0.85, L: 0.62, H: 0.27 } as const
const V3_PR_C = { N: 0.85, L: 0.68, H: 0.5 } as const
const V3_UI = { N: 0.85, R: 0.62 } as const
const V3_CIA = { N: 0, L: 0.22, H: 0.56 } as const

function roundUp1(value: number): number {
  const scaled = Math.round(value * 100000)
  if (scaled % 10000 === 0) return scaled / 100000
  return (Math.floor(scaled / 10000) + 1) / 10
}

function computeCvssV3(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//i.test(vector)) return null
  const metrics = parseVector(vector)
  if (!metrics) return null
  const av = V3_AV[metrics.AV as keyof typeof V3_AV]
  const ac = V3_AC[metrics.AC as keyof typeof V3_AC]
  const ui = V3_UI[metrics.UI as keyof typeof V3_UI]
  const scope = metrics.S
  if (!scope) return null
  const pr = scope === "C" ? V3_PR_C[metrics.PR as keyof typeof V3_PR_C] : V3_PR_U[metrics.PR as keyof typeof V3_PR_U]
  const c = V3_CIA[metrics.C as keyof typeof V3_CIA]
  const i = V3_CIA[metrics.I as keyof typeof V3_CIA]
  const a = V3_CIA[metrics.A as keyof typeof V3_CIA]
  if ([av, ac, ui, pr, c, i, a].some((v) => v === undefined)) return null
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!)
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
  if (impact <= 0) return 0
  const exploitability = 8.22 * av! * ac! * pr! * ui!
  const raw = scope === "U" ? Math.min(impact + exploitability, 10) : Math.min(1.08 * (impact + exploitability), 10)
  return roundUp1(raw)
}

// ---------- CVSS v4.0 ----------
// Tables below are copied from the FIRST reference JS calculator (BSD-2-Clause).

const CVSS_LOOKUP_GLOBAL: Record<string, number> = {
  "000000": 10,
  "000001": 9.9,
  "000010": 9.8,
  "000011": 9.5,
  "000020": 9.5,
  "000021": 9.2,
  "000100": 10,
  "000101": 9.6,
  "000110": 9.3,
  "000111": 8.7,
  "000120": 9.1,
  "000121": 8.1,
  "000200": 9.3,
  "000201": 9,
  "000210": 8.9,
  "000211": 8,
  "000220": 8.1,
  "000221": 6.8,
  "001000": 9.8,
  "001001": 9.5,
  "001010": 9.5,
  "001011": 9.2,
  "001020": 9,
  "001021": 8.4,
  "001100": 9.3,
  "001101": 9.2,
  "001110": 8.9,
  "001111": 8.1,
  "001120": 8.1,
  "001121": 6.5,
  "001200": 8.8,
  "001201": 8,
  "001210": 7.8,
  "001211": 7,
  "001220": 6.9,
  "001221": 4.8,
  "002001": 9.2,
  "002011": 8.2,
  "002021": 7.2,
  "002101": 7.9,
  "002111": 6.9,
  "002121": 5,
  "002201": 6.9,
  "002211": 5.5,
  "002221": 2.7,
  "010000": 9.9,
  "010001": 9.7,
  "010010": 9.5,
  "010011": 9.2,
  "010020": 9.2,
  "010021": 8.5,
  "010100": 9.5,
  "010101": 9.1,
  "010110": 9,
  "010111": 8.3,
  "010120": 8.4,
  "010121": 7.1,
  "010200": 9.2,
  "010201": 8.1,
  "010210": 8.2,
  "010211": 7.1,
  "010220": 7.2,
  "010221": 5.3,
  "011000": 9.5,
  "011001": 9.3,
  "011010": 9.2,
  "011011": 8.5,
  "011020": 8.5,
  "011021": 7.3,
  "011100": 9.2,
  "011101": 8.2,
  "011110": 8,
  "011111": 7.2,
  "011120": 7,
  "011121": 5.9,
  "011200": 8.4,
  "011201": 7,
  "011210": 7.1,
  "011211": 5.2,
  "011220": 5,
  "011221": 3,
  "012001": 8.6,
  "012011": 7.5,
  "012021": 5.2,
  "012101": 7.1,
  "012111": 5.2,
  "012121": 2.9,
  "012201": 6.3,
  "012211": 2.9,
  "012221": 1.7,
  "100000": 9.8,
  "100001": 9.5,
  "100010": 9.4,
  "100011": 8.7,
  "100020": 9.1,
  "100021": 8.1,
  "100100": 9.4,
  "100101": 8.9,
  "100110": 8.6,
  "100111": 7.4,
  "100120": 7.7,
  "100121": 6.4,
  "100200": 8.7,
  "100201": 7.5,
  "100210": 7.4,
  "100211": 6.3,
  "100220": 6.3,
  "100221": 4.9,
  "101000": 9.4,
  "101001": 8.9,
  "101010": 8.8,
  "101011": 7.7,
  "101020": 7.6,
  "101021": 6.7,
  "101100": 8.6,
  "101101": 7.6,
  "101110": 7.4,
  "101111": 5.8,
  "101120": 5.9,
  "101121": 5,
  "101200": 7.2,
  "101201": 5.7,
  "101210": 5.7,
  "101211": 5.2,
  "101220": 5.2,
  "101221": 2.5,
  "102001": 8.3,
  "102011": 7,
  "102021": 5.4,
  "102101": 6.5,
  "102111": 5.8,
  "102121": 2.6,
  "102201": 5.3,
  "102211": 2.1,
  "102221": 1.3,
  "110000": 9.5,
  "110001": 9,
  "110010": 8.8,
  "110011": 7.6,
  "110020": 7.6,
  "110021": 7,
  "110100": 9,
  "110101": 7.7,
  "110110": 7.5,
  "110111": 6.2,
  "110120": 6.1,
  "110121": 5.3,
  "110200": 7.7,
  "110201": 6.6,
  "110210": 6.8,
  "110211": 5.9,
  "110220": 5.2,
  "110221": 3,
  "111000": 8.9,
  "111001": 7.8,
  "111010": 7.6,
  "111011": 6.7,
  "111020": 6.2,
  "111021": 5.8,
  "111100": 7.4,
  "111101": 5.9,
  "111110": 5.7,
  "111111": 5.7,
  "111120": 4.7,
  "111121": 2.3,
  "111200": 6.1,
  "111201": 5.2,
  "111210": 5.7,
  "111211": 2.9,
  "111220": 2.4,
  "111221": 1.6,
  "112001": 7.1,
  "112011": 5.9,
  "112021": 3,
  "112101": 5.8,
  "112111": 2.6,
  "112121": 1.5,
  "112201": 2.3,
  "112211": 1.3,
  "112221": 0.6,
  "200000": 9.3,
  "200001": 8.7,
  "200010": 8.6,
  "200011": 7.2,
  "200020": 7.5,
  "200021": 5.8,
  "200100": 8.6,
  "200101": 7.4,
  "200110": 7.4,
  "200111": 6.1,
  "200120": 5.6,
  "200121": 3.4,
  "200200": 7,
  "200201": 5.4,
  "200210": 5.2,
  "200211": 4,
  "200220": 4,
  "200221": 2.2,
  "201000": 8.5,
  "201001": 7.5,
  "201010": 7.4,
  "201011": 5.5,
  "201020": 6.2,
  "201021": 5.1,
  "201100": 7.2,
  "201101": 5.7,
  "201110": 5.5,
  "201111": 4.1,
  "201120": 4.6,
  "201121": 1.9,
  "201200": 5.3,
  "201201": 3.6,
  "201210": 3.4,
  "201211": 1.9,
  "201220": 1.9,
  "201221": 0.8,
  "202001": 6.4,
  "202011": 5.1,
  "202021": 2,
  "202101": 4.7,
  "202111": 2.1,
  "202121": 1.1,
  "202201": 2.4,
  "202211": 0.9,
  "202221": 0.4,
  "210000": 8.8,
  "210001": 7.5,
  "210010": 7.3,
  "210011": 5.3,
  "210020": 6,
  "210021": 5,
  "210100": 7.3,
  "210101": 5.5,
  "210110": 5.9,
  "210111": 4,
  "210120": 4.1,
  "210121": 2,
  "210200": 5.4,
  "210201": 4.3,
  "210210": 4.5,
  "210211": 2.2,
  "210220": 2,
  "210221": 1.1,
  "211000": 7.5,
  "211001": 5.5,
  "211010": 5.8,
  "211011": 4.5,
  "211020": 4,
  "211021": 2.1,
  "211100": 6.1,
  "211101": 5.1,
  "211110": 4.8,
  "211111": 1.8,
  "211120": 2,
  "211121": 0.9,
  "211200": 4.6,
  "211201": 1.8,
  "211210": 1.7,
  "211211": 0.7,
  "211220": 0.8,
  "211221": 0.2,
  "212001": 5.3,
  "212011": 2.4,
  "212021": 1.4,
  "212101": 2.4,
  "212111": 1.2,
  "212121": 0.5,
  "212201": 1,
  "212211": 0.3,
  "212221": 0.1,
}

const MAX_COMPOSED: Record<string, Record<number, string[]>> = {
  eq1: {
    0: ["AV:N/PR:N/UI:N/"],
    1: ["AV:A/PR:N/UI:N/", "AV:N/PR:L/UI:N/", "AV:N/PR:N/UI:P/"],
    2: ["AV:P/PR:N/UI:N/", "AV:A/PR:L/UI:P/"],
  },
  eq2: {
    0: ["AC:L/AT:N/"],
    1: ["AC:H/AT:N/", "AC:L/AT:P/"],
  },
  eq4: {
    0: ["SC:H/SI:S/SA:S/"],
    1: ["SC:H/SI:H/SA:H/"],
    2: ["SC:L/SI:L/SA:L/"],
  },
  eq5: {
    0: ["E:A/"],
    1: ["E:P/"],
    2: ["E:U/"],
  },
}

const MAX_COMPOSED_EQ3_EQ6: Record<number, Record<number, string[]>> = {
  0: {
    0: ["VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/"],
    1: ["VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/", "VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/"],
  },
  1: {
    0: ["VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/", "VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/"],
    1: [
      "VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/",
      "VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/",
      "VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/",
      "VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/",
      "VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/",
    ],
  },
  2: {
    1: ["VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/"],
  },
}

const MAX_SEVERITY: Record<string, number[] | Record<number, Record<number, number>>> = {
  eq1: [1, 4, 5],
  eq2: [1, 2],
  eq3eq6: { 0: { 0: 7, 1: 6 }, 1: { 0: 8, 1: 8 }, 2: { 1: 10 } },
  eq4: [6, 5, 4],
  eq5: [1, 1, 1],
}

const AV_LEVELS: Record<string, number> = { N: 0.0, A: 0.1, L: 0.2, P: 0.3 }
const PR_LEVELS: Record<string, number> = { N: 0.0, L: 0.1, H: 0.2 }
const UI_LEVELS: Record<string, number> = { N: 0.0, P: 0.1, A: 0.2 }
const AC_LEVELS: Record<string, number> = { L: 0.0, H: 0.1 }
const AT_LEVELS: Record<string, number> = { N: 0.0, P: 0.1 }
const VC_LEVELS: Record<string, number> = { H: 0.0, L: 0.1, N: 0.2 }
const VI_LEVELS: Record<string, number> = { H: 0.0, L: 0.1, N: 0.2 }
const VA_LEVELS: Record<string, number> = { H: 0.0, L: 0.1, N: 0.2 }
const SC_LEVELS: Record<string, number> = { H: 0.1, L: 0.2, N: 0.3 }
const SI_LEVELS: Record<string, number> = { S: 0.0, H: 0.1, L: 0.2, N: 0.3 }
const SA_LEVELS: Record<string, number> = { S: 0.0, H: 0.1, L: 0.2, N: 0.3 }
const CR_LEVELS: Record<string, number> = { H: 0.0, M: 0.1, L: 0.2 }
const IR_LEVELS: Record<string, number> = { H: 0.0, M: 0.1, L: 0.2 }
const AR_LEVELS: Record<string, number> = { H: 0.0, M: 0.1, L: 0.2 }

function m(metrics: Metrics, metric: string): string {
  const selected = metrics[metric]
  // Default "X" values fall through to the worst-case per spec.
  if (metric === "E" && (selected === undefined || selected === "X")) return "A"
  if ((metric === "CR" || metric === "IR" || metric === "AR") && (selected === undefined || selected === "X"))
    return "H"
  return selected ?? "X"
}

function macroVector(metrics: Metrics): string {
  let eq1 = "0"
  if (m(metrics, "AV") === "N" && m(metrics, "PR") === "N" && m(metrics, "UI") === "N") eq1 = "0"
  else if (
    (m(metrics, "AV") === "N" || m(metrics, "PR") === "N" || m(metrics, "UI") === "N") &&
    !(m(metrics, "AV") === "N" && m(metrics, "PR") === "N" && m(metrics, "UI") === "N") &&
    m(metrics, "AV") !== "P"
  )
    eq1 = "1"
  else eq1 = "2"

  const eq2 = m(metrics, "AC") === "L" && m(metrics, "AT") === "N" ? "0" : "1"

  let eq3 = "2"
  if (m(metrics, "VC") === "H" && m(metrics, "VI") === "H") eq3 = "0"
  else if (m(metrics, "VC") === "H" || m(metrics, "VI") === "H" || m(metrics, "VA") === "H") eq3 = "1"

  let eq4 = "2"
  if (m(metrics, "MSI") === "S" || m(metrics, "MSA") === "S") eq4 = "0"
  else if (m(metrics, "SC") === "H" || m(metrics, "SI") === "H" || m(metrics, "SA") === "H") eq4 = "1"

  let eq5 = "2"
  if (m(metrics, "E") === "A") eq5 = "0"
  else if (m(metrics, "E") === "P") eq5 = "1"

  const eq6 =
    (m(metrics, "CR") === "H" && m(metrics, "VC") === "H") ||
    (m(metrics, "IR") === "H" && m(metrics, "VI") === "H") ||
    (m(metrics, "AR") === "H" && m(metrics, "VA") === "H")
      ? "0"
      : "1"

  return eq1 + eq2 + eq3 + eq4 + eq5 + eq6
}

function extractValueMetric(metric: string, str: string): string {
  const idx = str.indexOf(metric)
  if (idx < 0) return ""
  const tail = str.slice(idx + metric.length + 1)
  const slash = tail.indexOf("/")
  return slash >= 0 ? tail.slice(0, slash) : tail
}

function computeCvssV4(vector: string): number | null {
  if (!/^CVSS:4\.0\//i.test(vector)) return null
  const metrics = parseVector(vector)
  if (!metrics) return null
  for (const required of ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"]) {
    if (!metrics[required]) return null
  }

  // Shortcut: all impact metrics N → score 0
  if (["VC", "VI", "VA", "SC", "SI", "SA"].every((k) => m(metrics, k) === "N")) return 0

  const mv = macroVector(metrics)
  const value = CVSS_LOOKUP_GLOBAL[mv]
  if (value === undefined) return null

  const [eq1, eq2, eq3, eq4, eq5, eq6] = mv.split("").map((d) => parseInt(d, 10)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]

  // Next-lower macrovectors per EQ
  const eq1Next = `${eq1 + 1}${eq2}${eq3}${eq4}${eq5}${eq6}`
  const eq2Next = `${eq1}${eq2 + 1}${eq3}${eq4}${eq5}${eq6}`

  let eq3eq6NextScore: number | undefined
  if (eq3 === 1 && eq6 === 1) eq3eq6NextScore = CVSS_LOOKUP_GLOBAL[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6}`]
  else if (eq3 === 0 && eq6 === 1) eq3eq6NextScore = CVSS_LOOKUP_GLOBAL[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6}`]
  else if (eq3 === 1 && eq6 === 0) eq3eq6NextScore = CVSS_LOOKUP_GLOBAL[`${eq1}${eq2}${eq3}${eq4}${eq5}${eq6 + 1}`]
  else if (eq3 === 0 && eq6 === 0) {
    const left = CVSS_LOOKUP_GLOBAL[`${eq1}${eq2}${eq3}${eq4}${eq5}${eq6 + 1}`]
    const right = CVSS_LOOKUP_GLOBAL[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6}`]
    if (left !== undefined && right !== undefined) eq3eq6NextScore = Math.max(left, right)
    else eq3eq6NextScore = left ?? right
  } else {
    eq3eq6NextScore = CVSS_LOOKUP_GLOBAL[`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6 + 1}`]
  }

  const eq4Next = `${eq1}${eq2}${eq3}${eq4 + 1}${eq5}${eq6}`
  const eq5Next = `${eq1}${eq2}${eq3}${eq4}${eq5 + 1}${eq6}`

  const eq1NextScore = CVSS_LOOKUP_GLOBAL[eq1Next]
  const eq2NextScore = CVSS_LOOKUP_GLOBAL[eq2Next]
  const eq4NextScore = CVSS_LOOKUP_GLOBAL[eq4Next]
  const eq5NextScore = CVSS_LOOKUP_GLOBAL[eq5Next]

  // Build candidate "max" vectors for this bucket by combining EQ1/EQ2/EQ3-6/EQ4/EQ5 entries.
  const eq1Maxes = MAX_COMPOSED.eq1![eq1]!
  const eq2Maxes = MAX_COMPOSED.eq2![eq2]!
  const eq3eq6Maxes = MAX_COMPOSED_EQ3_EQ6[eq3]?.[eq6] ?? []
  const eq4Maxes = MAX_COMPOSED.eq4![eq4]!
  const eq5Maxes = MAX_COMPOSED.eq5![eq5]!

  const maxVectors: string[] = []
  for (const a of eq1Maxes)
    for (const b of eq2Maxes)
      for (const c of eq3eq6Maxes)
        for (const d of eq4Maxes)
          for (const e of eq5Maxes) {
            maxVectors.push(a + b + c + d + e)
          }

  // Find the max vector whose severity distance is entirely non-negative.
  let dAV = 0,
    dPR = 0,
    dUI = 0,
    dAC = 0,
    dAT = 0,
    dVC = 0,
    dVI = 0,
    dVA = 0
  let dSC = 0,
    dSI = 0,
    dSA = 0,
    dCR = 0,
    dIR = 0,
    dAR = 0
  let found = false
  for (const maxVector of maxVectors) {
    const sAV = (AV_LEVELS[m(metrics, "AV")] ?? 0) - (AV_LEVELS[extractValueMetric("AV", maxVector)] ?? 0)
    const sPR = (PR_LEVELS[m(metrics, "PR")] ?? 0) - (PR_LEVELS[extractValueMetric("PR", maxVector)] ?? 0)
    const sUI = (UI_LEVELS[m(metrics, "UI")] ?? 0) - (UI_LEVELS[extractValueMetric("UI", maxVector)] ?? 0)
    const sAC = (AC_LEVELS[m(metrics, "AC")] ?? 0) - (AC_LEVELS[extractValueMetric("AC", maxVector)] ?? 0)
    const sAT = (AT_LEVELS[m(metrics, "AT")] ?? 0) - (AT_LEVELS[extractValueMetric("AT", maxVector)] ?? 0)
    const sVC = (VC_LEVELS[m(metrics, "VC")] ?? 0) - (VC_LEVELS[extractValueMetric("VC", maxVector)] ?? 0)
    const sVI = (VI_LEVELS[m(metrics, "VI")] ?? 0) - (VI_LEVELS[extractValueMetric("VI", maxVector)] ?? 0)
    const sVA = (VA_LEVELS[m(metrics, "VA")] ?? 0) - (VA_LEVELS[extractValueMetric("VA", maxVector)] ?? 0)
    const sSC = (SC_LEVELS[m(metrics, "SC")] ?? 0) - (SC_LEVELS[extractValueMetric("SC", maxVector)] ?? 0)
    const sSI = (SI_LEVELS[m(metrics, "SI")] ?? 0) - (SI_LEVELS[extractValueMetric("SI", maxVector)] ?? 0)
    const sSA = (SA_LEVELS[m(metrics, "SA")] ?? 0) - (SA_LEVELS[extractValueMetric("SA", maxVector)] ?? 0)
    const sCR = (CR_LEVELS[m(metrics, "CR")] ?? 0) - (CR_LEVELS[extractValueMetric("CR", maxVector)] ?? 0)
    const sIR = (IR_LEVELS[m(metrics, "IR")] ?? 0) - (IR_LEVELS[extractValueMetric("IR", maxVector)] ?? 0)
    const sAR = (AR_LEVELS[m(metrics, "AR")] ?? 0) - (AR_LEVELS[extractValueMetric("AR", maxVector)] ?? 0)

    const distances = [sAV, sPR, sUI, sAC, sAT, sVC, sVI, sVA, sSC, sSI, sSA, sCR, sIR, sAR]
    if (distances.some((d) => d < 0)) continue

    dAV = sAV
    dPR = sPR
    dUI = sUI
    dAC = sAC
    dAT = sAT
    dVC = sVC
    dVI = sVI
    dVA = sVA
    dSC = sSC
    dSI = sSI
    dSA = sSA
    dCR = sCR
    dIR = sIR
    dAR = sAR
    found = true
    break
  }
  if (!found) return Math.round(value * 10) / 10

  const currentSevEq1 = dAV + dPR + dUI
  const currentSevEq2 = dAC + dAT
  const currentSevEq3eq6 = dVC + dVI + dVA + dCR + dIR + dAR
  const currentSevEq4 = dSC + dSI + dSA

  const step = 0.1
  const maxSevEq1 = ((MAX_SEVERITY.eq1 as number[])[eq1] ?? 1) * step
  const maxSevEq2 = ((MAX_SEVERITY.eq2 as number[])[eq2] ?? 1) * step
  const maxSevEq3eq6 = ((MAX_SEVERITY.eq3eq6 as Record<number, Record<number, number>>)[eq3]?.[eq6] ?? 1) * step
  const maxSevEq4 = ((MAX_SEVERITY.eq4 as number[])[eq4] ?? 1) * step

  const availEq1 = eq1NextScore !== undefined ? value - eq1NextScore : NaN
  const availEq2 = eq2NextScore !== undefined ? value - eq2NextScore : NaN
  const availEq3eq6 = eq3eq6NextScore !== undefined ? value - eq3eq6NextScore : NaN
  const availEq4 = eq4NextScore !== undefined ? value - eq4NextScore : NaN
  const availEq5 = eq5NextScore !== undefined ? value - eq5NextScore : NaN

  let n = 0
  let sum = 0
  if (!Number.isNaN(availEq1)) {
    n++
    sum += availEq1 * (currentSevEq1 / maxSevEq1)
  }
  if (!Number.isNaN(availEq2)) {
    n++
    sum += availEq2 * (currentSevEq2 / maxSevEq2)
  }
  if (!Number.isNaN(availEq3eq6)) {
    n++
    sum += availEq3eq6 * (currentSevEq3eq6 / maxSevEq3eq6)
  }
  if (!Number.isNaN(availEq4)) {
    n++
    sum += availEq4 * (currentSevEq4 / maxSevEq4)
  }
  // eq5 contributes distance 0 (per spec)
  if (!Number.isNaN(availEq5)) {
    n++
  }

  const meanDistance = n === 0 ? 0 : sum / n
  let score = value - meanDistance
  if (score < 0) score = 0
  if (score > 10) score = 10
  return Math.round(score * 10) / 10
}

// ---------- Public entry point ----------

export function computeCvssScore(vector: string): number | null {
  if (/^CVSS:4\./i.test(vector)) return computeCvssV4(vector)
  if (/^CVSS:3\./i.test(vector)) return computeCvssV3(vector)
  return null
}
