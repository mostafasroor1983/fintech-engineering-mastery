---
id: track-11-lesson-12
title: "mTLS عمليًا — تدوير الشهادات وSPIFFE"
slug: mtls-certificate-rotation
track: track-11
trackName: "الأمان والمراقبة وهندسة بيئة الإنتاج"
sequence: 12
difficulty: advanced
estimatedMinutes: 75
status: published
tags:
  - mTLS
  - certificate
  - SPIFFE
  - SPIRE
  - cert-manager
  - rotation
  - PKI
prerequisites:
  - track-11-lesson-09
  - track-11-lesson-11
---

# ‏mTLS عمليًا — تدوير الشهادات وSPIFFE

الشهادة المنتهية في خدمة دفع ليست خطرًا نظريًا — بل انقطاع إنتاجي. ومن الأمثلة الموثقة جيدًا انتهاء شهادة برمجيات Ericsson في ديسمبر 2018 الذي أوقف بيانات الهاتف المحمول لـ O2 ومشغلين آخرين، وانقطاع Microsoft Teams في فبراير 2020 بسبب شهادة مصادقة منتهية. ويغطي هذا الدرس آليات TLS المتبادل، والتدوير الآلي للشهادات باستخدام SPIRE وcert-manager، والتكامل مع Vault PKI، ومراقبة انتهاء الشهادات قبل أن يصبح حادثًا.

---

## 1. آليات mTLS

يتحقق TLS القياسي (أحادي الاتجاه) من هوية الخادم فقط. فيفحص العميل شهادة الخادم مقابل سلطة شهادات موثوقة، لكن الخادم يقبل أي عميل. ويضيف TLS المتبادل (mTLS) التحقق العكسي: يتحقق الخادم أيضًا من شهادة العميل.

### مصافحة mTLS

```
Client (payment-service)              Server (account-service)
─────────────────────────             ──────────────────────────
1. ClientHello                   ──►
                                  ◄── 2. ServerHello
                                  ◄── 3. Server Certificate (X.509)
                                  ◄── 4. CertificateRequest (mTLS only)
5. Client Certificate (X.509)    ──►
6. ClientKeyExchange             ──►
7. CertificateVerify             ──►
8. ChangeCipherSpec              ──►
9. Finished                      ──►
                                  ◄── 10. ChangeCipherSpec
                                  ◄── 11. Finished
            Encrypted Application Data
```

(يُظهر المخطط تدفق رسائل TLS 1.2. وفي TLS 1.3 لا يوجد ChangeCipherSpec/ClientKeyExchange، وتنتقل الشهادات — بما فيها شهادة العميل، المرسلة بعد Finished الخاص بالخادم — مشفرة.)

كلتا الشهادتين موقعة من سلطة شهادات موثوقة. ويتحقق كل جانب من:
1. أن الشهادة موقعة من سلطة الشهادات الموثوقة (أو سلطة وسيطة في السلسلة).
2. أن الشهادة لم تنتهِ (`notAfter` في المستقبل).
3. أن الشهادة لم تُلغَ (فحص CRL / OCSP) — وللشهادات قصيرة العمر جدًا (≤ ساعة) تتخطى شبكات خدمات كثيرة فحص الإلغاء وتعتمد على الانتهاء بدلًا منه.
4. أن الاسم البديل للموضوع (SAN) يطابق هوية حمل العمل المتوقعة.

---

## 2. صيغة SPIFFE SVID

‏SVIDs في SPIFFE شهادات X.509 بـ URI Subject Alternative Name يرمّز هوية حمل العمل.

```
Certificate Details:
  Subject: (empty — SPIFFE does not use Subject CN for identity)
  Subject Alternative Name:
    URI: spiffe://fintech.example.com/ns/payments/sa/payment-service

  Validity:
    Not Before: 2026-11-09 10:00:00 UTC
    Not After:  2026-11-09 11:00:00 UTC   (TTL = 1 hour)

  Key Usage: Digital Signature, Key Encipherment
  Extended Key Usage: TLS Web Client Authentication, TLS Web Server Authentication
  
  Issuer: CN=SPIRE Intermediate CA, O=fintech.example.com
```

### لماذا يستخدم SPIFFE ‏URI SAN لا CN

استخدام الاسم الشائع (CN) للتحقق من الهوية مُهمل (RFC 6125، والآن RFC 9525: تحقق مقابل SAN). وروابط URI SAN واضحة، وهرمية، وقابلة للتحليل آليًا. وتربط حزمة الثقة في SPIFFE نطاقات الثقة بسلطات الشهادات الجذرية الخاصة بها، فتتيح الاتحاد بين نطاقات المؤسسات المختلفة.

---

## 3. بنية SPIRE

```
┌───────────────────────────────────────────────────────────────┐
│                       Kubernetes Cluster                       │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │                     SPIRE Server                        │   │
│  │  - Issues SVIDs signed by intermediate CA               │   │
│  │  - Stores registration entries (workload→SPIFFE ID map) │   │
│  │  - Validates node attestation (PSAT token)              │   │
│  │  - Rotates SVIDs every hour (configurable)              │   │
│  └───────────────────────┬────────────────────────────────┘   │
│                           │ gRPC (mTLS)                        │
│            ┌──────────────┴──────────────┐                     │
│            │                             │                     │
│  ┌─────────▼──────────┐   ┌─────────────▼──────────────────┐  │
│  │  SPIRE Agent       │   │  SPIRE Agent                   │  │
│  │  (node: worker-1)  │   │  (node: worker-2)              │  │
│  │  DaemonSet pod     │   │  DaemonSet pod                 │  │
│  └──────────┬─────────┘   └───────────────────────────────-┘  │
│             │ Unix socket /run/spire/agent.sock                 │
│    ┌────────┴───────────┐                                       │
│    │  payment-service   │  (fetches SVID via SPIFFE Workload   │
│    │  (pod on worker-1) │   API — Go/Java/Python SDKs)         │
│    └────────────────────┘                                       │
└───────────────────────────────────────────────────────────────┘
```

### إثبات PSAT في Kubernetes

يثبت وكيل SPIRE هوية العقدة باستخدام رمز حساب خدمة Kubernetes المُسقَط (PSAT). وهذا يمنع pod مخترقًا من انتحال عقدة مختلفة.

```yaml
# SPIRE Agent DaemonSet — excerpt
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire
spec:
  template:
    spec:
      serviceAccountName: spire-agent
      containers:
        - name: spire-agent
          image: ghcr.io/spiffe/spire-agent:1.9.0
          args:
            - -config
            - /run/spire/config/agent.conf
          volumeMounts:
            - name: spire-socket
              mountPath: /run/spire/sockets
            - name: spire-token
              mountPath: /var/run/secrets/tokens
      volumes:
        - name: spire-token
          projected:
            sources:
              - serviceAccountToken:
                  audience: spire-server
                  expirationSeconds: 7200
                  path: spire-agent
        - name: spire-socket
          hostPath:
            path: /run/spire/sockets
            type: DirectoryOrCreate
```

---

## 4. تدوير SVID — إعادة تحميل حية دون توقف

يدوّر SPIRE ‏SVIDs قبل الانتهاء لضمان عدم التوقف. والخط الزمني للتدوير بصلاحية ساعة:

```
t=0h    SVID issued (valid 0h → 1h)
t=0h30  SPIRE agent rotates at 50% TTL — new SVID issued (valid 0h30 → 1h30)
        and pushed to the workload (Workload API watch); new handshakes
        use it immediately
t=0h30  Both old and new SVIDs valid simultaneously
        → connections opened with the old SVID keep working
t=1h00  Old SVID expires — new SVID is the only valid credential
```

تضمن نافذة التداخل اكتمال الاتصالات الجارية التي تستخدم SVID القديم بسلاسة قبل إحالته للتقاعد.

### ‏Java — الاستماع لتحديثات SVID

```java
// java-spiffe-provider: an X509Source keeps the current SVID and trust
// bundle up to date by watching the SPIRE agent. The SSLContext built from
// it asks the source for the CURRENT SVID on every handshake -- so rotation
// needs no manual reload, and existing connections are not dropped.
import io.spiffe.workloadapi.DefaultX509Source;
import io.spiffe.workloadapi.X509Source;
import io.spiffe.provider.SpiffeSslContextFactory;
import io.spiffe.provider.SpiffeSslContextFactory.SslContextOptions;
import io.spiffe.spiffeid.SpiffeId;

@Configuration
public class SpiffeTlsConfig {

    @Bean(destroyMethod = "close")
    public X509Source x509Source() throws Exception {
        // Socket from SPIFFE_ENDPOINT_SOCKET, e.g. unix:/run/spire/sockets/agent.sock
        return DefaultX509Source.newSource();
    }

    @Bean
    public SSLContext spiffeSslContext(X509Source source) throws Exception {
        SslContextOptions options = SslContextOptions.builder()
            .x509Source(source)
            // Authorise peers by SPIFFE ID, not just "signed by our CA"
            .acceptedSpiffeIdsSupplier(() -> Set.of(
                SpiffeId.parse("spiffe://fintech.example.com/ns/core/sa/account-service")))
            .build();
        return SpiffeSslContextFactory.getSslContext(options);
    }
}
// Monitor rotation: export the current SVID's notAfter as a gauge and
// alert if it gets close (e.g. < 15 min left) -- a stalled rotation
// shows there long before connections fail
```

---

## 5. ‏cert-manager مع Vault كواجهة خلفية

يؤتمت cert-manager إصدار الشهادات وتجديدها في Kubernetes باستخدام مواردي `Certificate` و`ClusterIssuer`.

### ‏ClusterIssuer يستخدم Vault PKI

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: vault-issuer
spec:
  vault:
    server: https://vault.vault.svc.cluster.local:8200
    path: pki_int/sign/payment-service  # Vault PKI role path
    caBundle: <base64-encoded-vault-ca-cert>
    auth:
      kubernetes:
        mountPath: /v1/auth/kubernetes
        role: cert-manager
        # Short-lived token requested by cert-manager for this service
        # account (no long-lived token Secret needed)
        serviceAccountRef:
          name: cert-manager-vault
```

### مورد Certificate لخدمة الدفع

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payment-service-tls
  namespace: payments
spec:
  secretName: payment-service-tls-secret   # Kubernetes Secret to store cert + key
  issuerRef:
    name: vault-issuer
    kind: ClusterIssuer
  commonName: payment-service.payments.svc.cluster.local
  dnsNames:
    - payment-service
    - payment-service.payments
    - payment-service.payments.svc
    - payment-service.payments.svc.cluster.local
  uris:
    - "spiffe://fintech.example.com/ns/payments/sa/payment-service"
  duration: 1h      # certificate TTL
  renewBefore: 20m  # renew 20 minutes before expiry (at 40 minutes)
  usages:
    - digital signature
    - key encipherment
    - client auth
    - server auth
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always  # generate new key on every renewal
```

### إعداد محرك أسرار Vault PKI

```bash
# Root CA mount. (In production keep the root OFFLINE -- e.g. an HSM or an
# air-gapped CA -- and let Vault hold only the intermediate.)
vault secrets enable -path=pki pki
vault secrets tune -max-lease-ttl=87600h pki        # default max is 32 days

# Configure root CA (or import an external root)
vault write pki/root/generate/internal \
  common_name="fintech.example.com Root CA" \
  ttl="87600h"   # 10 years

# Intermediate CA on its OWN mount (Vault cannot mount pki/intermediate
# below the existing pki/ mount)
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

# Generate intermediate CSR
vault write -format=json pki_int/intermediate/generate/internal \
  common_name="fintech.example.com Intermediate CA" \
  | jq -r '.data.csr' > intermediate.csr

# Sign intermediate with root
vault write -format=json pki/root/sign-intermediate \
  csr=@intermediate.csr format=pem_bundle ttl="43800h" \
  | jq -r '.data.certificate' > intermediate.pem

# Import signed intermediate
vault write pki_int/intermediate/set-signed certificate=@intermediate.pem

# Create role for payment-service
vault write pki_int/roles/payment-service \
  allowed_domains="payments.svc.cluster.local" \
  allow_subdomains=true \
  allowed_uri_sans="spiffe://fintech.example.com/ns/payments/*" \
  max_ttl="2h" \
  key_type="ec" \
  key_bits=256 \
  require_cn=false \
  server_flag=true \
  client_flag=true
```

---

## 6. تثبيت الشهادات مقابل الثقة القائمة على سلطة الشهادات

| النهج | كيف يعمل | حالة الاستخدام | أثر التدوير |
|----------|-------------|----------|-----------------|
| الثقة القائمة على سلطة الشهادات | الثقة بسلطة الشهادات؛ وقبول أي شهادة توقعها | شبكة خدمات مصغّرة مع SPIRE/cert-manager | صفر — الشهادات الجديدة تُدوَّر تلقائيًا |
| تثبيت سلطة الشهادات الوسيطة | التثبيت على شهادة سلطة وسيطة محددة | تطبيقات الهاتف التي تستدعي واجهة محددة | متوسط — إعادة نشر تطبيق الهاتف حين تُدوَّر السلطة الوسيطة |
| تثبيت الشهادة الطرفية | التثبيت على الشهادة بالضبط (بصمة SHA-256) | واجهات بالغة الحساسية، وتطبيقات البنوك | مرتفع — يجب تحديث كل العملاء مع كل تجديد |

**التوصية لشبكة الخدمات المصغّرة**: استخدم الثقة القائمة على سلطة الشهادات مع شهادات قصيرة العمر (ساعة). وتثبيت الشهادة الطرفية مناسب فقط حين تتحكم في الطرفين وتستطيع تنسيق التدوير — مثل طرفية دفع مدعومة بوحدة HSM تستدعي خادمًا معروفًا.

---

## 7. مراقبة انتهاء الشهادات

### مقاييس Prometheus في cert-manager

```promql
# Renewal overdue: cert-manager should have renewed 10+ minutes ago.
# Works for 1-hour mesh certificates AND 90-day public ones -- a fixed
# "expires within 7 days" threshold would fire permanently for 1h certs
time() > certmanager_certificate_renewal_timestamp_seconds + 600

# Long-lived certificates expiring within 7 days
(certmanager_certificate_expiration_timestamp_seconds - time()) < 7 * 24 * 3600

# Certificates that have already expired
certmanager_certificate_expiration_timestamp_seconds < time()

# Not-ready certificates: one series per condition value (True/False/Unknown)
certmanager_certificate_ready_status{condition="False"} == 1
```

### ‏PrometheusRule: تنبيه انتهاء الشهادات

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: certificate-expiry-alerts
  namespace: monitoring
spec:
  groups:
    - name: certificate.expiry
      rules:
        - alert: CertificateRenewalOverdue
          expr: |
            time() > certmanager_certificate_renewal_timestamp_seconds + 600
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} was not renewed on time"
            description: >
              Renewal of {{ $labels.namespace }}/{{ $labels.name }} is overdue.
              Check CertificateRequest objects and Vault PKI connectivity
              before the certificate expires.

        - alert: CertificateExpired
          expr: |
            certmanager_certificate_expiration_timestamp_seconds < time()
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Certificate {{ $labels.name }} in {{ $labels.namespace }} HAS EXPIRED"
            description: >
              IMMEDIATE ACTION REQUIRED. Certificate {{ $labels.namespace }}/{{ $labels.name }}
              has expired. Services using this certificate will reject connections immediately.
              Run: kubectl cert-manager renew {{ $labels.name }} -n {{ $labels.namespace }}
```

### الشهادات خارج cert-manager (نقاط نهاية TLS)

```yaml
# Blackbox exporter to probe TLS endpoints and check expiry
modules:
  https_2xx_check_cert:
    prober: http
    timeout: 10s
    http:
      valid_http_versions: ["HTTP/1.1", "HTTP/2.0"]
      valid_status_codes: []
      tls_config:
        insecure_skip_verify: false
      fail_if_ssl: false
      fail_if_not_ssl: true
```

```promql
# Days until certificate expiry as probed by blackbox exporter
(probe_ssl_earliest_cert_expiry - time()) / (24 * 3600)
```

---

## 8. الاستجابة لحادث شهادة منتهية

حين تنتهي شهادة في الإنتاج، يجب تنفيذ دليل التشغيل في أقل من 5 دقائق:

```bash
#!/bin/bash
# RUNBOOK: Expired Certificate Emergency Renewal
# Usage: ./renew-cert.sh <namespace> <certificate-name>

NAMESPACE=$1
CERT_NAME=$2

echo "=== Step 1: Check current certificate status ==="
kubectl get certificate "${CERT_NAME}" -n "${NAMESPACE}" -o yaml | grep -E "notAfter|readyStatus|message"

echo "=== Step 2: Force cert-manager to renew immediately ==="
kubectl cert-manager renew "${CERT_NAME}" -n "${NAMESPACE}"

echo "=== Step 3: Watch renewal progress ==="
kubectl get certificaterequest -n "${NAMESPACE}" --watch &
WATCH_PID=$!

echo "=== Step 4: Wait for new certificate to appear in Secret ==="
kubectl wait certificate "${CERT_NAME}" -n "${NAMESPACE}" \
  --for=condition=Ready --timeout=120s

kill ${WATCH_PID}

echo "=== Step 5: Verify new certificate expiry ==="
kubectl get secret "${CERT_NAME}-tls-secret" -n "${NAMESPACE}" \
  -o jsonpath='{.data.tls\.crt}' | base64 -d \
  | openssl x509 -noout -dates

echo "=== Step 6: Rolling restart to pick up new certificate ==="
kubectl rollout restart deployment "${CERT_NAME}" -n "${NAMESPACE}"
kubectl rollout status deployment "${CERT_NAME}" -n "${NAMESPACE}"

echo "=== Done. Verify service connectivity ==="
```

---

## مزالق الإنتاج

### المزلق 1: انتظار انتهاء الشهادة قبل التدوير

يعتمد فريق على تنبيه انتهاء عند 3 أيام. ولشهادة بوابة `duration: 2160h` ‏(90 يومًا) و`renewBefore: 720h` ‏(30 يومًا)، لكن دور Vault PKI غُيّر إلى `max_ttl=720h` — فيرفض Vault كل تجديد ويعيد cert-manager المحاولة بصمت بتراجع أسي. وينطلق التنبيه قبل 3 أيام من الانتهاء، لكن التجديد كان يفشل منذ 27 يومًا.

**الحل**: نبّه على *فشل التجديد*، لا على العمر المتبقي: ينطلق تنبيه "التجديد متأخر" (أعلاه) وتنبيه عدم الجاهزية بمجرد فشل أول محاولة تجديد — قبل الانتهاء بأيام أو أسابيع. وتحقق أيضًا في CI من أن كل `Certificate.duration` يقع ضمن `max_ttl` لدور Vault المُصدر.

```yaml
- alert: CertificateNotReady
  expr: certmanager_certificate_ready_status{condition="False"} == 1
  for: 15m
  labels:
    severity: warning
  annotations:
    summary: "Certificate {{ $labels.name }} is not ready — renewal may be failing"
```

### المزلق 2: التثبيت على الشهادة الطرفية يكسر التدوير

يستخدم تطبيق مصرفي للهاتف تثبيت SSL على بصمة SHA-256 للشهادة الطرفية (`sha256/AAAAAA...`). ويدوّر الخادم إلى شهادة جديدة لـ 90 يومًا. فيواجه كل عملاء الهاتف فورًا إخفاقات في مصافحة SSL. ويستمر الحادث حتى تُبقى الشهادة القديمة حية قسرًا (تُعاد نشر الشهادة) وينتشر تحديث لتطبيق الهاتف.

**الحل**: ثبّت دائمًا على سلطة الشهادات الوسيطة، لا على الشهادة الطرفية. واضبط حزمة تطوير الهاتف بتثبيتين: السلطة الوسيطة الحالية والسلطة الوسيطة التالية (جاهزية للتدوير).

```java
// Android OkHttp — pin to intermediate CA, not leaf
OkHttpClient client = new OkHttpClient.Builder()
    .certificatePinner(
        new CertificatePinner.Builder()
            // Pin intermediate CA (outlives any single leaf cert)
            .add("api.fintech.example.com",
                 "sha256/INTERMEDIATE_CA_HASH_CURRENT")
            // Add next CA before rotating intermediate
            .add("api.fintech.example.com",
                 "sha256/INTERMEDIATE_CA_HASH_NEXT")
            .build()
    )
    .build();
```

### المزلق 3: عدم اختبار تدوير الشهادات في التجهيز

يحدث أول اختبار لتدوير الشهادات في الإنتاج عند الحادية عشرة ليلًا يوم ثلاثاء. وتعمل إعادة التحميل الحية القائمة على SPIRE بشكل صحيح لكن مهمة دفعية قديمة تستخدم شهادة محمّلة كملف وتقرؤها عند البدء فقط. وكانت المهمة الدفعية تعمل منذ 25 يومًا (منذ آخر إعادة تشغيل) فتستمر في استخدام الشهادة المنتهية، فتتوقف كل معالجة المدفوعات الدفعية.

**الحل**: اكتب اختبار تدوير آليًا في التجهيز يعمل أسبوعيًا:

```bash
#!/bin/bash
# cert-rotation-test.sh — run in staging weekly
# 1. Shorten the SVID TTL of the staging entries to 5 minutes (per entry --
#    the server's default TTL lives in server.conf and needs a restart)
for id in $(spire-server entry show -selector k8s:ns:payments -output json \
            | jq -r '.entries[].id'); do
  spire-server entry update -entryID "$id" -x509SVIDTTL 300
done

# 2. Wait for at least two rotations
sleep 600

# 3. Verify all services are still responding
for svc in payment-service account-service fraud-detection; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    https://${svc}.payments.svc.cluster.local/health)
  if [ "${STATUS}" != "200" ]; then
    echo "FAIL: ${svc} returned ${STATUS} after certificate rotation"
    exit 1
  fi
done

# 4. Restore TTL (in practice: re-apply the entries from Git / ClusterSPIFFEID)
for id in $(spire-server entry show -selector k8s:ns:payments -output json \
            | jq -r '.entries[].id'); do
  spire-server entry update -entryID "$id" -x509SVIDTTL 3600
done

echo "Certificate rotation test PASSED"
```

---

## 9. توزيع حزمة ثقة الشهادات

في نشر تقنية مالية متعدد العناقيد أو متعدد السحب، يجب أن تثق الخدمات في العنقود A بسلطة الشهادات التي أصدرت SVIDs في العنقود B. ويوحّد SPIRE الثقة بمشاركة حزم الثقة بين خوادم SPIRE.

### إعداد الاتحاد في SPIRE

```hcl
# spire-server.conf (HCL) — federate with DR cluster
federation {
  bundle_endpoint {
    address = "0.0.0.0"
    port    = 8443
  }

  federates_with "fintech-dr.example.com" {
    bundle_endpoint_url = "https://spire.dr.fintech.example.com:8443"
    bundle_endpoint_profile "https_spiffe" {
      endpoint_spiffe_id = "spiffe://fintech-dr.example.com/spire/server"
    }
  }
}
```

### التحقق من تزامن حزمة الثقة

```bash
# Own trust bundle
spire-server bundle show

# Federated bundles received from other trust domains
spire-server bundle list -id spiffe://fintech-dr.example.com

# Inspect the keys of a bundle in SPIFFE (JWKS) format
spire-server bundle list -id spiffe://fintech-dr.example.com -format spiffe | \
  python3 -c "import sys,json; b=json.load(sys.stdin); \
  [print(x['use'], x.get('x5c','NO CERT')) for x in b.get('keys',[])]"
```

يجب تنسيق تدوير حزمة الثقة: فحين يدوّر عنقود التعافي سلطة شهاداته الجذرية، يجب أن يتلقى العنقود الأساسي حزمة الثقة الجديدة قبل انتهاء السلطة القديمة. وتتولى نقطة الحزمة الآلية في SPIRE هذا بشفافية حين يكون الاتحاد مفعّلًا.

---

## 10. تصحيح mTLS

تظهر مشكلات الشهادات كأخطاء مصافحة TLS مبهمة. واستخدم هذه التقنيات لتشخيصها بسرعة.

### ‏OpenSSL لفحص الشهادة

```bash
# Check certificate served by payment-service
openssl s_client \
  -connect payment-service.payments.svc.cluster.local:8443 \
  -cert /path/to/client.crt \
  -key /path/to/client.key \
  -CAfile /path/to/ca-bundle.pem \
  -showcerts 2>&1 | openssl x509 -noout -text

# Output to look for:
# Subject Alternative Name: URI:spiffe://fintech.example.com/ns/payments/sa/payment-service
# Not After: Nov  9 11:00:00 2026 GMT  (must be in the future)
# Issuer: CN=SPIRE Intermediate CA

# Verify cert against CA bundle
openssl verify -CAfile ca-bundle.pem payment-service.crt
# Expected: payment-service.crt: OK
```

### تصحيح شهادة الوكيل الجانبي في Istio

```bash
# View current certificate held by the payment-service Envoy sidecar
istioctl proxy-config secret payment-service-pod-name \
  -n payments \
  -o json | jq '.dynamicActiveSecrets[0].secret.tlsCertificate.certificateChain'

# Check if mTLS is working between two pods
istioctl experimental authz check \
  pod/payment-service-abc123 \
  -n payments

# View all TLS policies for a pod
istioctl proxy-config listener payment-service-abc123 \
  -n payments --port 8443
```

### رسائل الخطأ الشائعة وأسبابها

| الخطأ | السبب | الحل |
|-------|-------|-----|
| `certificate has expired or is not yet valid` | انتهت صلاحية SVID؛ وفشل التدوير | افحص اتصال وكيل SPIRE؛ وأجبر إعادة جلب SVID |
| `certificate verify failed: unable to get local issuer certificate` | ليس لدى العميل حزمة سلطة الشهادات | حدّث حزمة الثقة من SPIRE؛ وافحص تزامن الاتحاد |
| `no certificate to verify peer against` | الخادم لا يقدم طلب شهادة العميل | فعّل mTLS في PeerAuthentication؛ وافحص إعداد Istio |
| `tls: bad certificate` | شهادة موقعة من سلطة غير موثوقة | تأكد من استخدام الجانبين نطاق ثقة SPIRE نفسه |
| `connection reset by peer` | ‏PeerAuthentication ‏STRICT يرفض النص الصريح | احقن وكيل Istio الجانبي أو اضبط حمل العمل لـ mTLS |

---

## قائمة تحقق الإنتاج

- [ ] مدة صلاحية SPIFFE SVID ساعة أو أقل لكل أحمال عمل مساحات الأسماء المالية
- [ ] تدوير SVID يحدث عند 50% من المدة — متحقق منه في سجلات خادم SPIRE
- [ ] خدمات Java/Go تستخدم Workload API في SPIFFE (مصدر X509 / مزوّد) لإعادة التحميل الحية
- [ ] ‏`renewBefore` في مورد Certificate لـ cert-manager مضبوط على 20 دقيقة على الأقل
- [ ] يستخدم cert-manager ‏Vault PKI كمُصدر (لا ClusterIssuer موقّع ذاتيًا)
- [ ] ‏`max_ttl` لدور Vault PKI يتوافق مع `duration` في cert-manager
- [ ] تنبيه: التجديد متأخر (`time() > certmanager_certificate_renewal_timestamp_seconds + 600`)
- [ ] تنبيه: الشهادات طويلة العمر تنتهي خلال < 7 أيام (تحذير) والمنتهية بالفعل (حرج)
- [ ] تنبيه: ‏`certmanager_certificate_ready_status{condition="False"} == 1` (تنبيه عدم الجاهزية)
- [ ] تطبيقات الهاتف تثبّت على سلطة الشهادات الوسيطة، لا الشهادة الطرفية
- [ ] اختبار تدوير الشهادات يعمل أسبوعيًا في التجهيز
- [ ] دليل تشغيل حادث الشهادة المنتهية موثق ومختبر
- [ ] ‏DaemonSet وكيل SPIRE له `priorityClassName: system-node-critical`
- [ ] قائمة الإلغاء (CRL) في Vault PKI مفعّلة ومتاحة من كل الخدمات

<!-- KNOWLEDGE-CHECK {"questions":[{"text":"لـ X.509 SVID في SPIFFE مدة صلاحية ساعة. وSPIRE مضبوط لتدوير SVIDs عند 50% من المدة. يُصدر SVID جديد عند t=0. متى سيكون SVID الجديد جاهزًا، ومتى ينتهي SVID الأصلي؟","options":["‏SVID الجديد جاهز عند t=30min؛ والأصلي ينتهي عند t=1h. وكلاهما صالح في آن واحد من t=30min إلى t=1h.","‏SVID الجديد جاهز عند t=1h؛ والأصلي ينتهي عند t=1h. بلا نافذة تداخل.","‏SVID الجديد جاهز عند t=45min؛ والأصلي ينتهي عند t=1h. تداخل 15 دقيقة.","‏SVID الجديد جاهز عند t=30min؛ والأصلي ينتهي عند t=30min. بلا تداخل."],"correct":0,"explanation":"يدوّر SPIRE عند 50% من المدة، أي يحدث التدوير عند t=30min لمدة ساعة. ويُصدر SVID الجديد عند t=30min بمدة صلاحية ساعة خاصة به (صالح من t=30min إلى t=1h30min). ويبقى SVID الأصلي صالحًا حتى t=1h. وهذا ينشئ نافذة تداخل 30 دقيقة من t=30min إلى t=1h يكون فيها الاثنان صالحين في آن واحد، فتُصرَّف الاتصالات الجارية بسلاسة دون أي توقف."},{"text":"مورد Certificate في cert-manager مضبوط بـ duration: 1h وrenewBefore: 20m. وصدرت الشهادة آخر مرة عند 10:00 UTC. متى سيحاول cert-manager تجديدها؟","options":["عند 11:00 UTC حين تنتهي الشهادة.","عند 10:40 UTC — قبل 20 دقيقة من الانتهاء عند 11:00.","عند 10:30 UTC — في منتصف عمر الشهادة.","عند 10:20 UTC — بعد 20 دقيقة من الإصدار."],"correct":1,"explanation":"يحسب cert-manager وقت التجديد كالتالي: وقت الانتهاء - renewBefore = ‏11:00 - 20 دقيقة = 10:40 UTC. ويحدد الحقل renewBefore كم قبل الانتهاء يبدأ التجديد، لا كم بعد الإصدار. وهذا يعطي نافذة 20 دقيقة لـ Vault PKI لإصدار الشهادة الجديدة ولتحديث السر قبل انتهاء الشهادة القديمة."},{"text":"يستخدم تطبيق مصرفي للهاتف تثبيت SSL. وتنتقل واجهة الدفع الخلفية من شهادة طرفية لسنتين إلى SPIFFE SVID جديد لساعة واحدة. وكانت بصمة SHA-256 للشهادة الطرفية القديمة مثبتة في تطبيق الهاتف. ماذا سيحدث حين يُدوَّر SVID لأول مرة؟","options":["سيقبل تطبيق الهاتف الشهادة الجديدة بشفافية لأن SPIFFE SVIDs تستخدم سلطة الشهادات نفسها.","سيواجه كل عملاء الهاتف إخفاقات في مصافحة SSL لأن بصمة الشهادة الطرفية المثبتة لم تعد تطابق.","سيخزن تطبيق الهاتف الشهادة القديمة مؤقتًا ويستمر في العمل 7 أيام.","سيكتشف وكيل SPIRE البصمة المثبتة ويوقف التدوير."],"correct":1,"explanation":"يطابق تثبيت الشهادة الطرفية بصمة SHA-256 الدقيقة لشهادة محددة. وحين يُدوَّر SVID (وهذا يحدث كل ساعة مع SPIFFE)، تكون للشهادة الجديدة بصمة مختلفة كليًا. فيرفض كل العملاء ذوي البصمة القديمة المثبتة الشهادة الجديدة بإخفاق في مصافحة SSL. والحل التثبيت على شهادة سلطة الشهادات الوسيطة، التي تبقى مستقرة عبر تدويرات كثيرة للشهادات الطرفية، وتضمين بصمتي السلطة الوسيطة الحالية والتالية لدعم تدوير السلطة الوسيطة."}]} -->

<!-- PRACTICAL-CHALLENGE {"title":"تنفيذ التدوير الآلي للشهادات مع SPIRE وcert-manager","difficulty":"advanced","estimatedMinutes":105,"tasks":[{"id":"1","description":"انشر SPIRE في عنقود kind بمدة صلاحية SVID ‏5 دقائق للاختبار. واضبط إثبات PSAT في Kubernetes. وسجّل مُدخل حمل عمل لـ payment-service بمعرّف SPIFFE ‏spiffe://fintech.example.com/ns/payments/sa/payment-service. واكتب خدمة Java Spring Boot تنفذ مراقب Workload API في SPIFFE، وتسجّل بصمة SVID مع كل تدوير، وتكشف نقطة /identity تعيد معرّف SPIFFE الحالي ووقت انتهاء الشهادة."},{"id":"2","description":"أعدّ Vault PKI بسلطة شهادات جذرية وسلطة وسيطة لـ fintech.example.com. وأنشئ دور PKI لـ payment-service يسمح بـ URI SAN ‏spiffe://fintech.example.com/ns/payments/* مع max_ttl=2h. وانشر cert-manager مع ClusterIssuer يشير إلى Vault. وأنشئ مورد Certificate لـ payment-service بـ duration=1h وrenewBefore=20m. وتحقق من أن cert-manager يجدد الشهادة تلقائيًا وأن سر Kubernetes يُحدّث دون توقف للخدمة."},{"id":"3","description":"اكتب PrometheusRule بثلاث قواعد تنبيه: CertificateNotReady ‏(certmanager_certificate_ready_status{condition=\"False\"} == 1 لمدة 15 دقيقة)، وCertificateRenewalOverdue (تجاوز موعد التجديد بـ 10 دقائق، تحذير)، وCertificateExpired (منتهية بالفعل، حرج). وأنشئ لوحة Grafana تُظهر كل طوابع انتهاء الشهادات مرتبة تصاعديًا. واكتب سكربت دليل تشغيل يجبر cert-manager على تجديد شهادة مسماة ويتحقق من تاريخ الانتهاء الجديد."},{"id":"4","description":"اكتب سكربت اختبار تدوير آلي للشهادات: (1) يقلل مدة صلاحية SVID لمُدخلات التسجيل التجريبية إلى 5 دقائق، (2) ينتظر دورة تدوير واحدة، (3) يتحقق من سلامة payment-service عبر فحص صحة HTTP، (4) يتحقق من تغير بصمة SVID، (5) يعيد المدة الأصلية. واكتب إضافة إلى ذلك اختبارًا يثبت أن تثبيت الشهادة الطرفية يكسر التدوير وأن تثبيت سلطة الشهادات الوسيطة ينجو منه، باستخدام CertificatePinner في OkHttp بالإعدادين مقابل خادم اختبار محلي."}]} -->
