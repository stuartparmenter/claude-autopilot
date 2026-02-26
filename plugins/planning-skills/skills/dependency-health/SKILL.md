---
name: Dependency Health
description: Use when assessing dependency health. Covers CVE checking, abandoned packages, version pinning, license compliance, and supply chain security.
user-invocable: false
---

# Dependency Health Checklist

When assessing a project's dependency health, investigate each of these areas. Report specific package names, versions, and actionable findings — not generic advice.

## Known Vulnerabilities (CVEs)

- Run `npm audit` / `bun audit` / `pip audit` / equivalent for the project's package manager
- Check for critical and high severity vulnerabilities
- Identify whether vulnerable code paths are actually reachable in the project
- Check for CVEs in transitive (indirect) dependencies

**What to look for:** Output of audit commands, packages with known CVEs, whether the vulnerable functionality is actually used.

## Abandoned or Unmaintained Packages

- Packages with no commits in 2+ years
- Packages with no npm/PyPI releases in 2+ years
- Packages with open critical issues and no maintainer response
- Packages with deprecated warnings
- Single-maintainer packages for critical functionality

**What to look for:** Last publish dates, GitHub activity, open issue counts, deprecation notices in package metadata.

## Version Pinning and Lock Files

- Missing lock file (package-lock.json, bun.lock, yarn.lock, poetry.lock)
- Lock file not committed to version control
- Using loose version ranges (`*`, `>=`, `>`) instead of pinned or caret ranges
- Mismatch between lock file and manifest (outdated lock)

**What to look for:** Missing lock files in git, `"*"` or `">="` in version specifications, `.gitignore` entries that exclude lock files.

## Dependency Bloat

- Large dependencies used for trivial functionality (e.g., lodash for a single function)
- Multiple packages providing the same functionality (e.g., both axios and node-fetch)
- Dev dependencies accidentally in production dependencies
- Unused dependencies still listed in manifest

**What to look for:** Bundle size analysis, duplicate functionality across packages, `devDependencies` vs `dependencies` classification, imports that don't match any installed package.

## Supply Chain Security

- Dependencies pulling from non-standard registries
- Post-install scripts that execute arbitrary code
- Dependencies with typosquat-similar names
- Missing integrity hashes in lock files

**What to look for:** Custom registry URLs in `.npmrc` or similar, `postinstall` scripts in dependencies, package names that are slight misspellings of popular packages.

## License Compliance

- Dependencies with copyleft licenses (GPL, AGPL) in proprietary projects
- License conflicts between dependencies
- Dependencies with no license specified (legally ambiguous)
- License changes between versions

**What to look for:** `license` fields in package.json of dependencies, AGPL/GPL packages in commercial projects, packages missing license files.

## Update Strategy

- Major version updates available (potential breaking changes to evaluate)
- Security patches available but not applied
- Missing automated dependency update tooling (Dependabot, Renovate)
- Outdated CI that doesn't test with updated dependencies

**What to look for:** Version comparison between installed and latest, missing `.github/dependabot.yml` or `renovate.json`, CI configuration that pins old dependency versions.

## Reporting Guidelines

For each finding:
1. Specify the exact package name and version
2. Classify severity: Critical (exploitable CVE), High (abandoned critical dep), Medium (hygiene issue), Low (best practice)
3. Recommend a specific action: update to version X, replace with Y, remove (unused)
4. Note any breaking changes the fix would introduce
