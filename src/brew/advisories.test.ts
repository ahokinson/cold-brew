import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { fetchAdvisoriesBatch } from "@brew/advisories"
import { resetEpssFetcher, setEpssFetcher } from "@brew/epss"
import { resetKevFetcher, setKevFetcher } from "@brew/kev"
import { Package } from "@brew/types"
import { resetDb } from "@db"

const realFetch = globalThis.fetch

beforeEach(() => {
  resetDb()
  // Don't carry a GHSA token into tests — the GHSA branch is exercised
  // explicitly below by setting GITHUB_TOKEN inside the test.
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  // Default to empty catalogs so existing tests don't see surprise
  // enrichment. The KEV/EPSS-specific tests below override these.
  setKevFetcher(async () => [])
  setEpssFetcher(async () => new Map())
})

afterEach(() => {
  globalThis.fetch = realFetch
  resetKevFetcher()
  resetEpssFetcher()
})

function fakeResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    headers: new Headers(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as Response
}

function pkg(overrides: Partial<Package.Info> = {}): Package.Info {
  return {
    name: "demo",
    installedVersion: "1.0.0",
    latestVersion: "1.1.0",
    installedAt: 0,
    sourceModifiedAt: 0,
    isLeaf: true,
    installedAsDependency: false,
    installedOnRequest: true,
    pinned: false,
    outdated: true,
    needsRelink: false,
    tap: "homebrew/core",
    originTap: "homebrew/core",
    trusted: true,
    description: null,
    isCask: false,
    dateConfidence: Package.DateConfidence.Authoritative,
    homepage: null,
    ...overrides,
  }
}

describe("fetchAdvisoriesBatch", () => {
  test("skips packages that aren't outdated or have no latestVersion", async () => {
    let calls = 0
    globalThis.fetch = mock(async () => {
      calls++
      return fakeResponse({ results: [] })
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([
      pkg({ outdated: false }),
      pkg({ name: "no-latest", latestVersion: null }),
    ])
    expect(result.size).toBe(0)
    expect(calls).toBe(0)
  })

  test("returns empty summary for package with no vulns", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [] }] })
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    expect(summary.entries).toEqual([])
    expect(summary.maxCvss).toBeNull()
    expect(summary.hasActionableFix).toBe(false)
  })

  test("translates OSV vuln to a vulnerability entry with CVSS, fixedIn, fixInLatest", async () => {
    const osvVuln = {
      id: "GHSA-aaaa",
      aliases: ["CVE-2024-0001"],
      summary: "Heap overflow",
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
      references: [{ type: "ADVISORY", url: "https://example/CVE-2024-0001" }],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: osvVuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(osvVuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    expect(summary.entries.length).toBe(1)
    const entry = summary.entries[0]!
    expect(entry.id).toBe("CVE-2024-0001")
    expect(entry.kind).toBe("vulnerability")
    expect(entry.severity).toBe("critical")
    expect(entry.fixedIn).toBe("1.0.5")
    expect(entry.fixInLatest).toBe(true)
    expect(entry.url).toContain("CVE-2024-0001")
    expect(summary.maxCvss).toBeGreaterThan(9)
    expect(summary.hasActionableFix).toBe(true)
  })

  test("MAL- entries without a CVE alias become typosquats and never gate auto-bypass", async () => {
    const mal = {
      id: "MAL-2024-1",
      summary: "Suspicious package",
      affected: [{ package: { name: "demo", ecosystem: "npm" } }],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: mal.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(mal)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    expect(summary.entries[0]!.kind).toBe("typosquat")
    expect(summary.entries[0]!.severity).toBe("unknown")
    expect(summary.hasActionableFix).toBe(false)
  })

  test("distro-ecosystem entries (Debian, Ubuntu...) are filtered out", async () => {
    const debianOnly = {
      id: "OSV-DEB-1",
      summary: "Debian-only patch",
      affected: [
        {
          package: { name: "demo", ecosystem: "Debian:11" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: debianOnly.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(debianOnly)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")!.entries).toEqual([])
  })

  test("explicit versions[] match counts as a hit", async () => {
    const vuln = {
      id: "OSV-1",
      summary: "Pinned to 1.0.0",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          versions: ["1.0.0"],
          ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")!.entries[0]!.fixedIn).toBe("1.0.1")
  })

  test("OSV batch failure: package excluded from cache so next run can retry", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({}, { ok: false, status: 500 })
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    // empty summary but no entries
    expect(result.get("demo")!.entries).toEqual([])
    // running again should re-hit the API rather than serve a stale empty
    let secondCallCount = 0
    globalThis.fetch = mock(async (url: string) => {
      secondCallCount++
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [] }] })
      return fakeResponse({})
    }) as unknown as typeof fetch
    await fetchAdvisoriesBatch([pkg()])
    expect(secondCallCount).toBeGreaterThan(0)
  })

  test("range with last_affected and no fix → hit, fixedIn null", async () => {
    const vuln = {
      id: "OSV-LA",
      summary: "Up to 1.0.5",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { last_affected: "1.0.5" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")!.entries[0]?.fixedIn).toBeNull()
    expect(result.get("demo")!.entries[0]?.kind).toBe("vulnerability")
  })

  test("cache hit on second call skips network", async () => {
    const vuln = {
      id: "CVE-2024-9999",
      aliases: ["CVE-2024-9999"],
      summary: "x",
      severity: [{ type: "CVSS_V3", score: "5.0" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }],
        },
      ],
      references: [],
    }
    let firstRunCalls = 0
    globalThis.fetch = mock(async (url: string) => {
      firstRunCalls++
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    await fetchAdvisoriesBatch([pkg()])
    expect(firstRunCalls).toBeGreaterThan(0)

    let secondRunCalls = 0
    globalThis.fetch = mock(async () => {
      secondRunCalls++
      return fakeResponse({})
    }) as unknown as typeof fetch
    const second = await fetchAdvisoriesBatch([pkg()])
    expect(secondRunCalls).toBe(0)
    expect(second.get("demo")?.entries[0]?.id).toBe("CVE-2024-9999")
  })

  test("plain numeric CVSS score (not vector) is accepted directly", async () => {
    const vuln = {
      id: "CVE-2024-NUMERIC",
      aliases: ["CVE-2024-NUMERIC"],
      summary: "x",
      severity: [{ type: "CVSS_V3", score: "7.5" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")?.entries[0]?.cvss).toBe(7.5)
  })

  test("v4 CVSS preferred over v3 when both present", async () => {
    const vuln = {
      id: "CVE-2024-V4",
      aliases: ["CVE-2024-V4"],
      summary: "x",
      severity: [
        { type: "CVSS_V3", score: "5.0" },
        { type: "CVSS_V4", score: "9.0" },
      ],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")?.entries[0]?.cvss).toBe(9.0)
  })

  test("CVSS vector string (not numeric) parses via computeCvssScore", async () => {
    const vuln = {
      id: "CVE-2024-VEC",
      aliases: ["CVE-2024-VEC"],
      summary: "x",
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")?.entries[0]?.cvss).toBeCloseTo(9.8, 1)
  })

  test("non-SEMVER/ECOSYSTEM range type → no hit (e.g. GIT)", async () => {
    const vuln = {
      id: "OSV-GIT",
      summary: "Git range",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "GIT", events: [{ introduced: "0" }, { fixed: "abcd1234" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")?.entries).toEqual([])
  })

  test("introduced-only range (no fix, no last_affected) hits when installed >= introduced", async () => {
    const vuln = {
      id: "OSV-INTR",
      aliases: ["CVE-2024-INTR"],
      summary: "Vuln from 0.5 onward",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0.5" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg({ installedVersion: "1.0.0" })])
    const entry = result.get("demo")?.entries[0]
    expect(entry).toBeDefined()
    expect(entry!.fixedIn).toBeNull()
  })

  test("introduced-then-fixed where installed >= fixed → not a hit (introduced gets reset)", async () => {
    // Demonstrates the `introduced = null` reset after a fixed event in
    // rangeIncludesVersion. Without the reset, a subsequent introduced-only
    // range tail would re-hit incorrectly.
    const vuln = {
      id: "OSV-RESET",
      aliases: ["CVE-2024-RST"],
      summary: "Patched in 1.0.0",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [
            {
              type: "ECOSYSTEM",
              events: [{ introduced: "0" }, { fixed: "1.0.0" }],
            },
          ],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg({ installedVersion: "1.0.0" })])
    expect(result.get("demo")?.entries).toEqual([]) // installed === fixed → not vulnerable
  })

  test("last_affected branch resets introduced when no match", async () => {
    const vuln = {
      id: "OSV-LARESET",
      aliases: ["CVE-2024-LAR"],
      summary: "Limited range",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          // First range covers older versions; second introduced applies after.
          ranges: [
            {
              type: "ECOSYSTEM",
              events: [{ introduced: "0" }, { last_affected: "0.5" }, { introduced: "2.0" }],
            },
          ],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg({ installedVersion: "1.0.0" })])
    // installed=1.0.0: not <=0.5, not >=2.0 → no hit
    expect(result.get("demo")?.entries).toEqual([])
  })

  test("OSV vuln detail fetch failure: ids dropped silently", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: "OSV-MISS" }] }] })
      if (url.includes("/vulns/")) return fakeResponse(null, { ok: false, status: 500 })
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")?.entries).toEqual([])
  })

  test("severity present but no V3/V4 entries → cvss null, severity 'unknown'", async () => {
    const vuln = {
      id: "OSV-V2ONLY",
      aliases: ["CVE-2024-V2"],
      summary: "Old-style scoring",
      severity: [
        { type: "CVSS_V2", score: "5.0" },
        { type: "CVSS_V3", score: "garbage" },
      ],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: vuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(vuln)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    expect(result.get("demo")?.entries[0]?.cvss).toBeNull()
    expect(result.get("demo")?.entries[0]?.severity).toBe("unknown")
  })

  test("GHSA fetched when GITHUB_TOKEN is set; merges with OSV", async () => {
    process.env.GITHUB_TOKEN = "test-token"
    const ghsa = [
      {
        ghsa_id: "GHSA-xxxx",
        cve_id: "CVE-2024-GHSA",
        summary: "GHSA summary",
        severity: "high",
        cvss: { score: 8.1, vector_string: null },
        cvss_severities: { cvss_v3: { score: 8.1 } },
        html_url: "https://github.com/advisories/GHSA-xxxx",
        vulnerabilities: [
          {
            package: { ecosystem: "pip", name: "demo" },
            patched_versions: "1.1.0",
            vulnerable_version_range: "< 1.1.0",
          },
        ],
      },
    ]
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [] }] })
      if (url.includes("api.github.com/advisories")) return fakeResponse(ghsa)
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg({ homepage: "https://github.com/demo/demo" })])
    const summary = result.get("demo")!
    expect(summary.entries[0]?.id).toBe("CVE-2024-GHSA")
    expect(summary.entries[0]?.source).toBe("ghsa")
    expect(summary.maxCvss).toBe(8.1)
  })

  test("two equal-CVSS vulnerabilities sort by severity rank (tiebreaker)", async () => {
    // Both entries get cvss=null (no V3/V4 severity), differing only by their
    // severity rank — exercises the rank tiebreaker in mergeAdvisoryEntries.
    const v1 = {
      id: "MAL-CVE-1",
      aliases: ["CVE-2024-MAL"],
      summary: "Malware with CVE alias → critical regardless of CVSS",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0" }] }],
        },
      ],
      references: [],
    }
    const v2 = {
      id: "OSV-PLAIN",
      aliases: ["CVE-2024-PLAIN"],
      summary: "Plain vuln, no CVSS → unknown",
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0" }] }],
        },
      ],
      references: [],
    }
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: v1.id }, { id: v2.id }] }] })
      if (url.includes("/vulns/")) {
        const id = url.split("/vulns/").pop()!
        return fakeResponse(id === v1.id ? v1 : v2)
      }
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg()])
    const entries = result.get("demo")!.entries
    expect(entries.length).toBe(2)
    // v1 has critical severity (MAL- with CVE alias path); v2 has unknown.
    // Both have null cvss, so tiebreaker by severity rank places critical first.
    expect(entries[0]!.severity).toBe("critical")
    expect(entries[1]!.severity).toBe("unknown")
  })

  test("GHSA fetch failure returns empty entries (no crash)", async () => {
    process.env.GITHUB_TOKEN = "test-token"
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [] }] })
      if (url.includes("api.github.com/advisories")) return fakeResponse(null, { ok: false, status: 500 })
      return fakeResponse({})
    }) as unknown as typeof fetch
    const result = await fetchAdvisoriesBatch([pkg({ homepage: "https://github.com/demo/demo" })])
    expect(result.get("demo")?.entries).toEqual([])
  })

  test("GHSA path skipped when homepage isn't GitHub (no override match)", async () => {
    process.env.GITHUB_TOKEN = "test-token"
    let ghsaCalls = 0
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [] }] })
      if (url.includes("api.github.com/advisories")) {
        ghsaCalls++
        return fakeResponse([])
      }
      return fakeResponse({})
    }) as unknown as typeof fetch
    await fetchAdvisoriesBatch([pkg({ name: "rare-pkg", homepage: "https://example.com/no-github" })])
    expect(ghsaCalls).toBe(0)
  })

  test("KEV-listed CVE marks entry.kev and summary.hasKevListed", async () => {
    const osvVuln = {
      id: "GHSA-bbbb",
      aliases: ["CVE-2024-9999"],
      summary: "Actively exploited bug",
      severity: [{ type: "CVSS_V3", score: "5.0" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
      references: [{ type: "ADVISORY", url: "https://example/CVE-2024-9999" }],
    }
    setKevFetcher(async () => ["CVE-2024-9999"])
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: osvVuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(osvVuln)
      return fakeResponse({})
    }) as unknown as typeof fetch

    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    expect(summary.entries[0]?.kev).toBe(true)
    expect(summary.hasKevListed).toBe(true)
  })

  test("non-KEV CVEs remain kev=false and hasKevListed stays false", async () => {
    const osvVuln = {
      id: "CVE-2024-0001",
      summary: "Unrelated bug",
      severity: [{ type: "CVSS_V3", score: "5.0" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
    }
    setKevFetcher(async () => ["CVE-2999-0000"]) // KEV set doesn't include this CVE
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: osvVuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(osvVuln)
      return fakeResponse({})
    }) as unknown as typeof fetch

    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    expect(summary.entries[0]?.kev).toBe(false)
    expect(summary.hasKevListed).toBe(false)
  })

  test("EPSS scores stamped on entries and propagated to summary.maxEpss", async () => {
    const osvVulnA = {
      id: "CVE-2024-1001",
      summary: "high probability bug",
      severity: [{ type: "CVSS_V3", score: "5.0" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
    }
    const osvVulnB = {
      id: "CVE-2024-1002",
      summary: "low probability bug",
      severity: [{ type: "CVSS_V3", score: "5.0" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
    }
    setEpssFetcher(async (ids) => {
      const out = new Map<string, { score: number; percentile: number }>()
      if (ids.includes("CVE-2024-1001")) out.set("CVE-2024-1001", { score: 0.82, percentile: 0.97 })
      if (ids.includes("CVE-2024-1002")) out.set("CVE-2024-1002", { score: 0.01, percentile: 0.2 })
      return out
    })
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) {
        return fakeResponse({ results: [{ vulns: [{ id: osvVulnA.id }, { id: osvVulnB.id }] }] })
      }
      if (url.includes(osvVulnA.id)) return fakeResponse(osvVulnA)
      if (url.includes(osvVulnB.id)) return fakeResponse(osvVulnB)
      return fakeResponse({})
    }) as unknown as typeof fetch

    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    const byId = new Map(summary.entries.map((e) => [e.id, e]))
    expect(byId.get("CVE-2024-1001")?.epss).toBeCloseTo(0.82, 4)
    expect(byId.get("CVE-2024-1002")?.epss).toBeCloseTo(0.01, 4)
    expect(summary.maxEpss).toBeCloseTo(0.82, 4)
  })

  test("EPSS unscored CVEs stay null and don't break the summary", async () => {
    const osvVuln = {
      id: "CVE-2024-2000",
      summary: "unscored",
      severity: [{ type: "CVSS_V3", score: "5.0" }],
      affected: [
        {
          package: { name: "demo", ecosystem: "Homebrew" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.5" }] }],
        },
      ],
    }
    setEpssFetcher(async () => new Map())
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("querybatch")) return fakeResponse({ results: [{ vulns: [{ id: osvVuln.id }] }] })
      if (url.includes("/vulns/")) return fakeResponse(osvVuln)
      return fakeResponse({})
    }) as unknown as typeof fetch

    const result = await fetchAdvisoriesBatch([pkg()])
    const summary = result.get("demo")!
    expect(summary.entries[0]?.epss).toBeNull()
    expect(summary.maxEpss).toBeNull()
  })
})
