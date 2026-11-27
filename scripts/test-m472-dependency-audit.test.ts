/**
 * M47.2-B — COMPLETE dependency-instance audit tests.
 *
 * These fail if nested production instances disappear from the audit again
 * (the M47.1 generator skipped them), if distinct versions of the same
 * package are collapsed into one component, or if the SBOM violates the
 * CycloneDX structural contract.
 *
 * Run: bun test scripts/test-m472-dependency-audit.test.ts
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";

const AUDIT = JSON.parse(fs.readFileSync("docs/legal/generated/dependency-audit.json", "utf8")) as {
  counts: Record<string, number>;
  npmPackages: Array<Record<string, unknown>>;
  devPackages: Array<Record<string, unknown>>;
  systemAndFonts: Array<Record<string, unknown>>;
};
const SBOM = JSON.parse(fs.readFileSync("docs/legal/sbom.cdx.json", "utf8")) as {
  bomFormat: string; specVersion: string; serialNumber: string; components: Array<Record<string, unknown>>;
};
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version?: string; dev?: boolean }> };

const prod = AUDIT.npmPackages as Array<{ name: string; version: string; lockfilePath: string; bomRef: string; purl: string; scope: string; nesting: string; license: string | null; licenseSource: string | null; classification: string; environment: string }>;
const dev = AUDIT.devPackages as typeof prod;

describe("instance enumeration — the complete installed set", () => {
  test("every non-dev lockfile path appears exactly once as a production instance", () => {
    const lockProdPaths = Object.entries(lock.packages)
      .filter(([k, v]) => k.startsWith("node_modules/") && v.dev !== true)
      .map(([k]) => k);
    const auditPaths = prod.map((i) => i.lockfilePath).sort();
    expect(auditPaths).toEqual([...lockProdPaths].sort());
    expect(new Set(auditPaths).size).toBe(auditPaths.length); // no duplicates
  });

  test("dev-only lockfile paths appear exactly once in devPackages", () => {
    const lockDevPaths = Object.entries(lock.packages)
      .filter(([k, v]) => k.startsWith("node_modules/") && v.dev === true)
      .map(([k]) => k);
    expect(dev.map((i) => i.lockfilePath).sort()).toEqual([...lockDevPaths].sort());
  });

  test("nested production instances are enumerated (the M47.1 gap is closed)", () => {
    const nested = prod.filter((i) => i.nesting === "nested");
    expect(nested.length).toBeGreaterThan(0);
    // A real nested production instance with a version differing from top level.
    const reactIs17 = prod.find((i) => i.name === "react-is" && i.version === "17.0.2");
    expect(reactIs17).toBeDefined();
    expect(reactIs17!.lockfilePath).toContain("node_modules/react-is");
    // And its top-level counterpart with a DIFFERENT version coexists.
    expect(prod.some((i) => i.name === "react-is" && i.version !== "17.0.2")).toBe(true);
  });

  test("nested instances whose version differs from top level are counted as their own", () => {
    const differing = prod.filter((i) => {
      if (i.nesting !== "nested") return false;
      const top = prod.find((x) => x.name === i.name && x.nesting === "top-level");
      return top ? top.version !== i.version : true;
    });
    expect(differing.length).toBe(AUDIT.counts.nestedVersionInstancesDifferingFromTopLevel);
    expect(differing.length).toBeGreaterThan(0);
  });

  test("distinct versions of the same package are NOT collapsed", () => {
    for (const name of ["@radix-ui/react-slot", "@radix-ui/react-context", "@radix-ui/react-primitive", "@formatjs/intl-localematcher"]) {
      const versions = new Set(prod.filter((i) => i.name === name).map((i) => i.version));
      expect(versions.size).toBeGreaterThan(1);
      // Each instance keeps its own install path + bom-ref.
      const paths = prod.filter((i) => i.name === name).map((i) => i.lockfilePath);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  test("declared-but-uninstalled dependencies are flagged (install-state integrity)", () => {
    // nodemailer@^10.6.0 is declared in package.json but has NO lockfile entry —
    // npm ci fails; the audit must surface this, never hide it.
    expect(AUDIT.counts.declaredButNotInLockfile).toContain("nodemailer");
  });

  test("counts block reconciles with the enumerated arrays", () => {
    expect(AUDIT.counts.productionInstances).toBe(prod.length);
    expect(AUDIT.counts.developmentInstances).toBe(dev.length);
    expect(AUDIT.counts.lockfileEntries).toBe(prod.length + dev.length);
    expect(AUDIT.counts.uniqueProductionPackageNames).toBe(new Set(prod.map((i) => i.name)).size);
    expect(AUDIT.counts.uniqueProductionVersions).toBe(new Set(prod.map((i) => `${i.name}@${i.version}`)).size);
    expect(AUDIT.counts.nestedProductionInstances).toBe(prod.filter((i) => i.nesting === "nested").length);
  });

  test("every direct production dependency that IS in the lockfile has a top-level production instance", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    const notInLockfile = new Set(AUDIT.counts.declaredButNotInLockfile as string[]);
    for (const name of Object.keys(pkg.dependencies)) {
      if (notInLockfile.has(name)) continue; // flagged separately above
      expect(prod.some((i) => i.name === name && i.nesting === "top-level" && i.scope === "direct")).toBe(true);
    }
  });

  test("license evidence is sourced, never invented — unresolved stays UNRESOLVED", () => {
    for (const i of [...prod, ...dev]) {
      if (i.license === null) {
        expect(i.classification).toBe("UNKNOWN");
        expect(i.licenseSource).toBe("unresolved");
      } else {
        expect(typeof i.license).toBe("string");
        expect(["installed-package", "npm-registry", "unresolved", "skipped-registry"]).toContain(i.licenseSource);
      }
    }
  });

  test("system components assessed separately (FFmpeg GPL build flagged, gateway SDK excluded)", () => {
    const ffmpeg = AUDIT.systemAndFonts.find((s) => s.name === "FFmpeg (Debian build)");
    expect(ffmpeg?.classification).toBe("COPYLEFT-STRONG");
    const sdk = AUDIT.systemAndFonts.find((s) => s.name === "z-ai gateway SDK");
    expect(String(sdk?.license)).toMatch(/UNASSESSED/);
  });
});

describe("CycloneDX SBOM — one component per instance, structural validity", () => {
  test("header contract", () => {
    expect(SBOM.bomFormat).toBe("CycloneDX");
    expect(SBOM.specVersion).toBe("1.5");
    expect(SBOM.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
  });

  test("component count == production + development instances (nothing omitted)", () => {
    expect(SBOM.components.length).toBe(prod.length + dev.length);
  });

  test("every component has a unique bom-ref and a well-formed purl", () => {
    const refs = SBOM.components.map((c) => c["bom-ref"] as string);
    expect(new Set(refs).size).toBe(refs.length);
    for (const c of SBOM.components) {
      expect(String(c.purl)).toMatch(/^pkg:npm\/.+@[^@]+$/); // scoped names carry @name — the LAST @ separates the version
      expect(["required", "optional", "excluded"]).toContain(String(c.scope));
      expect(c.name).toBeTruthy();
      expect(c.version).toBeTruthy();
    }
  });

  test("dev instances carry scope 'excluded' — separated, not omitted", () => {
    const devRefs = new Set(dev.map((i) => i.bomRef));
    const excluded = SBOM.components.filter((c) => c.scope === "excluded");
    expect(excluded.length).toBe(dev.length);
    for (const c of excluded) expect(devRefs.has(c["bom-ref"] as string)).toBe(true);
  });

  test("distinct versions keep distinct purls; same-version instances share the purl but never the bom-ref", () => {
    const reactIs = SBOM.components.filter((c) => c.name === "react-is");
    expect(reactIs.length).toBeGreaterThan(1);
    const purls = new Set(reactIs.map((c) => c.purl as string));
    // 18.3.1 (top level) and 17.0.2 (nested under sandpack) — at least 2 distinct purls.
    expect(purls.size).toBeGreaterThan(1);
    const refs = new Set(reactIs.map((c) => c["bom-ref"] as string));
    expect(refs.size).toBe(reactIs.length); // every INSTANCE uniquely referenced
  });

  test("lockfile-path properties preserve the instance identity in the SBOM", () => {
    const c = SBOM.components.find((x) => (x["bom-ref"] as string).includes("codesandbox/sandpack-react/node_modules/react-is"));
    expect(c).toBeDefined();
    const props = (c!.properties as Array<{ name: string; value: string }>);
    expect(props.find((p) => p.name === "beanfx:nesting")?.value).toBe("nested");
    expect(props.find((p) => p.name === "beanfx:license-evidence")?.value).toBeTruthy();
  });
});
