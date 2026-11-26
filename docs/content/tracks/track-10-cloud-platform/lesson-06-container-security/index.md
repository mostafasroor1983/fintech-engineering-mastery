---
id: track-10-lesson-06
title: "Container Security — Image Scanning and Pod Security"
slug: container-security
track: track-10
trackName: "Cloud Platform & Kubernetes"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [container-security, Trivy, PSP, seccomp, non-root]
prerequisites: [track-10-lesson-05]
---

# Container Security — Image Scanning and Pod Security

> [!NOTE]
> A container is not a security boundary. Containers share the host kernel. If a payment processing container runs as root with excessive Linux capabilities, a vulnerability in that container can compromise the host node — and every other pod on it. The controls in this lesson are not bureaucratic checkbox exercises; they are the technical controls that prevent a container escape from becoming a cluster-wide breach.

## The Container Security Model

Container security is defence in depth across four layers:

1. **Image layer**: what is in the container image (vulnerabilities, malware)
2. **Runtime layer**: how the container runs (root vs non-root, capabilities, syscalls)
3. **Kubernetes layer**: what the pod is allowed to do (Pod Security Standards, RBAC)
4. **Supply chain layer**: how the image was built and verified (signing, SBOM)

---

## 1. Container Image Scanning with Trivy

Trivy scans container images for known CVEs in OS packages and application dependencies. For financial services, integrate Trivy into every CI/CD pipeline stage.

### Trivy Scan in CI Pipeline

```yaml
# GitHub Actions workflow — trivy scan on every PR
name: Container Security Scan

on:
  pull_request:
    paths:
    - Dockerfile
    - pom.xml
    - package*.json
    - go.sum

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write  # for SARIF upload to GitHub Security tab
    steps:
    - uses: actions/checkout@v4

    - name: Build image
      run: |
        docker build -t payment-processor:${{ github.sha }} .

    - name: Run Trivy vulnerability scanner
      # Pin third-party actions to a release -- better, to its full commit
      # SHA. A moving ref like @master runs whatever is pushed there, and
      # compromised popular actions have leaked CI secrets before.
      uses: aquasecurity/trivy-action@0.28.0
      with:
        image-ref: payment-processor:${{ github.sha }}
        format: sarif
        output: trivy-results.sarif
        # Fail on CRITICAL and HIGH severity
        exit-code: '1'
        severity: 'CRITICAL,HIGH'
        # Ignore unfixed vulnerabilities (fixable ones are actionable)
        ignore-unfixed: true
        # Scan OS packages AND application libraries
        vuln-type: 'os,library'

    - name: Upload scan results to GitHub Security
      uses: github/codeql-action/upload-sarif@v3
      if: always()   # upload even if scan fails
      with:
        sarif_file: trivy-results.sarif

    - name: Run Trivy for SBOM generation
      uses: aquasecurity/trivy-action@0.28.0
      with:
        image-ref: payment-processor:${{ github.sha }}
        format: spdx-json
        output: sbom.spdx.json

    - name: Upload SBOM as artifact
      uses: actions/upload-artifact@v4
      with:
        name: sbom-${{ github.sha }}
        path: sbom.spdx.json
        retention-days: 365   # retain for compliance audit trail
```

### Trivy in the Cluster (Trivy Operator)

The Trivy Operator is not an admission controller: it continuously re-scans the images of running workloads, so CVEs published *after* deployment are found too.

```bash
# Trivy Operator continuously scans all running images
helm upgrade --install trivy-operator aquasecurity/trivy-operator \
  --namespace trivy-system \
  --create-namespace \
  --set="trivy.ignoreUnfixed=true" \
  --set="trivy.severity=CRITICAL\,HIGH" \
  --set="operator.scanJobTimeout=10m"

# Check scan results
kubectl get vulnerabilityreports -n payments -o wide

# Alert on new critical CVEs in running containers
kubectl get vulnerabilityreports -n payments \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.report.summary.criticalCount}{"\n"}{end}'
```

### Dockerfile Security Baseline

```dockerfile
# Secure Dockerfile for payment processor
# Multi-stage build: builder is large, runtime image is minimal
FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build
# The Maven wrapper must be copied too, or ./mvnw does not exist
COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN ./mvnw -q dependency:go-offline     # cached layer while pom.xml is unchanged
COPY src ./src

# Build without running tests (tests run separately in CI)
RUN ./mvnw package -DskipTests -q

# ---- Runtime stage ----
# Use distroless: no shell, no package manager, minimal attack surface.
# Pin by digest in production (FROM ...@sha256:...) for reproducible builds.
FROM gcr.io/distroless/java21-debian12:nonroot

# Non-root user — 'nonroot' UID 65532 in distroless
# No USER instruction needed; distroless/nonroot runs as 65532 by default

# Copy only the JAR, not build artifacts
COPY --from=builder /build/target/payment-processor-*.jar /app/app.jar

# Expose only the application port
EXPOSE 8080

# No HEALTHCHECK instruction — Kubernetes probes handle this

# (Container support is on by default since JDK 10, and the old
#  -Djava.security.egd=file:/dev/./urandom trick is not needed on modern JDKs)
ENTRYPOINT ["java", \
  "-XX:MaxRAMPercentage=75.0", \
  "-XX:+UseG1GC", \
  "-XX:MaxGCPauseMillis=100", \
  "-jar", "/app/app.jar"]
```

> [!NOTE]
> Distroless images contain only the runtime (JRE, glibc) and your application. There is no shell (`bash`, `sh`), no package manager, and no standard Unix utilities. This dramatically reduces the attack surface and the number of CVEs in Trivy scans. The trade-off is you cannot `kubectl exec` a shell into a distroless container for debugging — use ephemeral debug containers instead.

---

## 2. Pod Security Standards

Kubernetes 1.25 removed PodSecurityPolicy; its replacement is the built-in Pod Security Admission controller, which enforces the Pod Security Standards (PSS) via the `pod-security.kubernetes.io` namespace labels.

### Three PSS Levels

| Level | Description | Use Case |
|---|---|---|
| Privileged | No restrictions | System components only |
| Baseline | Prevents known privilege escalations | General workloads |
| Restricted | Hardened; requires non-root, no privilege escalation, all capabilities dropped, a seccomp profile | Financial services |

### Namespace-Level Enforcement

```yaml
# Apply Restricted PSS to payments namespace
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    # enforce: pod creation fails if spec violates Restricted
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28   # pin, or "latest"
    # audit: log violations without blocking (for monitoring legacy namespaces)
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
    # warn: show warnings in kubectl output
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
```

### Pod Spec Compliant with Restricted PSS

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  replicas: 6
  selector:
    matchLabels:
      app: payment-processor
  template:
    metadata:
      labels:
        app: payment-processor
    spec:
      # Required for Restricted PSS
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532       # distroless nonroot UID
        runAsGroup: 65532
        fsGroup: 65532
        seccompProfile:
          type: RuntimeDefault  # required for Restricted PSS
      automountServiceAccountToken: false   # don't mount SA token unless needed
      containers:
      - name: payment-processor
        image: payments-registry.internal/payment-processor:v2.4.1
        securityContext:
          allowPrivilegeEscalation: false   # required for Restricted
          readOnlyRootFilesystem: true      # NOT part of Restricted -- our own
                                            # hardening rule (enforced by Kyverno)
          runAsNonRoot: true                # required for Restricted (pod or container)
          capabilities:
            drop: ["ALL"]                  # required for Restricted
            # Do not add any capabilities back for payment services
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2000m"
            memory: "1Gi"
        volumeMounts:
        # tmp directory is writable; root filesystem is read-only
        - name: tmp-dir
          mountPath: /tmp
        # Application log directory
        - name: log-dir
          mountPath: /var/log/payment-processor
      volumes:
      - name: tmp-dir
        emptyDir: {}
      - name: log-dir
        emptyDir: {}
```

---

## 3. Seccomp Profiles

Seccomp (Secure Computing Mode) restricts which Linux system calls a container process can make. A payment processor does not need `ptrace`, `reboot`, or `kexec_load` — blocking these reduces the blast radius of a container compromise.

### RuntimeDefault Profile

The `RuntimeDefault` seccomp profile (provided by containerd/CRI-O) blocks several dozen dangerous syscalls that typical application containers never use — e.g. `kexec_load`, `reboot`, `mount`, `ptrace` on older kernels, `bpf`. This is the minimum for production financial workloads.

```yaml
# Apply RuntimeDefault seccomp at the namespace level via Kyverno policy
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-seccomp-profile
spec:
  # Kyverno 1.13+ prefers a per-rule validate.failureAction; the policy-level
  # validationFailureAction used in these examples is deprecated but works
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-seccomp
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces:
          - payments
          - fraud
          - risk
    validate:
      message: "Pods must specify a seccomp profile (RuntimeDefault or Localhost)"
      pattern:
        spec:
          securityContext:
            seccompProfile:
              type: "RuntimeDefault | Localhost"
```

### Custom Seccomp Profile for Payment Service

For maximum restriction, create a custom profile that allows only the syscalls your Java application actually uses.

> [!WARNING]
> The list below is a shortened illustration — a real JVM needs more (e.g. `rt_sigreturn`, `sigaltstack`, `madvise`, `prctl`, `gettid`, `newfstatat`/`statx`, `pread64`, `clock_nanosleep`), and the exact set depends on JDK version, GC and libraries. Do not write the list by hand: **record** it (Security Profiles Operator, or `strace -f -c` under a full test load), review it, and test every code path — a missing syscall crashes the service in production. Each kubelet node also needs the profile file.

```json
// /var/lib/kubelet/seccomp/profiles/payment-processor.json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": [
        "read", "write", "close", "fstat", "lseek",
        "mmap", "mprotect", "munmap", "brk",
        "rt_sigaction", "rt_sigprocmask",
        "ioctl", "access", "pipe", "select",
        "sched_yield", "mremap", "msync",
        "dup", "dup2", "nanosleep",
        "getpid", "socket", "connect", "accept",
        "sendto", "recvfrom", "sendmsg", "recvmsg",
        "bind", "listen", "getsockname", "getpeername",
        "socketpair", "setsockopt", "getsockopt",
        "clone", "fork", "execve", "exit",
        "wait4", "kill", "uname",
        "fcntl", "flock", "fsync",
        "getdents", "getcwd", "mkdir", "rmdir",
        "unlink", "readlink", "chmod", "chown",
        "stat", "lstat",
        "futex", "sched_getaffinity",
        "set_tid_address", "exit_group",
        "epoll_create", "epoll_ctl", "epoll_wait",
        "openat", "getdents64", "set_robust_list",
        "ppoll", "epoll_pwait",
        "getrandom", "memfd_create"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```yaml
# Reference custom seccomp profile in pod spec
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/payment-processor.json
```

---

## 4. AppArmor Profiles

AppArmor provides mandatory access control at the filesystem and network level. It complements seccomp (syscall filtering) by restricting what files and network operations a process can access.

```
# AppArmor profile for payment processor
# /etc/apparmor.d/payment-processor

#include <tunables/global>

profile payment-processor flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  #include <abstractions/openssl>

  # Allow reading JRE files
  /usr/lib/jvm/** r,
  /usr/lib/jvm/*/bin/java ix,

  # Allow reading application JAR
  /app/** r,

  # Allow writing to tmp and log directories only
  /tmp/** rw,
  /var/log/payment-processor/** rw,

  # Deny everything else (implicit deny)
  deny /etc/shadow r,
  deny /etc/passwd w,
  deny @{PROC}/** w,
  deny /sys/** w,

  # Allow network: TCP and UDP (DNS) only, no raw sockets
  network tcp,
  network udp,
  deny network raw,
  deny network packet,
}
```

```yaml
# Apply AppArmor via pod annotation (pre-1.30 method)
metadata:
  annotations:
    container.apparmor.security.beta.kubernetes.io/payment-processor: localhost/payment-processor

# Kubernetes 1.30+ — use securityContext field:
spec:
  containers:
  - name: payment-processor
    securityContext:
      appArmorProfile:
        type: Localhost
        localhostProfile: payment-processor
```

---

## 5. Linux Capability Dropping

Linux capabilities divide root privileges into distinct units. A Java payment service needs none of them. Dropping all capabilities is both correct and required by the Restricted Pod Security Standard.

```yaml
# Every production container in a financial platform should have:
securityContext:
  capabilities:
    drop: ["ALL"]
  # Only add back if absolutely required (almost never for financial services):
  # add: ["NET_BIND_SERVICE"]  # only if binding port < 1024 (don't — use port 8080)
```

Capabilities that financial service containers must never have:

| Capability | Why It's Dangerous |
|---|---|
| `SYS_ADMIN` | Equivalent to root — can mount filesystems, modify kernel parameters |
| `NET_ADMIN` | Can modify network interfaces, routing tables — lateral movement |
| `SYS_PTRACE` | Can inspect any process memory — credential theft |
| `DAC_OVERRIDE` | Bypass file permission checks — data exfiltration |
| `SETUID` | Change UID — privilege escalation |

---

## 6. Image Signing with Cosign

Image signing creates a verifiable chain of custody from CI pipeline to production. Combined with an admission policy, only signed images from your CI system can run in production.

### Signing in CI Pipeline

```bash
# In GitHub Actions CI pipeline:

# Sign the image DIGEST, not a tag: a tag can later be moved to other content
IMAGE=payments-registry.internal/payment-processor@sha256:3f1c...   # from the build/push step

# Generate a keyless signature using OIDC (sigstore keyless signing)
# No private key to manage — uses ephemeral keys tied to GitHub Actions OIDC token.
# Note: keyless signing records an entry in the PUBLIC Rekor transparency log
# (image name, workflow identity). For internal images, consider a private
# Sigstore deployment or KMS keys.
cosign sign \
  --yes \
  "$IMAGE"

# Or with a managed key stored in AWS KMS:
cosign sign \
  --key awskms:///arn:aws:kms:us-east-1:123456789:key/abc-def-123 \
  "$IMAGE"

# Attach SBOM to image
cosign attest \
  --yes \
  --predicate sbom.spdx.json \
  --type spdxjson \
  "$IMAGE"
```

### Admission Policy with Kyverno: Only Signed Images

```yaml
# Kyverno policy: reject pods with unsigned images in payments namespace
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: verify-payment-images
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces:
          - payments
          - fraud
          - risk
    verifyImages:
    - imageReferences:
      - "payments-registry.internal/*"
      attestors:
      - count: 1
        entries:
        - keyless:
            subject: "https://github.com/example-bank/payment-processor/.github/workflows/release.yml@refs/heads/main"
            issuer: "https://token.actions.githubusercontent.com"
            rekor:
              url: https://rekor.sigstore.dev
      # Also verify SBOM attestation exists
      attestations:
      - predicateType: https://spdx.dev/Document
        conditions:
        - all:
          - key: "{{ spdxVersion }}"
            operator: Equals
            value: "SPDX-2.3"
```

---

## 7. OPA/Kyverno Admission Policies for Financial Workloads

Kyverno policies run as admission webhooks, validating or mutating pod specs before they are accepted.

### Comprehensive Policy Set

```yaml
---
# Policy 1: Require resource limits on all containers
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
spec:
  validationFailureAction: Enforce
  rules:
  - name: check-resource-limits
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces: [payments, fraud, risk]
    validate:
      # (covers spec.containers; add the same check for initContainers)
      message: "Resource limits are required for all containers in regulated namespaces"
      pattern:
        spec:
          containers:
          - resources:
              limits:
                memory: "?*"
                cpu: "?*"

---
# Policy 2: Disallow latest tag in production
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
spec:
  validationFailureAction: Enforce
  rules:
  - name: require-image-tag
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces: [payments, fraud, risk]
    validate:
      message: "An explicit image tag other than 'latest' is required"
      pattern:
        spec:
          containers:
          # "*:*" requires a tag at all (an image without a tag IS latest);
          # "!*:latest" rejects the explicit latest tag
          - image: "*:* & !*:latest"

---
# Policy 3: Require read-only root filesystem
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-readonly-rootfs
spec:
  validationFailureAction: Enforce
  rules:
  - name: check-readonly-rootfs
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces: [payments, fraud, risk]
    validate:
      message: "Containers must have readOnlyRootFilesystem: true"
      pattern:
        spec:
          containers:
          - securityContext:
              readOnlyRootFilesystem: true

---
# Policy 4: Disallow privilege escalation
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privilege-escalation
spec:
  validationFailureAction: Enforce
  rules:
  - name: no-privilege-escalation
    match:
      any:
      - resources:
          kinds: [Pod]
    exclude:                       # don't break system add-ons (CNI, CSI...)
      any:
      - resources:
          namespaces: [kube-system]
    validate:
      message: "Privilege escalation is not allowed"
      pattern:
        spec:
          containers:
          - securityContext:
              allowPrivilegeEscalation: false

---
# Policy 5: Mutate — auto-add seccomp profile if missing
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-seccomp
spec:
  rules:
  - name: add-seccomp-profile
    match:
      any:
      - resources:
          kinds: [Pod]
    mutate:
      patchStrategicMerge:
        spec:
          securityContext:
            +(seccompProfile):
              type: RuntimeDefault
```

---

## Production Checklist

- [ ] Trivy scanning integrated in CI pipeline — blocks CRITICAL/HIGH CVEs from merging
- [ ] Trivy Operator running in cluster — alerts on new CVEs in running images
- [ ] All production images built on distroless or minimal base (no shell)
- [ ] `Restricted` Pod Security Standard enforced on all regulated namespaces
- [ ] `runAsNonRoot: true` and `runAsUser` set to non-zero UID
- [ ] `readOnlyRootFilesystem: true` — writable volumes explicitly defined
- [ ] `allowPrivilegeEscalation: false` on all containers
- [ ] `capabilities.drop: [ALL]` — no capabilities re-added
- [ ] RuntimeDefault seccomp profile applied (at minimum)
- [ ] Image signing with Cosign in CI (by digest); Kyverno verifies signatures in admission
- [ ] CI actions and base images pinned (commit SHA / digest)
- [ ] SBOM generated and stored for every production image
- [ ] Kyverno policy: no `latest` tags in production
- [ ] Kyverno policy: resource limits required
- [ ] `automountServiceAccountToken: false` for pods that do not need Kubernetes API access

---

## Summary

Container security in a financial platform is not a single control — it is a stack. Trivy catches known CVEs in the supply chain before images reach production. The Restricted Pod Security Standard, combined with Kyverno admission policies, ensures every pod runs with minimal privilege at the Kubernetes layer. Seccomp and AppArmor profiles restrict kernel-level interactions, dramatically reducing what a successful container exploit can do. Image signing with Cosign closes the supply chain: even if an attacker compromises a dependency, an unsigned image cannot be admitted to the production cluster. Each layer is independently valuable; together they cover the container-related controls that PCI-DSS, SOC 2 Type II, and ISO 27001 audits look for.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A Dockerfile uses `FROM ubuntu:latest` as the base image, runs as root, and installs build tools in the final image. Which Trivy finding is most likely to block the CI pipeline with a CRITICAL severity?",
      "options": [
        "The use of the 'latest' tag — Trivy always fails on floating tags",
        "Known CVEs in the ubuntu:latest base image packages (e.g., glibc, openssl) that have available fixes, reported as CRITICAL or HIGH",
        "The absence of a USER directive — Trivy fails all images running as root",
        "The presence of build tools — Trivy flags unused packages as a critical vulnerability"
      ],
      "correct": 1,
      "explanation": "Trivy is a vulnerability scanner — it identifies CVEs in OS packages and application dependencies by comparing installed versions against vulnerability databases (NVD, Red Hat, Ubuntu CVE tracker). ubuntu:latest often contains packages with known CVEs (particularly in core libraries like glibc, openssl, curl). The pipeline's EXIT_CODE=1 is triggered by vulnerabilities at or above the configured severity threshold (typically CRITICAL). The USER directive and floating tags are best-practice issues but not Trivy vulnerability findings."
    },
    {
      "text": "A Kyverno ClusterPolicy requires all containers to have readOnlyRootFilesystem: true. A developer deploys a pod without this field. What happens, and how does the developer fix it?",
      "options": [
        "The pod is deployed with a warning, but readOnlyRootFilesystem is not enforced at runtime",
        "The pod is rejected by the Kyverno admission webhook with a policy violation message. The developer must add securityContext.readOnlyRootFilesystem: true to the container spec, and mount emptyDir volumes for any paths the app needs to write",
        "Kyverno automatically mutates the pod to add readOnlyRootFilesystem: true without developer intervention",
        "The pod runs normally — Kyverno ClusterPolicies only apply to new namespaces, not existing deployments"
      ],
      "correct": 1,
      "explanation": "A Kyverno validation policy in Enforce mode (validationFailureAction: Enforce, or failureAction: Enforce per rule) blocks non-compliant resources at the API server admission stage — the pod is never created. The developer must add readOnlyRootFilesystem: true to the container's securityContext. Applications that write temporary files (logs, PID files, etc.) need emptyDir volumes mounted at the specific write paths. Kyverno can also be configured to mutate (auto-add) the field, but validation in Enforce mode is what blocks the pod here. (In Audit mode the pod would be admitted and only a policy report written.)"
    },
    {
      "text": "An image is built and signed with Cosign using keyless OIDC signing (sigstore). A Kyverno policy verifies the signature using the OIDC issuer and subject. If an attacker rebuilds the same image from the same Dockerfile without going through the CI pipeline, what prevents the attacker's image from being deployed?",
      "options": [
        "The image digest (SHA256) will be identical for the same Dockerfile, so the existing signature covers the attacker's image too",
        "The attacker's image lacks a Cosign signature from the trusted OIDC identity (the CI/CD pipeline's service account). Kyverno's image verification policy rejects images without a valid signature from the expected issuer and subject",
        "Container registries automatically reject pushes from non-CI pipeline sources",
        "The image tag 'latest' cannot be used without CI pipeline promotion, blocking the attacker's push"
      ],
      "correct": 1,
      "explanation": "Cosign keyless signing ties the signature to the image digest AND to the OIDC identity that signed it — typically the GitHub Actions workflow of the release pipeline. A rebuild outside CI almost never produces the same digest (timestamps and build metadata differ; bit-for-bit reproducible builds take deliberate effort), so the attacker's image has no signature, and the attacker cannot obtain one for the expected issuer (https://token.actions.githubusercontent.com) and subject (the specific repository and workflow). Kyverno therefore rejects it. And if a rebuild WERE byte-identical, the existing signature would apply — but then it is exactly the approved content, so nothing untrusted runs."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Container Security Pipeline for a Payment Service Image",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "Write a secure multi-stage Dockerfile for a Spring Boot payment-api: stage 1 uses eclipse-temurin:21-jdk as the builder, stage 2 uses gcr.io/distroless/java21-debian12 as the runtime, runs as a non-root user (UID 10001), and excludes all build tools and test dependencies. Run Trivy against the resulting image and verify zero CRITICAL or HIGH CVEs. Document any CVEs found and whether they have available fixes.",
    "Create a Kyverno ClusterPolicy named payment-pod-security that validates: containers have CPU and memory limits set, readOnlyRootFilesystem is true, allowPrivilegeEscalation is false, and the image tag is not 'latest'. Set the policy to Enforce mode. Attempt to deploy a non-compliant pod and capture the admission rejection message. Then fix the pod spec and confirm it is admitted.",
    "Build a seccomp profile for the payment-api by RECORDING the syscalls it uses (Security Profiles Operator, or strace -f under a full test load), then review and tighten it. Apply it via pod spec securityContext.seccompProfile.type=Localhost referencing the profile file. Run the payment-api through its full test suite and verify it works, then verify that a syscall outside the profile is blocked (e.g. a small test binary in the pod calling mount or unshare fails with EPERM).",
    "Set up Cosign keyless image signing in a GitHub Actions workflow: use the GitHub OIDC token to sign the payment-api image after the Trivy scan passes. Install a Kyverno ClusterPolicy that verifies the image signature using the GitHub OIDC issuer (https://token.actions.githubusercontent.com) and the specific repository subject. Deploy an unsigned image directly and verify Kyverno rejects it. Deploy the CI-signed image and verify it is admitted."
  ]
}
-->
