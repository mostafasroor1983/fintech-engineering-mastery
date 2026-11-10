---
id: track-13-lesson-14
title: "Penetration Testing — Financial API Security Assessment"
slug: penetration-testing
track: track-13
trackName: "Security & Observability"
sequence: 14
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [penetration-testing, DAST, SAST, threat-modelling, STRIDE]
prerequisites: [track-13-lesson-13]
---

# Penetration Testing — Financial API Security Assessment

> [!NOTE]
> PCI DSS mandates annual external penetration tests and quarterly internal vulnerability scans. Beyond compliance, pen testing reveals vulnerabilities that automated scanners miss—business logic flaws, authorization bypasses, and chained attacks that individually look benign. This lesson covers the full methodology from threat modelling to vulnerability management.

## Penetration Testing Methodology

The OWASP Testing Guide v4 defines the gold standard methodology. For financial APIs, follow this sequence:

```
Phase 1: Information Gathering
  Enumerate API endpoints (OpenAPI spec, Swagger UI, endpoint discovery)
  Identify technology stack (Spring Boot version, library versions)
  Understand authentication/authorisation model
  Review public documentation and change logs

Phase 2: Threat Modelling (STRIDE)
  Map payment flows to identify high-value targets
  Identify trust boundaries
  Document threats for each component

Phase 3: Automated Scanning
  DAST scan with OWASP ZAP against test/staging environment
  SAST scan with Semgrep against source code
  Dependency scan (OWASP Dependency Check, Snyk)

Phase 4: Manual Testing
  Authentication bypass attempts
  Authorization testing (IDOR, horizontal/vertical escalation)
  Business logic testing (payment amount manipulation, state machine abuse)
  Input validation testing (beyond what automated tools find)

Phase 5: Exploitation
  Confirm vulnerabilities are exploitable (not theoretical)
  Assess maximum impact (blast radius)
  Document evidence (screenshots, HTTP logs)

Phase 6: Reporting
  Risk-rated findings (CVSS scores)
  Remediation recommendations
  Executive summary for non-technical stakeholders
```

---

## STRIDE Threat Modelling for Payment Systems

STRIDE is a systematic approach to identifying threats. For each component in your payment system, work through all six threat categories.

**STRIDE**: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege

### Payment Submission Flow Threat Model

```
Threat: Spoofing — What if attacker impersonates a legitimate customer?
  Component: Payment API authentication
  Attack: Stolen OAuth2 access token reused from different device/IP
  Mitigation: Short-lived tokens (15 min), token binding to device, anomaly detection

Threat: Tampering — What if attacker modifies payment data in transit?
  Component: Payment request from mobile app to API
  Attack: Man-in-middle modifies destination IBAN or amount
  Mitigation: TLS 1.3 (prevents MITM), request signing (HMAC over critical fields)

Threat: Repudiation — What if customer claims they did not make a payment?
  Component: Payment authorisation
  Attack: Customer denies approving payment (friendly fraud)
  Mitigation: Cryptographic proof of authorisation (signed approval), audit log

Threat: Information Disclosure — What if payment data is exposed?
  Component: Payment data storage
  Attack: SQL injection reads transaction history of all customers
  Mitigation: Parameterised queries, least-privilege DB user, encryption at rest

Threat: Denial of Service — What if attacker overwhelms payment processing?
  Component: Payment submission API
  Attack: High-volume automated submissions exhaust Tomcat thread pool
  Mitigation: Rate limiting (10 payments/min), WAF IP-level rate limit, circuit breaker

Threat: Elevation of Privilege — What if attacker gains admin access?
  Component: Admin payment reversal API
  Attack: Regular customer token used to call admin reversal endpoint
  Mitigation: Separate admin service with separate auth, role validation on every call
```

### STRIDE Threat Register Template

```markdown
| ID | Component | Threat Category | Description | Risk (CVSS) | Mitigation | Status |
|----|-----------|----------------|-------------|-------------|------------|--------|
| T-001 | Payment API | Spoofing | Token replay from different IP | CVSS 7.5 (High) | Device binding, anomaly detection | Open |
| T-002 | Payment DB | Information Disclosure | SQLi in transaction search | CVSS 9.1 (Critical) | Parameterised queries | Mitigated |
| T-003 | Fraud Check | Tampering | Fraud score response modification | CVSS 6.3 (Medium) | mTLS response signing | Open |
| T-004 | Settlement | DoS | Kafka flood overwhelms settlement | CVSS 5.3 (Medium) | Consumer rate limiting, circuit breaker | Open |
```

---

## OWASP ZAP for DAST

OWASP ZAP (Zed Attack Proxy) is an open-source DAST (Dynamic Application Security Testing) tool. Run it against your staging environment (never production without written authorisation).

### Automated API Scanning with ZAP

```bash
# ZAP API scan using OpenAPI/Swagger spec
docker run -v $(pwd):/zap/wrk/:rw -t zaproxy/zap-stable zap-api-scan.py \
  -t https://staging-api.example.com/v3/api-docs \
  -f openapi \
  -r zap-report.html \
  -J zap-report.json \
  -d \  # Enable debug
  -z "-config replacer.full_list\(0\).description=auth_header \
      -config replacer.full_list\(0\).enabled=true \
      -config replacer.full_list\(0\).matchtype=REQ_HEADER \
      -config replacer.full_list\(0\).matchstr=Authorization \
      -config replacer.full_list\(0\).replacement=Bearer\ ${STAGING_JWT_TOKEN}"
  # Provides authenticated scan by injecting JWT token
```

### ZAP Active Scan Results Interpretation

```
ZAP Active Scan Results — Payment API Staging
=============================================
HIGH Risk Findings:
  [High]   Cross Site Scripting (Reflected)
           URL: https://staging-api/api/v1/transactions?reference=<script>alert(1)</script>
           Parameter: reference
           Evidence: Response contains unescaped input
           CWE: 79
           WASC: 8

  [High]   SQL Injection
           URL: https://staging-api/api/v1/transactions/search
           Parameter: status
           Evidence: MySQL syntax error in response
           CWE: 89

MEDIUM Risk Findings:
  [Medium] X-Frame-Options Header Not Set
           URL: https://staging-api/api/v1/payments
           → Fix: Add X-Frame-Options: DENY header

  [Medium] Missing Anti-CSRF Tokens
           URL: https://staging-api/auth/login
           → For stateless JWT APIs: not applicable; document as false positive

LOW Risk Findings:
  [Low]    Server Leaks Version Information via "Server" HTTP Response Header Field
           Server: Apache-Coyote/1.1
           → Fix: server.server-header=  (empty) in Spring Boot config
```

### Suppressing False Positives

```yaml
# zap-baseline.conf — false positive suppression for payment API
# ZAP rule IDs found at: https://www.zaproxy.org/docs/alerts/

ALERT-10020-0  # X-Frame-Options — acceptable for API (not served in iframe)
  → IGNORE

ALERT-10202-0  # Absence of Anti-CSRF Tokens — stateless JWT API, not applicable
  → IGNORE

ALERT-10015-0  # Incomplete or No Cache-control — acceptable for API responses
  → INFO  # Log but don't fail build
```

### Integrating ZAP in CI/CD Pipeline

```yaml
# .github/workflows/security-scan.yml
name: Security Scan

on:
  pull_request:
  schedule:
    - cron: '0 2 * * 1'  # Weekly full scan on Monday 2am

jobs:
  zap-scan:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to ephemeral test environment
        run: ./scripts/deploy-ephemeral.sh

      - name: Run ZAP API scan
        uses: zaproxy/action-api-scan@v0.7.0
        with:
          target: 'https://ephemeral-${{ github.sha }}.test.example.com'
          format: openapi
          cmd_options: '-J zap-report.json -a'

      - name: Parse ZAP results and fail on high severity
        run: |
          HIGH_COUNT=$(jq '.site[].alerts[] | select(.riskcode == "3") | .count' zap-report.json | \
            awk '{sum += $1} END {print sum}')
          if [ "$HIGH_COUNT" -gt 0 ]; then
            echo "FAILED: $HIGH_COUNT high-severity findings from ZAP scan"
            exit 1
          fi

      - name: Upload ZAP report as artifact
        uses: actions/upload-artifact@v4
        with:
          name: zap-report
          path: zap-report.html
```

---

## SAST with Semgrep

SAST (Static Application Security Testing) analyses source code for security vulnerabilities without executing it. Semgrep is particularly effective for financial service codebases.

### Custom Semgrep Rules for Fintech

```yaml
# .semgrep/fintech-rules.yml

rules:
  # Rule 1: Detect hardcoded secrets
  - id: hardcoded-credentials
    patterns:
      - pattern: |
          String $VAR = "...";
      - metavariable-regex:
          metavariable: $VAR
          regex: (password|secret|api_key|apikey|token|credential)
      - metavariable-not-regex:
          metavariable: "..."
          regex: \$\{.*\}  # Exclude Spring property placeholders
    message: |
      Hardcoded credential found in variable '$VAR'.
      Use Spring property binding with @Value or Vault integration instead.
    severity: ERROR
    languages: [java]
    metadata:
      cwe: CWE-798
      owasp: A02:2021

  # Rule 2: SQL string concatenation
  - id: sql-injection-concatenation
    patterns:
      - pattern: |
          $X.query($SQL + $INPUT, ...)
      - pattern: |
          "SELECT ... " + $INPUT
      - pattern: |
          String $SQL = "... " + $PARAM + " ...";
    message: |
      SQL query built by string concatenation — SQL injection risk.
      Use parameterised queries via JPA @Query with :parameter binding.
    severity: ERROR
    languages: [java]
    metadata:
      cwe: CWE-89
      owasp: A03:2021

  # Rule 3: Logging sensitive financial data
  - id: logging-pan-or-cvv
    patterns:
      - pattern: log.$LEVEL("..." + $FIELD + "...", ...)
      - metavariable-regex:
          metavariable: $FIELD
          regex: (cardNumber|pan|cvv|cvc|pin|password|secret)
    message: |
      Potential logging of sensitive financial field '$FIELD'.
      Mask sensitive data before logging: use maskPan() or redact completely.
    severity: ERROR
    languages: [java]
    metadata:
      cwe: CWE-532
      pci-dss: Requirement 3.4

  # Rule 4: Missing @PreAuthorize on payment endpoints
  - id: payment-endpoint-missing-auth
    patterns:
      - pattern: |
          @PostMapping(...)
          public $RETURN $METHOD(@RequestBody $REQUEST_TYPE request, ...) { ... }
      - pattern-not: |
          @PostMapping(...)
          @PreAuthorize(...)
          public $RETURN $METHOD(...)
      - metavariable-regex:
          metavariable: $REQUEST_TYPE
          regex: .*Payment.*|.*Transfer.*|.*Transaction.*
    message: |
      Payment endpoint '$METHOD' may be missing @PreAuthorize annotation.
      Ensure all payment operations require appropriate scope.
    severity: WARNING
    languages: [java]

  # Rule 5: Insecure random number generation
  - id: insecure-random-financial
    patterns:
      - pattern: new Random()
      - pattern: Math.random()
    message: |
      java.util.Random or Math.random() is not cryptographically secure.
      Use SecureRandom for financial operations (transaction IDs, tokens, nonces).
    severity: ERROR
    languages: [java]
    metadata:
      cwe: CWE-338

  # Rule 6: Weak cryptography
  - id: weak-cipher-algorithm
    patterns:
      - pattern: Cipher.getInstance("DES")
      - pattern: Cipher.getInstance("3DES")
      - pattern: Cipher.getInstance("AES/ECB/...")
      - pattern: MessageDigest.getInstance("MD5")
      - pattern: MessageDigest.getInstance("SHA-1")
    message: |
      Weak cryptographic algorithm detected.
      Use AES-256-GCM for encryption, SHA-256 or SHA-3 for hashing.
    severity: ERROR
    languages: [java]
    metadata:
      cwe: CWE-327
      pci-dss: Requirement 4.2.1
```

### Running Semgrep in CI

```yaml
# .github/workflows/sast.yml
name: SAST Security Scan

on: [push, pull_request]

jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Semgrep with custom rules
        uses: returntocorp/semgrep-action@v1
        with:
          config: >-
            .semgrep/fintech-rules.yml
            p/java
            p/owasp-top-ten
            p/jwt
        env:
          SEMGREP_APP_TOKEN: ${{ secrets.SEMGREP_APP_TOKEN }}

      - name: Fail on high severity findings
        run: |
          semgrep --config .semgrep/fintech-rules.yml \
            --json --output semgrep-results.json \
            --severity ERROR \
            src/

          ERROR_COUNT=$(jq '.results | length' semgrep-results.json)
          if [ "$ERROR_COUNT" -gt 0 ]; then
            echo "SAST FAILED: $ERROR_COUNT high-severity security findings"
            jq '.results[] | {file: .path, rule: .check_id, line: .start.line, message: .extra.message}' semgrep-results.json
            exit 1
          fi
```

---

## Dependency Vulnerability Scanning

Third-party dependencies are a significant attack surface. The Log4Shell vulnerability (CVE-2021-44228) affected nearly every Java application.

```xml
<!-- pom.xml — OWASP Dependency Check -->
<plugin>
    <groupId>org.owasp</groupId>
    <artifactId>dependency-check-maven</artifactId>
    <version>9.0.0</version>
    <configuration>
        <!-- Fail build if any CVSS >= 7.0 (High or Critical) -->
        <failBuildOnCVSS>7</failBuildOnCVSS>
        <!-- Suppress false positives -->
        <suppressionFile>dependency-check-suppressions.xml</suppressionFile>
        <!-- NVD API key for faster scanning -->
        <nvdApiKey>${env.NVD_API_KEY}</nvdApiKey>
        <formats>
            <format>HTML</format>
            <format>JSON</format>
        </formats>
    </configuration>
    <executions>
        <execution>
            <goals><goal>check</goal></goals>
        </execution>
    </executions>
</plugin>
```

---

## PCI DSS Penetration Testing Requirements

PCI DSS Requirement 11 mandates:

**11.3.1**: External penetration testing at least annually and after significant infrastructure or application changes.
- Must be performed by qualified internal staff or a qualified third party
- Must test both network layer and application layer
- Must cover the entire CDE (Cardholder Data Environment)

**11.3.2**: Internal penetration testing at least annually.
- Same scope as external, from inside the network perimeter

**11.3.3**: Exploitable vulnerabilities found during penetration testing are corrected and testing is repeated to verify correction.

```markdown
# PCI DSS Pen Test Evidence Requirements

The following must be documented for each annual pen test:

1. Scope document
   - Systems in scope (CDE + connected systems)
   - Explicit out-of-scope systems with justification
   - Test window and authorized testers

2. Methodology
   - Confirm use of industry-accepted approach (OWASP, PTES, NIST)
   - Both network and application layers tested
   - Exploits attempted (not just identified)

3. Results
   - Full findings report with CVSS scores
   - Evidence of exploitation (screenshots, HTTP logs)
   - Retest results for each finding

4. Remediation
   - Each finding addressed before next compliance assessment
   - Critical/High findings remediated within 30 days
   - Retest confirmation for all remediations
```

---

## Vulnerability Management Process

Findings from pen tests and automated scans must be tracked and remediated within defined SLAs.

```markdown
# Vulnerability Management SLAs for Payment Systems

Severity Classification (using CVSS v3.1 Base Score):

| Severity | CVSS Range | SLA | Owner |
|----------|-----------|-----|-------|
| Critical | 9.0 - 10.0 | Patch within 24 hours | On-call engineer + manager |
| High | 7.0 - 8.9 | Patch within 7 days | Service team |
| Medium | 4.0 - 6.9 | Patch within 30 days | Service team |
| Low | 0.1 - 3.9 | Patch within 90 days | Service team |

Exceptions:
- PCI DSS-related findings (regardless of CVSS): 30-day hard deadline
- Actively exploited vulnerabilities (in CISA KEV): 24 hours regardless of CVSS
- Regulatory-mandated patches: timeline set by regulator

Process:
1. Finding identified (pen test, scanner, or responsible disclosure)
2. Triage: confirm exploitability, assess CVSS, assign owner
3. Remediate: code fix, patch, or configuration change
4. Retest: confirm fix is effective
5. Close: document evidence of remediation
6. Track exceptions: if deadline cannot be met, compensating controls required
```

---

## Key Takeaways

- STRIDE threat modelling before coding identifies security issues cheaply—it costs far less to fix a threat during design than after a pen test finds it in production
- OWASP ZAP provides automated detection of common vulnerabilities (SQLi, XSS, security headers); integrate it in CI/CD to catch regressions immediately
- Semgrep custom rules enforce financial-services-specific security patterns: hardcoded secrets, sensitive data in logs, missing authorisation annotations
- PCI DSS Requirement 11 mandates annual external penetration tests—treat these as a minimum floor, not a target ceiling
- Vulnerability SLAs must be enforced: Critical findings in a PCI CDE require patching within 24 hours, High within 7 days—these timelines are non-negotiable in regulated environments
- SAST finds vulnerabilities before they ship; DAST finds vulnerabilities in running applications; both are necessary—neither alone is sufficient

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "Under PCI DSS Requirement 11.3, how frequently must external penetration tests be performed for systems in the Cardholder Data Environment?",
      "options": ["Monthly", "Quarterly", "At least annually and after any significant infrastructure or application change", "Every two years"],
      "correct": 2,
      "explanation": "PCI DSS Requirement 11.3.1 mandates external penetration testing at least annually AND after significant infrastructure or application changes. The test must cover both network and application layers, attempt actual exploitation (not just identification), and be performed by qualified staff or a qualified third party."
    },
    {
      "text": "What is the STRIDE threat modelling framework, and when in the development lifecycle should it be applied?",
      "options": ["A penetration testing tool; used after deployment", "A framework for categorising threats (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege); should be applied during design before coding begins", "A CVSS scoring framework; used when triaging vulnerabilities", "A compliance framework; applied during audits"],
      "correct": 1,
      "explanation": "STRIDE is a threat modelling framework that systematically identifies threats across six categories. Applying it during design is 10-100x cheaper than finding the same vulnerabilities in production via pen testing. Each component and data flow in the architecture diagram is analysed against all six threat categories."
    },
    {
      "text": "What SLA applies to Critical (CVSS 9.0+) vulnerabilities found in a PCI-scoped payment system?",
      "options": ["90 days", "30 days", "7 days", "24 hours, with compensating controls required if patching is delayed"],
      "correct": 3,
      "explanation": "Critical vulnerabilities (CVSS 9.0+) in PCI-scoped systems require patching within 24 hours. Vulnerabilities in CISA's Known Exploited Vulnerabilities catalog also require 24-hour patching regardless of CVSS score. If immediate patching is not possible, compensating controls must be documented and approved."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Security Testing Pipeline for a Payment API",
  "difficulty": "advanced",
  "estimatedMinutes": 70,
  "tasks": [
    {"id": "1", "description": "Conduct a STRIDE threat model on a payment submission flow: draw the data flow diagram (browser → API gateway → payment-service → fraud-service → database), then enumerate at least 2 threats per STRIDE category and propose a mitigation for each."},
    {"id": "2", "description": "Configure OWASP ZAP in CI/CD as a DAST tool against a local payment API: run an authenticated scan using a valid JWT, configure context-specific exclusion rules to avoid scanning /logout endpoints, and configure the build to fail if any High or Critical findings are detected."},
    {"id": "3", "description": "Write three Semgrep custom rules for a Java Spring Boot payment codebase: detect @PreAuthorize missing on @PostMapping methods in payment controllers, detect XML parsing without disabling external entities, and detect the use of java.util.Random in security-sensitive contexts."},
    {"id": "4", "description": "Build a vulnerability management tracker: create a data model for security findings with CVSS score, SLA deadline, owner, and status; write a function that calculates days remaining to SLA deadline and sends a Slack alert when a Critical finding is within 4 hours of deadline or overdue."}
  ]
}
-->
