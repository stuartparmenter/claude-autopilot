---
name: OWASP Top 10
description: Use when scanning for web security vulnerabilities. Provides the OWASP Top 10 checklist with specific code patterns to look for in each category.
user-invocable: false
---

# OWASP Top 10 Security Checklist

When scanning a codebase for security vulnerabilities, investigate each of these categories. Report specific file paths, line numbers, and code patterns — not generic advice.

## A01: Broken Access Control

- Missing authorization checks on API endpoints (routes accessible without auth)
- Insecure Direct Object References (IDOR) — user can access other users' data by changing an ID
- Missing function-level access control (admin endpoints accessible to regular users)
- CORS misconfiguration (wildcard Allow-Origin with credentials)
- Path traversal in file operations (unsanitized relative paths)
- Missing rate limiting on sensitive operations

**What to look for:** Route handlers without auth middleware, ID parameters used directly in DB queries without ownership checks, wildcard CORS headers.

## A02: Cryptographic Failures

- Hardcoded secrets, API keys, or passwords in source code
- Weak hashing algorithms (MD5, SHA1 for passwords)
- Missing encryption for sensitive data at rest
- HTTP used instead of HTTPS for API calls
- Secrets in environment files committed to git
- Weak or missing JWT signing configuration

**What to look for:** String literals that look like API keys or passwords, weak hash function calls on passwords, .env files in git, http:// URLs for APIs.

## A03: Injection

- SQL injection (string concatenation in queries instead of parameterized queries)
- NoSQL injection (unsanitized user input in MongoDB queries)
- Command injection (user input passed to shell execution functions)
- Template injection (user input in template engines without escaping)
- LDAP injection, XPath injection in relevant systems
- Log injection (unsanitized user input in log messages)

**What to look for:** String interpolation or concatenation in SQL queries, $where or $regex with user input in MongoDB, shell execution with user input.

## A04: Insecure Design

- Missing input validation on API boundaries
- Business logic flaws (e.g., negative quantities, bypassing payment)
- Missing server-side validation (relying only on client-side checks)
- Lack of rate limiting or abuse prevention
- Missing account lockout after failed attempts

**What to look for:** Request handlers that trust client-provided data without validation, missing schema validation (zod, joi, etc.) on API inputs.

## A05: Security Misconfiguration

- Debug mode enabled in production
- Default credentials or configurations
- Unnecessary features enabled (directory listing, verbose errors)
- Missing security headers (CSP, X-Frame-Options, HSTS)
- Stack traces or detailed errors exposed to users
- Overly permissive file permissions

**What to look for:** DEBUG=true, default passwords in configs, missing helmet/security header middleware, error handlers that return stack traces.

## A06: Vulnerable and Outdated Components

- Known CVEs in dependencies (check with audit tools)
- Outdated packages with known security issues
- Abandoned dependencies (no updates in 2+ years)
- Using deprecated APIs or libraries

**What to look for:** Run dependency audit tools, check package ages and maintenance status, look for deprecated package warnings.

## A07: Identification and Authentication Failures

- Weak password requirements (no minimum length, complexity)
- Missing multi-factor authentication on sensitive operations
- Session tokens in URLs
- Session fixation vulnerabilities
- Missing session expiration or rotation
- Credentials sent over unencrypted connections

**What to look for:** Password validation logic, session management code, cookie configuration (httpOnly, secure, sameSite flags).

## A08: Software and Data Integrity Failures

- Deserialization of untrusted data (parsing user input without schema validation)
- Missing integrity checks on external data (unsigned updates, unverified downloads)
- CI/CD pipeline without integrity verification
- Missing Subresource Integrity (SRI) for CDN resources

**What to look for:** JSON.parse on user input without validation, eval on dynamic content, missing SRI hashes on script tags.

## A09: Security Logging and Monitoring Failures

- Missing logging for authentication events (login, logout, failed attempts)
- Missing logging for authorization failures
- Sensitive data in logs (passwords, tokens, PII)
- No alerting on suspicious patterns
- Log injection vulnerabilities

**What to look for:** Auth handlers without logging, sensitive data logged to console, missing error tracking setup.

## A10: Server-Side Request Forgery (SSRF)

- User-supplied URLs fetched server-side without validation
- Internal service URLs accessible through user input
- Missing URL allowlist for outbound requests
- DNS rebinding vulnerabilities

**What to look for:** fetch(userProvidedUrl), HTTP client calls with user input, webhook URLs used without validation, image/avatar URL fetching.

## Reporting Guidelines

For each finding:
1. Specify the exact file path and line number(s)
2. Quote the vulnerable code snippet
3. Classify severity: Critical (actively exploitable), High (exploitable with effort), Medium (defense-in-depth), Low (best practice)
4. Suggest a specific fix, not just "validate input"
