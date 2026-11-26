---
id: track-10-lesson-06
title: "أمان الحاويات — فحص الصور وأمان الـ Pods"
slug: container-security
track: track-10
trackName: "السحابة والبنية التحتية وهندسة المنصات"
sequence: 6
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [container-security, Trivy, PSP, seccomp, non-root]
prerequisites: [track-10-lesson-05]
---

# أمان الحاويات — فحص الصور وأمان الـ Pods

> [!NOTE]
> الحاوية ليست حدًا أمنيًا. فالحاويات تتشارك نواة المضيف. وإذا كانت حاوية معالجة دفع تعمل بصلاحيات root مع قدرات Linux زائدة، فقد تخترق ثغرة في تلك الحاوية عقدة المضيف — وكل pod آخر عليها. والضوابط في هذا الدرس ليست تمارين بيروقراطية لملء خانات؛ بل هي الضوابط التقنية التي تمنع هروبًا من حاوية من أن يصبح اختراقًا على مستوى العنقود.

## نموذج أمان الحاويات

أمان الحاويات دفاع متعدد الطبقات عبر أربع طبقات:

1. **طبقة الصورة**: ما في صورة الحاوية (ثغرات، وبرمجيات خبيثة)
2. **طبقة التشغيل**: كيف تعمل الحاوية (root مقابل غير root، والقدرات، واستدعاءات النظام)
3. **طبقة Kubernetes**: ما يُسمح للـ pod بفعله (معايير أمان الـ Pods، وRBAC)
4. **طبقة سلسلة التوريد**: كيف بُنيت الصورة وكيف تم التحقق منها (التوقيع، وSBOM)

---

## 1. فحص صور الحاويات بـ Trivy

يفحص Trivy صور الحاويات بحثًا عن ثغرات CVE معروفة في حزم نظام التشغيل واعتماديات التطبيق. وللخدمات المالية، ادمج Trivy في كل مرحلة من خط CI/CD.

### فحص Trivy في خط CI

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

### ‏Trivy في العنقود (Trivy Operator)

‏Trivy Operator ليس متحكم قبول (admission controller): بل يعيد فحص صور أحمال العمل العاملة باستمرار، فتُكتشف أيضًا الثغرات المنشورة *بعد* النشر.

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

### خط الأساس الأمني لملف Dockerfile

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
> تحتوي صور Distroless فقط على بيئة التشغيل (JRE، وglibc) وتطبيقك. فلا صدفة (`bash`، و`sh`)، ولا مدير حزم، ولا أدوات Unix القياسية. وهذا يقلل بشكل كبير سطح الهجوم وعدد الثغرات في فحوص Trivy. والمفاضلة أنك لا تستطيع فتح صدفة بـ `kubectl exec` داخل حاوية distroless للتصحيح — فاستخدم حاويات تصحيح مؤقتة (ephemeral) بدلًا من ذلك.

---

## 2. معايير أمان الـ Pods

أزال Kubernetes 1.25 ‏PodSecurityPolicy؛ وبديلها متحكم قبول أمان الـ Pods المدمج (Pod Security Admission)، الذي يفرض معايير أمان الـ Pods ‏(PSS) عبر تسميات مساحات الأسماء `pod-security.kubernetes.io`.

### مستويات PSS الثلاثة

| المستوى | الوصف | حالة الاستخدام |
|---|---|---|
| Privileged | بلا قيود | مكونات النظام فقط |
| Baseline | يمنع تصعيد الصلاحيات المعروف | أحمال العمل العامة |
| Restricted | مقوّى؛ يتطلب عدم استخدام root، ومنع تصعيد الصلاحيات، وإسقاط كل القدرات، وملف seccomp | الخدمات المالية |

### الفرض على مستوى مساحة الأسماء

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

### مواصفة Pod متوافقة مع PSS ‏Restricted

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

## 3. ملفات Seccomp

يقيّد Seccomp ‏(Secure Computing Mode) استدعاءات نظام Linux التي يمكن لعملية الحاوية إجراؤها. فمعالج الدفع لا يحتاج `ptrace`، أو `reboot`، أو `kexec_load` — وحجبها يقلل نطاق ضرر اختراق الحاوية.

### ملف RuntimeDefault

يحجب ملف seccomp ‏`RuntimeDefault` (الذي يوفره containerd/CRI-O) عشرات استدعاءات النظام الخطرة التي لا تستخدمها حاويات التطبيقات المعتادة أبدًا — مثل `kexec_load`، و`reboot`، و`mount`، و`ptrace` على النوى الأقدم، و`bpf`. وهذا هو الحد الأدنى لأحمال العمل المالية الإنتاجية.

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

### ملف Seccomp مخصص لخدمة الدفع

لأقصى تقييد، أنشئ ملفًا مخصصًا يسمح فقط باستدعاءات النظام التي يستخدمها تطبيق Java فعلًا.

> [!WARNING]
> القائمة أدناه توضيح مختصر — فـ JVM الحقيقية تحتاج أكثر (مثل `rt_sigreturn`، و`sigaltstack`، و`madvise`، و`prctl`، و`gettid`، و`newfstatat`/`statx`، و`pread64`، و`clock_nanosleep`)، والمجموعة الدقيقة تعتمد على إصدار JDK، وجامع القمامة، والمكتبات. لا تكتب القائمة يدويًا: **سجّلها** (Security Profiles Operator، أو `strace -f -c` تحت حمل اختبار كامل)، وراجعها، واختبر كل مسار في الشيفرة — فاستدعاء نظام ناقص يُسقط الخدمة في الإنتاج. وتحتاج كل عقدة kubelet أيضًا ملف الإعداد.

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

## 4. ملفات AppArmor

يوفر AppArmor ضبط وصول إلزاميًا على مستوى نظام الملفات والشبكة. ويكمّل seccomp (ترشيح استدعاءات النظام) بتقييد الملفات وعمليات الشبكة التي يمكن للعملية الوصول إليها.

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

## 5. إسقاط قدرات Linux

تقسّم قدرات Linux صلاحيات root إلى وحدات متمايزة. وخدمة دفع بـ Java لا تحتاج أيًا منها. وإسقاط كل القدرات صحيح ومطلوب في معيار أمان الـ Pods ‏Restricted.

```yaml
# Every production container in a financial platform should have:
securityContext:
  capabilities:
    drop: ["ALL"]
  # Only add back if absolutely required (almost never for financial services):
  # add: ["NET_BIND_SERVICE"]  # only if binding port < 1024 (don't — use port 8080)
```

قدرات يجب ألا تملكها حاويات الخدمات المالية أبدًا:

| القدرة | لماذا هي خطرة |
|---|---|
| `SYS_ADMIN` | تعادل root — تستطيع تحميل أنظمة الملفات وتعديل معاملات النواة |
| `NET_ADMIN` | تستطيع تعديل واجهات الشبكة وجداول التوجيه — حركة جانبية |
| `SYS_PTRACE` | تستطيع فحص ذاكرة أي عملية — سرقة بيانات الاعتماد |
| `DAC_OVERRIDE` | تتجاوز فحوص صلاحيات الملفات — تسريب البيانات |
| `SETUID` | تغيير UID — تصعيد الصلاحيات |

---

## 6. توقيع الصور بـ Cosign

ينشئ توقيع الصور سلسلة حيازة قابلة للتحقق من خط CI إلى الإنتاج. ومع سياسة قبول، لا يمكن تشغيل إلا الصور الموقعة من نظام CI لديك في الإنتاج.

### التوقيع في خط CI

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

### سياسة قبول بـ Kyverno: الصور الموقعة فقط

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

## 7. سياسات قبول OPA/Kyverno لأحمال العمل المالية

تعمل سياسات Kyverno كـ webhooks قبول، فتتحقق من مواصفات الـ pods أو تعدّلها قبل قبولها.

### مجموعة سياسات شاملة

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

## قائمة تحقق الإنتاج

- [ ] فحص Trivy مدمج في خط CI — يمنع دمج الثغرات CRITICAL/HIGH
- [ ] ‏Trivy Operator يعمل في العنقود — ينبّه على الثغرات الجديدة في الصور العاملة
- [ ] كل صور الإنتاج مبنية على distroless أو أساس مصغّر (بلا صدفة)
- [ ] معيار أمان الـ Pods ‏`Restricted` مفروض على كل مساحات الأسماء الخاضعة للتنظيم
- [ ] ‏`runAsNonRoot: true` و`runAsUser` مضبوط على UID غير صفري
- [ ] ‏`readOnlyRootFilesystem: true` — والمجلدات القابلة للكتابة معرّفة صراحة
- [ ] ‏`allowPrivilegeEscalation: false` على كل الحاويات
- [ ] ‏`capabilities.drop: [ALL]` — بلا إعادة إضافة قدرات
- [ ] ملف seccomp ‏RuntimeDefault مطبّق (كحد أدنى)
- [ ] توقيع الصور بـ Cosign في CI (بالـ digest)؛ وKyverno يتحقق من التوقيعات عند القبول
- [ ] إجراءات CI والصور الأساسية مثبتة (commit SHA / digest)
- [ ] ‏SBOM يُولّد ويُخزّن لكل صورة إنتاجية
- [ ] سياسة Kyverno: لا وسوم `latest` في الإنتاج
- [ ] سياسة Kyverno: حدود الموارد مطلوبة
- [ ] ‏`automountServiceAccountToken: false` للـ pods التي لا تحتاج الوصول إلى واجهة Kubernetes

---

## الملخص

أمان الحاويات في منصة مالية ليس ضابطًا واحدًا — بل حزمة. يلتقط Trivy الثغرات المعروفة في سلسلة التوريد قبل وصول الصور إلى الإنتاج. ويضمن معيار أمان الـ Pods ‏Restricted، مع سياسات قبول Kyverno، أن كل pod يعمل بأدنى صلاحية على طبقة Kubernetes. وتقيّد ملفات Seccomp وAppArmor التفاعلات على مستوى النواة، فتقلل كثيرًا ما يستطيع استغلال ناجح للحاوية فعله. ويغلق توقيع الصور بـ Cosign سلسلة التوريد: فحتى لو اخترق مهاجم اعتمادية، لا يمكن قبول صورة غير موقعة في عنقود الإنتاج. ولكل طبقة قيمتها المستقلة؛ ومعًا تغطي الضوابط المتعلقة بالحاويات التي تبحث عنها تدقيقات PCI-DSS، وSOC 2 Type II، وISO 27001.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "يستخدم ملف Dockerfile ‏`FROM ubuntu:latest` كصورة أساس، ويعمل بصلاحيات root، ويثبّت أدوات البناء في الصورة النهائية. أي نتيجة لـ Trivy هي الأرجح أن توقف خط CI بخطورة CRITICAL؟",
      "options": [
        "استخدام الوسم 'latest' — يفشل Trivy دائمًا على الوسوم المتحركة",
        "ثغرات CVE معروفة في حزم صورة الأساس ubuntu:latest (مثل glibc، وopenssl) لها إصلاحات متاحة، مُبلغ عنها كـ CRITICAL أو HIGH",
        "غياب توجيه USER — يُفشل Trivy كل الصور التي تعمل بصلاحيات root",
        "وجود أدوات البناء — يعلّم Trivy الحزم غير المستخدمة كثغرة حرجة"
      ],
      "correct": 1,
      "explanation": "‏Trivy فاحص ثغرات — يحدد ثغرات CVE في حزم نظام التشغيل واعتماديات التطبيق بمقارنة الإصدارات المثبتة بقواعد بيانات الثغرات (NVD، وRed Hat، ومتتبع ثغرات Ubuntu). وكثيرًا ما تحتوي ubuntu:latest حزمًا بثغرات معروفة (خاصة في المكتبات الأساسية مثل glibc، وopenssl، وcurl). ويُطلق EXIT_CODE=1 في الخط عند وجود ثغرات بالخطورة المضبوطة أو أعلى (عادةً CRITICAL). أما توجيه USER والوسوم المتحركة فمسائل أفضل ممارسات لكنها ليست نتائج ثغرات في Trivy."
    },
    {
      "text": "تتطلب ClusterPolicy في Kyverno أن تملك كل الحاويات readOnlyRootFilesystem: true. ينشر مطوّر pod دون هذا الحقل. ماذا يحدث، وكيف يصلحه المطوّر؟",
      "options": [
        "يُنشر الـ pod مع تحذير، لكن readOnlyRootFilesystem لا يُفرض وقت التشغيل",
        "يُرفض الـ pod من webhook القبول في Kyverno برسالة مخالفة سياسة. ويجب على المطوّر إضافة securityContext.readOnlyRootFilesystem: true إلى مواصفة الحاوية، وتحميل مجلدات emptyDir لأي مسارات يحتاج التطبيق الكتابة فيها",
        "يعدّل Kyverno الـ pod تلقائيًا لإضافة readOnlyRootFilesystem: true دون تدخل المطوّر",
        "يعمل الـ pod طبيعيًا — فسياسات Kyverno ‏ClusterPolicies تنطبق فقط على مساحات الأسماء الجديدة، لا على النشرات الموجودة"
      ],
      "correct": 1,
      "explanation": "سياسة تحقق في Kyverno بوضع Enforce ‏(validationFailureAction: Enforce، أو failureAction: Enforce لكل قاعدة) تمنع الموارد غير الممتثلة في مرحلة القبول في خادم الواجهة — فلا يُنشأ الـ pod أبدًا. ويجب على المطوّر إضافة readOnlyRootFilesystem: true إلى securityContext الحاوية. والتطبيقات التي تكتب ملفات مؤقتة (سجلات، وملفات PID، إلخ) تحتاج مجلدات emptyDir محمّلة على مسارات الكتابة المحددة. ويمكن ضبط Kyverno أيضًا للتعديل (إضافة الحقل تلقائيًا)، لكن التحقق بوضع Enforce هو ما يمنع الـ pod هنا. (وفي وضع Audit يُقبل الـ pod ويُكتب تقرير سياسة فقط.)"
    },
    {
      "text": "تُبنى صورة وتوقَّع بـ Cosign باستخدام التوقيع بلا مفاتيح عبر OIDC ‏(sigstore). وتتحقق سياسة Kyverno من التوقيع باستخدام مُصدر OIDC والموضوع (subject). إذا أعاد مهاجم بناء الصورة نفسها من ملف Dockerfile نفسه دون المرور بخط CI، فما الذي يمنع نشر صورة المهاجم؟",
      "options": [
        "سيكون digest الصورة (SHA256) متطابقًا لملف Dockerfile نفسه، فيغطي التوقيع الموجود صورة المهاجم أيضًا",
        "تفتقر صورة المهاجم إلى توقيع Cosign من هوية OIDC الموثوقة (حساب خدمة خط CI/CD). وترفض سياسة التحقق من الصور في Kyverno الصور التي ليس لها توقيع صالح من المُصدر والموضوع المتوقعين",
        "ترفض سجلات الحاويات تلقائيًا الدفع من مصادر خارج خط CI",
        "لا يمكن استخدام الوسم 'latest' دون ترقية عبر خط CI، فيُمنع دفع المهاجم"
      ],
      "correct": 1,
      "explanation": "يربط التوقيع بلا مفاتيح في Cosign التوقيع بـ digest الصورة وبهوية OIDC التي وقّعت — عادةً سير عمل GitHub Actions في خط الإصدار. وإعادة البناء خارج CI لا تنتج تقريبًا أبدًا الـ digest نفسه (فالطوابع الزمنية وبيانات البناء تختلف؛ والبناء القابل لإعادة الإنتاج بتًا ببت يتطلب جهدًا مقصودًا)، فلا توقيع لصورة المهاجم، ولا يستطيع المهاجم الحصول على توقيع للمُصدر المتوقع (https://token.actions.githubusercontent.com) والموضوع (المستودع وسير العمل المحددين). فيرفضها Kyverno. ولو كانت إعادة البناء متطابقة بايتًا ببايت، لانطبق التوقيع الموجود — لكنها حينها المحتوى المعتمد نفسه بالضبط، فلا يعمل شيء غير موثوق."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "خط أمان الحاويات لصورة خدمة دفع",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "اكتب ملف Dockerfile آمنًا متعدد المراحل لواجهة payment-api في Spring Boot: المرحلة 1 تستخدم eclipse-temurin:21-jdk كبيئة بناء، والمرحلة 2 تستخدم gcr.io/distroless/java21-debian12 كبيئة تشغيل، وتعمل كمستخدم غير root ‏(UID 10001)، وتستبعد كل أدوات البناء واعتماديات الاختبار. وشغّل Trivy على الصورة الناتجة وتحقق من عدم وجود ثغرات CRITICAL أو HIGH. ووثّق أي ثغرات وُجدت وهل لها إصلاحات متاحة.",
    "أنشئ ClusterPolicy في Kyverno باسم payment-pod-security تتحقق من: أن للحاويات حدود معالج وذاكرة مضبوطة، وأن readOnlyRootFilesystem تساوي true، وأن allowPrivilegeEscalation تساوي false، وأن وسم الصورة ليس 'latest'. واضبط السياسة على وضع Enforce. وحاول نشر pod غير ممتثل والتقط رسالة رفض القبول. ثم أصلح مواصفة الـ pod وتأكد من قبوله.",
    "ابنِ ملف seccomp لواجهة payment-api ‏بـ**تسجيل** استدعاءات النظام التي تستخدمها (Security Profiles Operator، أو strace -f تحت حمل اختبار كامل)، ثم راجعه وضيّقه. وطبّقه عبر securityContext.seccompProfile.type=Localhost في مواصفة الـ pod مشيرًا إلى ملف الإعداد. وشغّل payment-api عبر حزمة اختباراتها الكاملة وتحقق من عملها، ثم تحقق من حجب استدعاء نظام خارج الملف (مثل برنامج اختبار صغير في الـ pod يستدعي mount أو unshare فيفشل بـ EPERM).",
    "أعدّ توقيع الصور بلا مفاتيح بـ Cosign في سير عمل GitHub Actions: استخدم رمز OIDC من GitHub لتوقيع صورة payment-api بعد نجاح فحص Trivy. وثبّت ClusterPolicy في Kyverno تتحقق من توقيع الصورة باستخدام مُصدر OIDC من GitHub ‏(https://token.actions.githubusercontent.com) وموضوع المستودع المحدد. وانشر صورة غير موقعة مباشرة وتحقق من رفض Kyverno لها. وانشر الصورة الموقعة من CI وتحقق من قبولها."
  ]
}
-->
