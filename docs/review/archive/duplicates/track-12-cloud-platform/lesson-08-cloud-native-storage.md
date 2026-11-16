---
id: track-12-lesson-08
title: "Cloud-Native Storage — Persistent Volumes and StatefulSets"
slug: cloud-native-storage
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 8
difficulty: advanced
estimatedMinutes: 75
status: published
tags: [PVC, StatefulSet, StorageClass, CSI, EBS]
prerequisites: []
---

# Cloud-Native Storage — Persistent Volumes and StatefulSets

> [!NOTE]
> Kubernetes was designed for stateless workloads, but financial systems are inherently stateful. Payment ledgers, transaction databases, Kafka brokers, and audit logs all require durable, high-performance storage with strict consistency guarantees. Getting storage configuration wrong in a financial platform means data loss, service downtime, or regulatory violations. This lesson covers how to run stateful workloads correctly on Kubernetes.

## The Kubernetes Storage Architecture

```
Kubernetes Storage Stack:

  Application Pod
       |
  PersistentVolumeClaim (PVC) — developer-facing request
       |
  PersistentVolume (PV) — actual storage resource (provisioned by StorageClass)
       |
  StorageClass — defines storage type, provisioner, and parameters
       |
  CSI Driver — cloud-specific implementation (aws-ebs-csi-driver, etc.)
       |
  Cloud Storage (AWS EBS, EFS, Azure Disk, GCP PD)

The key insight: developers request storage via PVC without knowing
the underlying cloud. StorageClass abstracts the cloud specifics.
```

---

## StorageClass: Defining Storage Tiers

Different financial workloads have radically different storage requirements. StorageClass lets you define tiers and let workloads choose.

### AWS EBS Storage Classes for Fintech

```yaml
# StorageClass: gp3 — general purpose SSD
# Use for: application logs, non-critical databases, test environments
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer  # provision in same AZ as pod
reclaimPolicy: Retain                    # NEVER Delete for financial data
allowVolumeExpansion: true
parameters:
  type: gp3
  iops: "3000"        # baseline IOPS for gp3
  throughput: "125"   # MB/s baseline
  encrypted: "true"   # mandatory for PCI-DSS
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/payment-db-key"
---
# StorageClass: io2 — provisioned IOPS SSD
# Use for: PostgreSQL primary, Oracle, high-throughput Kafka brokers
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-io2-database
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  type: io2
  iops: "16000"       # up to 64000 for io2 Block Express
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/payment-db-key"
  blockExpress: "true"  # io2 Block Express: up to 256K IOPS, sub-ms latency
---
# StorageClass: gp3 high-throughput for Kafka
# Use for: Kafka log storage — high throughput, moderate IOPS
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3-kafka
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
parameters:
  type: gp3
  iops: "6000"
  throughput: "500"   # 500 MB/s — Kafka is throughput-bound, not IOPS-bound
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/kafka-key"
```

### Storage Tier Selection Guide

```
Financial workload → StorageClass recommendation:

  PostgreSQL primary (payment ledger):
    ebs-io2-database: 16,000-64,000 IOPS, Sub-ms latency
    Volume size: start at 500GB, monitor and expand

  PostgreSQL read replica:
    ebs-gp3: 3,000-16,000 IOPS, adequate for reads
    Volume size: match primary

  Kafka broker log storage:
    ebs-gp3-kafka: high throughput (500 MB/s), 6,000 IOPS
    Volume size: retention_hours * peak_MB_per_sec * 3600 * replication_factor

  Redis (payment cache):
    Use emptyDir or RAM-backed volume if data is rebuildable
    If persistence required: ebs-gp3 is sufficient

  Audit log storage (append-only):
    ebs-gp3: append workloads are sequential, gp3 is fine
    Consider EFS for audit logs that need cross-AZ read access
```

---

## PersistentVolume and PersistentVolumeClaim Lifecycle

```
PVC Lifecycle:

  1. Developer creates PVC (storage request)
  2. Kubernetes finds matching StorageClass
  3. CSI driver provisions cloud volume (EBS volume)
  4. PV is created and bound to PVC
  5. Pod mounts PVC as a volume
  6. Pod deleted: PVC and PV remain (reclaimPolicy: Retain)
  7. Developer manually deletes PVC when data is no longer needed
  8. PV status → Released (data still on disk)
  9. Manual cleanup: delete PV, then delete EBS volume via console/CLI
```

### Manual PVC for a Standalone Database Pod

```yaml
# PersistentVolumeClaim for a payment database
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: payment-db-data
  namespace: payments
  labels:
    app: payment-db
    tier: database
    team: payments-platform
  annotations:
    # Document the data criticality for operations
    fintech.io/data-classification: "pii-financial"
    fintech.io/backup-tier: "critical"
    fintech.io/rpo: "15m"
spec:
  accessModes:
    - ReadWriteOnce   # EBS volumes are single-node only
  storageClassName: ebs-io2-database
  resources:
    requests:
      storage: 500Gi
---
# Pod using the PVC
apiVersion: v1
kind: Pod
metadata:
  name: payment-db
  namespace: payments
spec:
  containers:
    - name: postgres
      image: postgres:15.4
      env:
        - name: PGDATA
          value: /var/lib/postgresql/data/pgdata
        - name: POSTGRES_DB
          value: payments
        - name: POSTGRES_USER
          valueFrom:
            secretKeyRef:
              name: payment-db-credentials
              key: username
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: payment-db-credentials
              key: password
      volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
      resources:
        requests:
          cpu: "4"
          memory: "16Gi"
        limits:
          cpu: "8"
          memory: "32Gi"
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: payment-db-data
```

---

## StatefulSets: The Right Primitive for Financial Data

StatefulSets provide stable network identities and ordered deployment for stateful applications. They are the correct primitive for PostgreSQL, Kafka, Zookeeper, and similar.

### PostgreSQL StatefulSet

```yaml
# PostgreSQL StatefulSet for payment ledger
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: payment-postgres
  namespace: payments
  labels:
    app: payment-postgres
    team: payments-platform
spec:
  serviceName: payment-postgres-headless  # enables DNS: payment-postgres-0.payment-postgres-headless
  replicas: 3
  selector:
    matchLabels:
      app: payment-postgres
  template:
    metadata:
      labels:
        app: payment-postgres
      annotations:
        # Required for PCI-DSS compliance — document data handling
        fintech.io/data-classification: "pii-financial"
    spec:
      # Anti-affinity: ensure each replica is on a different node
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: [payment-postgres]
              topologyKey: kubernetes.io/hostname

      # Security context — run as non-root
      securityContext:
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999
        runAsNonRoot: true

      containers:
        - name: postgres
          image: postgres:15.4
          ports:
            - containerPort: 5432
              name: postgres
          env:
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
            - name: POSTGRES_DB
              value: payments
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: payment-postgres-credentials
                  key: username
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: payment-postgres-credentials
                  key: password
            # Tuning for financial workload
            - name: POSTGRES_INITDB_ARGS
              value: "--encoding=UTF-8 --locale=en_US.UTF-8"

          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
            - name: config
              mountPath: /etc/postgresql/postgresql.conf
              subPath: postgresql.conf

          resources:
            requests:
              cpu: "4"
              memory: "16Gi"
            limits:
              cpu: "8"
              memory: "32Gi"

          # Liveness: check if postgres is responding
          livenessProbe:
            exec:
              command: [pg_isready, -U, postgres]
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5

          # Readiness: check if postgres is ready to serve queries
          readinessProbe:
            exec:
              command: [pg_isready, -U, postgres]
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3

      volumes:
        - name: config
          configMap:
            name: payment-postgres-config

  # volumeClaimTemplates: each StatefulSet replica gets its own PVC
  # payment-postgres-data-payment-postgres-0
  # payment-postgres-data-payment-postgres-1
  # payment-postgres-data-payment-postgres-2
  volumeClaimTemplates:
    - metadata:
        name: data
        labels:
          app: payment-postgres
        annotations:
          fintech.io/data-classification: "pii-financial"
          fintech.io/backup-tier: "critical"
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: ebs-io2-database
        resources:
          requests:
            storage: 500Gi
---
# Headless service for stable DNS names
apiVersion: v1
kind: Service
metadata:
  name: payment-postgres-headless
  namespace: payments
spec:
  clusterIP: None   # headless
  selector:
    app: payment-postgres
  ports:
    - port: 5432
      name: postgres
---
# Regular service for applications to connect to primary
apiVersion: v1
kind: Service
metadata:
  name: payment-postgres
  namespace: payments
spec:
  selector:
    app: payment-postgres
    role: primary      # label set by Patroni or other HA operator
  ports:
    - port: 5432
      name: postgres
```

### Kafka StatefulSet

```yaml
# Kafka StatefulSet (KRaft mode — no ZooKeeper)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: payments
spec:
  serviceName: kafka-headless
  replicas: 3
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: [kafka]
              topologyKey: topology.kubernetes.io/zone  # spread across AZs

      containers:
        - name: kafka
          image: apache/kafka:3.7.0
          ports:
            - containerPort: 9092
              name: kafka
            - containerPort: 9093
              name: controller
          env:
            - name: KAFKA_NODE_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['kafka.apache.org/node-id']
            - name: KAFKA_PROCESS_ROLES
              value: broker,controller
            - name: KAFKA_LOG_DIRS
              value: /var/kafka/data
            # KRaft quorum — all three nodes
            - name: KAFKA_CONTROLLER_QUORUM_VOTERS
              value: "0@kafka-0.kafka-headless:9093,1@kafka-1.kafka-headless:9093,2@kafka-2.kafka-headless:9093"
            # Financial platform tuning
            - name: KAFKA_LOG_RETENTION_HOURS
              value: "168"       # 7 days retention
            - name: KAFKA_LOG_SEGMENT_BYTES
              value: "1073741824"  # 1GB segments
            - name: KAFKA_NUM_IO_THREADS
              value: "16"
            - name: KAFKA_NUM_NETWORK_THREADS
              value: "8"

          volumeMounts:
            - name: data
              mountPath: /var/kafka/data

          resources:
            requests:
              cpu: "4"
              memory: "8Gi"
            limits:
              cpu: "8"
              memory: "16Gi"

  volumeClaimTemplates:
    - metadata:
        name: data
        annotations:
          fintech.io/data-classification: "financial-events"
          fintech.io/backup-tier: "important"
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: ebs-gp3-kafka
        resources:
          requests:
            storage: 2Ti  # 2TB per broker — size for 7-day retention at peak throughput
```

---

## ReadWriteOnce vs ReadWriteMany

```
Access modes in Kubernetes:

  ReadWriteOnce (RWO):
    - Single node can mount for read/write
    - Supported by: AWS EBS, Azure Disk, GCP Persistent Disk
    - Use for: databases, Kafka brokers (single-node write workloads)
    - EBS volumes are AZ-scoped — pod MUST be in same AZ

  ReadWriteMany (RWX):
    - Multiple nodes can mount simultaneously for read/write
    - Supported by: AWS EFS, Azure Files, NFS, GlusterFS
    - Use for: shared config files, audit log aggregation, ML model weights
    - Higher latency than EBS — do NOT use for OLTP databases

  ReadOnlyMany (ROX):
    - Multiple nodes read-only
    - Use for: shared reference data, static assets

For financial systems:
  Databases (PostgreSQL, MySQL):        → ReadWriteOnce (EBS io2)
  Kafka log storage:                    → ReadWriteOnce (EBS gp3)
  Shared audit logs:                    → ReadWriteMany (EFS)
  ML model weights (fraud detection):   → ReadWriteMany (EFS) or ReadOnlyMany
  Cross-pod config sharing:             → ConfigMap or ReadOnlyMany
```

### EFS StorageClass for Shared Storage

```yaml
# EFS StorageClass for multi-AZ shared access
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: efs-shared
provisioner: efs.csi.aws.com
parameters:
  provisioningMode: efs-ap
  fileSystemId: fs-0abc12345def67890
  directoryPerms: "700"
  gidRangeStart: "1000"
  gidRangeEnd: "2000"
  basePath: "/fintech"
  encrypted: "true"
  kmsKeyId: "arn:aws:kms:us-east-1:123456789:key/efs-key"
---
# PVC using EFS for shared audit log access
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-audit-logs
  namespace: payments
spec:
  accessModes:
    - ReadWriteMany   # EFS supports multi-node access
  storageClassName: efs-shared
  resources:
    requests:
      storage: 100Gi  # EFS is elastic — this is a soft hint
```

---

## Volume Snapshots for Backup

Kubernetes VolumeSnapshot API provides cloud-native backup of PVCs using underlying cloud snapshot capabilities (AWS EBS snapshots).

### VolumeSnapshotClass and Snapshot

```yaml
# VolumeSnapshotClass — defines snapshot provider
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: ebs-snapshot-class
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: ebs.csi.aws.com
deletionPolicy: Retain   # Keep snapshots when VolumeSnapshot object is deleted
parameters:
  # Copy snapshot to another region for DR
  destinationRegions: "us-west-2"
---
# VolumeSnapshot — take a point-in-time snapshot
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: payment-postgres-snapshot-2026-11-08
  namespace: payments
  labels:
    backup-type: daily
    database: payment-postgres
spec:
  volumeSnapshotClassName: ebs-snapshot-class
  source:
    persistentVolumeClaimName: data-payment-postgres-0  # the StatefulSet PVC
```

### Automated Snapshot with CronJob

```yaml
# CronJob to take daily database snapshots
apiVersion: batch/v1
kind: CronJob
metadata:
  name: payment-postgres-snapshot
  namespace: payments
spec:
  # Daily at 02:00 UTC (low-traffic period)
  schedule: "0 2 * * *"
  concurrencyPolicy: Forbid  # Never run two snapshots simultaneously
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: snapshot-manager
          restartPolicy: OnFailure
          containers:
            - name: snapshot-creator
              image: bitnami/kubectl:1.28
              command:
                - /bin/sh
                - -c
                - |
                  DATE=$(date +%Y-%m-%d)
                  # Create snapshot for each replica PVC
                  for i in 0 1 2; do
                    kubectl apply -f - <<EOF
                  apiVersion: snapshot.storage.k8s.io/v1
                  kind: VolumeSnapshot
                  metadata:
                    name: payment-postgres-${DATE}-${i}
                    namespace: payments
                    labels:
                      backup-type: daily
                      replica: "${i}"
                  spec:
                    volumeSnapshotClassName: ebs-snapshot-class
                    source:
                      persistentVolumeClaimName: data-payment-postgres-${i}
                  EOF
                    echo "Created snapshot for replica ${i}"
                  done

                  # Delete snapshots older than 30 days
                  kubectl get volumesnapshot -n payments \
                    -l backup-type=daily \
                    --sort-by=.metadata.creationTimestamp \
                    -o name | head -n -90 | xargs -r kubectl delete -n payments
```

---

## Online PVC Expansion

PVC expansion allows you to increase storage capacity without downtime — critical for financial databases that grow continuously.

```bash
# Step 1: Verify StorageClass supports expansion
kubectl get storageclass ebs-io2-database -o jsonpath='{.allowVolumeExpansion}'
# Expected: true

# Step 2: Edit the PVC to increase storage
kubectl patch pvc data-payment-postgres-0 -n payments \
  -p '{"spec":{"resources":{"requests":{"storage":"1Ti"}}}}'

# Step 3: Monitor expansion progress
kubectl get pvc data-payment-postgres-0 -n payments -w
# STATUS transitions: Bound → Resizing → FileSystemResizePending → Bound
# The 'FileSystemResizePending' state means the cloud volume is expanded
# but the filesystem needs to be resized — happens automatically when pod restarts

# Step 4: Trigger filesystem resize by bouncing the pod (if needed)
# For PostgreSQL, this means a planned failover via Patroni/pg_ctl
kubectl delete pod payment-postgres-0 -n payments
# StatefulSet will recreate the pod, which will trigger filesystem resize

# Step 5: Verify new size
kubectl exec -it payment-postgres-0 -n payments -- df -h /var/lib/postgresql/data
```

---

## Storage Sizing for Financial Workloads

```
PostgreSQL payment ledger sizing:
  Daily transactions:   10M transactions/day
  Row size:             ~500 bytes average
  Daily data growth:    10M * 500B = 5GB/day
  Indexes (2x data):    10GB/day
  WAL logs:             ~2GB/day
  Total daily growth:   ~17GB/day
  30-day rolling:       510GB
  With 20% headroom:    612GB → provision 750GB initial, plan for 1.5TB

Kafka broker sizing:
  Peak throughput:      500 MB/s ingest
  Replication factor:   3
  Retention:            7 days
  Per-broker capacity:  500 MB/s * 86400s * 7 / 3 = ~1TB/day
  → Provision 2TB per broker, monitor retention-based deletion

Redis (payment cache) sizing:
  Active payment keys:  ~100K at peak (1 key per active session)
  Average key size:     ~2KB
  Total:                200MB — Redis is memory-bound, not disk-bound
  Persistence:          RDB snapshots on gp3 — 50GB is more than enough
```

---

## CSI Driver Architecture

```
CSI (Container Storage Interface) Architecture:

  Kubernetes API Server
         |
  External Provisioner Sidecar
  (watches for unbound PVCs, calls CSI driver to provision)
         |
  CSI Controller Plugin (runs as a Deployment)
  - CreateVolume / DeleteVolume
  - AttachVolume / DetachVolume
  - CreateSnapshot / DeleteSnapshot
         |
  CSI Node Plugin (runs as a DaemonSet on every node)
  - NodeStageVolume (mount to staging path)
  - NodePublishVolume (bind mount to pod path)
  - NodeExpandVolume (filesystem resize)
         |
  Cloud API (AWS EBS API, EFS API)

Installing the AWS EBS CSI driver on EKS:
  # via Helm
  helm repo add aws-ebs-csi-driver https://kubernetes-sigs.github.io/aws-ebs-csi-driver
  helm install aws-ebs-csi-driver aws-ebs-csi-driver/aws-ebs-csi-driver \
    --namespace kube-system \
    --set controller.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=\
      arn:aws:iam::123456789:role/ebs-csi-driver-role

  # EKS add-on (simpler, managed by AWS)
  aws eks create-addon \
    --cluster-name payment-cluster \
    --addon-name aws-ebs-csi-driver \
    --service-account-role-arn arn:aws:iam::123456789:role/ebs-csi-driver-role
```

---

## Key Takeaways for Senior Engineers

1. **reclaimPolicy must be Retain for financial data** — `Delete` will destroy your EBS volume when the PVC is deleted. For payment databases and audit logs, always use `Retain` and implement explicit deletion workflows with approval gates.

2. **WaitForFirstConsumer is essential for EBS** — EBS volumes are AZ-scoped. Without `volumeBindingMode: WaitForFirstConsumer`, Kubernetes may provision the volume in the wrong AZ and the pod can never start.

3. **StatefulSets give you volumeClaimTemplates** — this means each replica gets its own independent PVC. Never use a single shared PVC for database replicas — Kafka and PostgreSQL replicas must have independent storage.

4. **io2 Block Express for transaction databases** — gp3 baseline (3000 IOPS) is insufficient for high-throughput OLTP. Payment ledger databases need 16,000-64,000 IOPS. The difference in monthly cost is small compared to the operational cost of storage bottlenecks.

5. **Volume snapshots are not a substitute for logical backups** — EBS snapshots catch everything but are not point-in-time consistent for a running PostgreSQL instance. Use pg_basebackup or pgBackRest for consistent logical backups, and EBS snapshots as a fast-restore fallback.

6. **Online expansion requires AllowVolumeExpansion: true** — ensure this is set before you need it. Discovering a StorageClass does not support expansion when your database is 90% full is a production incident.

<!--KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A StatefulSet for PostgreSQL uses volumeClaimTemplates with reclaimPolicy: Delete. The StatefulSet is scaled down from 3 to 1 replica for maintenance. What happens to the PVCs of the two removed replicas?",
      "options": [
        "The PVCs are automatically deleted along with the pods — reclaimPolicy: Delete ensures immediate cleanup",
        "The PVCs are retained by Kubernetes even when replicas are removed — StatefulSets do not automatically delete PVCs to prevent accidental data loss. The PVCs must be manually deleted",
        "The PVCs are released and become Available for other PVCs to claim",
        "The PVCs are moved to an archived state and can be reattached by scaling the StatefulSet back up"
      ],
      "correct": 1,
      "explanation": "StatefulSets intentionally do NOT delete PVCs when pods are scaled down or removed. This is a safety mechanism — Kubernetes does not risk data loss on a scale-down operation. The PVCs remain Bound to their PVs (which may still have data). reclaimPolicy: Delete applies when a PVC is explicitly deleted, not when a StatefulSet scales down. If you scale the StatefulSet back up, the same PVCs are reattached to the new pods (by name). To free the storage, you must explicitly delete the PVCs after confirming the data is no longer needed."
    },
    {
      "text": "A payment database needs 32,000 IOPS with consistent latency. The team is choosing between gp3 (baseline 3,000 IOPS, max 16,000 IOPS) and io2 Block Express (up to 256,000 IOPS). Which is correct and why?",
      "options": [
        "gp3 with the IOPS setting increased to 32,000 — gp3 supports any IOPS level up to 64,000",
        "io2 Block Express — gp3 maximum is 16,000 provisioned IOPS, insufficient for 32,000 IOPS. io2 Block Express supports up to 256,000 IOPS with sub-millisecond latency required for high-throughput OLTP",
        "gp3 is always the correct choice for Kubernetes — io2 is not supported by the EBS CSI driver",
        "Either volume type works — Kubernetes automatically tiers IOPS based on actual workload demand"
      ],
      "correct": 1,
      "explanation": "gp3 supports a maximum of 16,000 provisioned IOPS regardless of volume size. 32,000 IOPS exceeds this hard limit — gp3 is not suitable. io2 Block Express supports up to 256,000 IOPS and is designed for I/O-intensive databases requiring consistent sub-millisecond latency. The EBS CSI driver fully supports io2 via StorageClass parameters (type: io2, iopsPerGB). The cost premium of io2 over gp3 is justified for payment ledger databases where storage latency directly impacts transaction throughput."
    },
    {
      "text": "An EBS VolumeSnapshot is taken of a running PostgreSQL database at 14:00. A data corruption event is discovered at 15:30. Can the snapshot be used for a consistent restore?",
      "options": [
        "Yes — EBS snapshots are always crash-consistent and suitable for PostgreSQL restore",
        "Yes — EBS snapshots taken with the pre-snapshot hook (pg_start_backup) are application-consistent. Without the hook, the snapshot may require PostgreSQL crash recovery on restore, and any transactions between 14:00 and 15:30 are lost",
        "No — VolumeSnapshots in Kubernetes are only for disaster recovery, not for point-in-time restore",
        "Yes — PostgreSQL's WAL (Write-Ahead Log) will automatically replay all transactions after the snapshot timestamp"
      ],
      "correct": 1,
      "explanation": "EBS snapshots are crash-consistent: they capture the volume state at a point in time, equivalent to a sudden power loss. For PostgreSQL, crash recovery replays the WAL to bring the database to a consistent state on restore, so the restore is usable. However, WAL is only available on the same volume — once the snapshot is restored to a new volume, WAL from after the snapshot time is unavailable. Using a pre-snapshot hook (pg_start_backup / pg_stop_backup or pgBackRest) makes the snapshot application-consistent. All transactions after 14:00 are still lost — the snapshot is a point-in-time recovery target, not a continuous backup solution."
    }
  ]
}
-->

<!--PRACTICAL-CHALLENGE
{
  "title": "Cloud-Native Storage Configuration for Payment Databases",
  "difficulty": "advanced",
  "estimatedMinutes": 50,
  "tasks": [
    "Create three StorageClasses: payment-gp3 (gp3, 3000 IOPS baseline, Retain policy, WaitForFirstConsumer binding), payment-io2 (io2, 16000 IOPS, Retain policy), and payment-efs (EFS, ReadWriteMany for shared audit logs). Deploy a PostgreSQL StatefulSet using payment-io2 for the data volume and verify the PVC is created with the correct StorageClass and that the EBS volume in AWS shows the provisioned IOPS setting.",
    "Configure a VolumeSnapshotClass with the EBS CSI driver and schedule automated hourly snapshots of the PostgreSQL PVC using a CronJob that creates a VolumeSnapshot resource. Verify that snapshots are created successfully and that old snapshots (older than 48 hours) are pruned to control costs. Test a restore: create a new PVC from a snapshot and mount it in a restore pod, then verify the data is readable.",
    "Simulate a storage capacity emergency: fill the PostgreSQL data volume to 85% using pgbench. Without stopping the pod, expand the PVC from 100Gi to 200Gi (the StorageClass must have AllowVolumeExpansion: true). Verify the filesystem is resized online (df -h inside the pod shows the new size) and that PostgreSQL continues accepting writes throughout the expansion.",
    "Design and document the storage sizing calculation for a payment platform processing 1,000 transactions/second: estimate daily data growth (transaction size × rate × 86,400 seconds), add 3-year retention requirement for PCI-DSS compliance, include WAL and index overhead (40%), and add 20% free space buffer. Compare the calculated size against gp3 vs io2 cost per GB-month and recommend the appropriate StorageClass with justification."
  ]
}
-->
