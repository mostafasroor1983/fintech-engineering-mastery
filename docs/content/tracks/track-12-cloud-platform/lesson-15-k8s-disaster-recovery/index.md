---
id: track-12-lesson-15
title: "Disaster Recovery on Kubernetes — Backup and Restore"
slug: k8s-disaster-recovery
track: track-12
trackName: "Cloud Platform & Kubernetes"
sequence: 15
difficulty: advanced
estimatedMinutes: 80
status: published
tags: [K8s-DR, Velero, backup, restore, RTO]
prerequisites: []
---

# Disaster Recovery on Kubernetes — Backup and Restore

> [!NOTE]
> A Kubernetes cluster is not inherently durable. The control plane (etcd) can fail, namespaces can be accidentally deleted, and entire cloud regions can go down. Without tested backup and restore procedures, a cluster failure at a fintech company means reconstructing the entire platform from memory, documentation (if it exists), and Terraform — a process that takes days, not hours. Velero reduces cluster restore time from days to hours, and an automated DR drill reduces it further by ensuring your backups are actually restorable.

## Disaster Recovery Terminology

```
Recovery Time Objective (RTO):
  Maximum acceptable time to restore service after a disaster.
  For payment API: 4 hours (SLA with enterprise customers)
  For settlement jobs: 24 hours (can process next day)
  For audit logging: 48 hours (read-only compliance data)

Recovery Point Objective (RPO):
  Maximum acceptable data loss (how old can the restored state be).
  For payment ledger: 15 minutes (1 missed backup window is acceptable)
  For Kafka topics: 1 hour (messages are replayed from upstream if needed)
  For Kubernetes manifests: 24 hours (manifests are in Git — full restore from Git)

RTO and RPO drive backup frequency and restore requirements:
  RPO = 15min → backup every 15 minutes (or use sync replication)
  RTO = 4hr   → test restore procedure quarterly to verify it completes in <4hr
```

---

## Velero Architecture

Velero backs up Kubernetes resources (manifests) and persistent volume data (EBS snapshots).

```
Velero Architecture:

  Velero Server (runs in cluster as a Deployment)
       |
       ├── Backup Controller
       │     - Watches BackupSchedule objects
       │     - On schedule: serialize all K8s manifests to object storage
       │     - Trigger CSI snapshot for all PVCs
       │
       ├── Restore Controller
       │     - Watches Restore objects
       │     - Downloads manifests from object storage
       │     - Re-creates K8s resources
       │     - Restores PVC data from snapshots
       │
       └── Plugin Framework
             - Object storage plugin (AWS S3)
             - Volume snapshot plugin (AWS EBS CSI)

Backup stored in S3:
  s3://fintech-velero-backups/
    └── payment-prod-us-east-1/
        └── backups/
            ├── daily-2026-11-07-02-00/
            │   ├── payment-prod-us-east-1-backup.tar.gz  (K8s manifests)
            │   └── velero-backup.json                    (backup metadata)
            └── daily-2026-11-08-02-00/
                ├── ...

Volume snapshots stored as EBS snapshots (linked in backup metadata).
```

---

## Installing Velero

```bash
# Install Velero CLI
curl -LO https://github.com/vmware-tanzu/velero/releases/download/v1.13.0/velero-v1.13.0-linux-amd64.tar.gz
tar -xzf velero-v1.13.0-linux-amd64.tar.gz
sudo mv velero-v1.13.0-linux-amd64/velero /usr/local/bin/

# Create S3 bucket for backups
aws s3api create-bucket \
  --bucket fintech-velero-backups-us-east-1 \
  --region us-east-1
  
# Enable versioning (protects against accidental backup deletion)
aws s3api put-bucket-versioning \
  --bucket fintech-velero-backups-us-east-1 \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket fintech-velero-backups-us-east-1 \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "arn:aws:kms:us-east-1:123456789:key/backup-key"
      }
    }]
  }'

# Install Velero on the cluster using IRSA (IAM Roles for Service Accounts)
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket fintech-velero-backups-us-east-1 \
  --backup-location-config region=us-east-1 \
  --snapshot-location-config region=us-east-1 \
  --service-account-annotations "eks.amazonaws.com/role-arn=arn:aws:iam::123456789:role/velero-backup-role" \
  --features=EnableCSI  # enable CSI snapshot support

# Verify installation
velero backup-location get
# Expected: backup-location is "Available"
```

---

## BackupSchedule Configuration

### Namespace-Level Backup (Most Common)

```yaml
# Daily backup of all payment-related namespaces
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: payment-namespaces-daily
  namespace: velero
spec:
  schedule: "0 2 * * *"  # 02:00 UTC daily

  template:
    # Include specific namespaces for payment platform
    includedNamespaces:
      - payments
      - fraud
      - compliance
      - risk
      - audit

    # Include cluster-scoped resources referenced by these namespaces
    includeClusterResources: true

    # Storage location
    storageLocation: default  # the BackupStorageLocation configured in Velero

    # Volume snapshot location
    volumeSnapshotLocations:
      - default

    # Backup TTL: retain for 30 days
    ttl: 720h0m0s  # 30 days

    # Labels for filtering
    labelSelector:
      matchLabels:
        fintech.io/backup: "true"  # only back up labeled resources

    # Hooks: quiesce application before backup for consistency
    hooks:
      resources:
        - name: postgresql-quiesce
          includedNamespaces: [payments]
          labelSelector:
            matchLabels:
              app: payment-postgres
          pre:
            # Checkpoint PostgreSQL before snapshot
            - exec:
                container: postgres
                command:
                  - /bin/bash
                  - -c
                  - psql -U postgres -c "CHECKPOINT;" payments
                onError: Fail
                timeout: 60s
          post:
            - exec:
                container: postgres
                command:
                  - /bin/bash
                  - -c
                  - echo "Backup snapshot complete — resuming normal operation"
                onError: Continue
                timeout: 30s
---
# Cluster-level backup (full cluster state including RBAC, CRDs, nodes)
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: cluster-state-daily
  namespace: velero
spec:
  schedule: "0 3 * * *"  # 03:00 UTC daily (1 hour after namespace backup)

  template:
    # All namespaces including kube-system
    includedNamespaces: []  # empty = all namespaces
    includeClusterResources: true

    # Exclude ephemeral resources (saves space and time)
    excludedResources:
      - events
      - events.events.k8s.io
      - backups.velero.io           # don't back up backup objects
      - restores.velero.io          # don't back up restore objects
      - resticrepositories.velero.io

    storageLocation: default
    volumeSnapshotLocations: [default]
    ttl: 168h0m0s  # 7 days for cluster-level backup (manifests are in Git anyway)
```

### Cross-Region Backup Replication

```bash
# Replicate backups to DR region (us-west-2) for region failure scenario
# S3 Cross-Region Replication configuration

aws s3api put-bucket-replication \
  --bucket fintech-velero-backups-us-east-1 \
  --replication-configuration '{
    "Role": "arn:aws:iam::123456789:role/s3-replication-role",
    "Rules": [{
      "ID": "ReplicateToUsWest2",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "Destination": {
        "Bucket": "arn:aws:s3:::fintech-velero-backups-us-west-2",
        "ReplicationTime": {
          "Status": "Enabled",
          "Time": {"Minutes": 15}
        },
        "Metrics": {
          "Status": "Enabled",
          "EventThreshold": {"Minutes": 15}
        },
        "EncryptionConfiguration": {
          "ReplicaKmsKeyID": "arn:aws:kms:us-west-2:123456789:key/backup-key-dr"
        }
      },
      "DeleteMarkerReplication": {"Status": "Enabled"}
    }]
  }'
```

---

## Restore Procedure: New Cluster from Backup

### Step-by-Step Cluster Restore

```bash
#!/bin/bash
# restore-from-backup.sh
# Used when: primary cluster is unrecoverable, restoring to new cluster

set -euo pipefail

NEW_CLUSTER_KUBECONFIG="$1"    # kubeconfig for the new (empty) cluster
BACKUP_NAME="$2"               # e.g., payment-namespaces-daily-2026-11-07-02-00
RESTORE_NAMESPACES="$3"        # e.g., "payments,fraud,compliance"

echo "=== Cluster Restore Procedure ==="
echo "Backup: $BACKUP_NAME"
echo "Target cluster: $NEW_CLUSTER_KUBECONFIG"
echo "Start time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Step 1: Verify Velero is installed on new cluster and can access backup storage
export KUBECONFIG="$NEW_CLUSTER_KUBECONFIG"
velero backup-location get
echo "Backup storage accessible"

# Step 2: Verify the backup exists and is complete
BACKUP_STATUS=$(velero backup describe "$BACKUP_NAME" --details \
  | grep "Phase" | awk '{print $2}')

if [ "$BACKUP_STATUS" != "Completed" ]; then
  echo "ERROR: Backup $BACKUP_NAME is not in Completed state: $BACKUP_STATUS"
  echo "Available backups:"
  velero backup get
  exit 1
fi

echo "Backup verified: $BACKUP_NAME is Completed"

# Step 3: Create restore
velero restore create \
  --from-backup "$BACKUP_NAME" \
  --include-namespaces "$RESTORE_NAMESPACES" \
  --restore-volumes=true \
  --include-cluster-resources=true \
  --wait

# Wait for restore to complete (may take 15-60 minutes depending on data volume)
RESTORE_NAME="${BACKUP_NAME}-restore-$(date +%Y%m%d%H%M)"
echo "Waiting for restore to complete: $RESTORE_NAME"

for i in $(seq 1 120); do
  STATUS=$(velero restore describe "$RESTORE_NAME" | grep "Phase" | awk '{print $2}')
  echo "[$i/120] Restore status: $STATUS"

  if [ "$STATUS" = "Completed" ]; then
    echo "Restore completed successfully"
    break
  elif [ "$STATUS" = "Failed" ] || [ "$STATUS" = "PartiallyFailed" ]; then
    echo "ERROR: Restore failed with status: $STATUS"
    velero restore describe "$RESTORE_NAME" --details
    exit 1
  fi

  sleep 30
done

# Step 4: Verify critical namespaces are restored
for NS in $(echo "$RESTORE_NAMESPACES" | tr ',' ' '); do
  POD_COUNT=$(kubectl get pods -n "$NS" --no-headers 2>/dev/null | wc -l)
  echo "Namespace $NS: $POD_COUNT pods"
  if [ "$POD_COUNT" -eq 0 ]; then
    echo "WARNING: No pods in $NS — check restore logs"
  fi
done

# Step 5: Verify payment database is accessible
echo "Verifying payment database..."
kubectl exec -n payments -it deployment/payment-api -- \
  curl -f http://localhost:8080/actuator/health/db

# Step 6: Verify payment API can accept requests
echo "Verifying payment API..."
kubectl exec -n payments -it deployment/payment-api -- \
  curl -f http://localhost:8080/actuator/health/readiness

echo "=== Restore complete ==="
echo "End time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Next steps:"
echo "  1. Update DNS to point to new cluster load balancers"
echo "  2. Update Global Accelerator endpoint group"
echo "  3. Verify payment processing with test transaction"
echo "  4. Notify operations team: restore complete"
```

---

## etcd Backup for Cluster State

etcd stores all Kubernetes object state. Velero backs up Kubernetes resource manifests by querying the API server, but backing up etcd directly gives you a lower-level recovery option.

```bash
# etcd snapshot backup (run on etcd node or via kubeadm)
# This backs up raw etcd data — more comprehensive than Velero for control plane recovery

ETCD_ENDPOINT="https://127.0.0.1:2379"
ETCD_CACERT="/etc/kubernetes/pki/etcd/ca.crt"
ETCD_CERT="/etc/kubernetes/pki/etcd/healthcheck-client.crt"
ETCD_KEY="/etc/kubernetes/pki/etcd/healthcheck-client.key"
BACKUP_DIR="/backups/etcd"
DATE=$(date +%Y%m%d_%H%M%S)

# Take snapshot
ETCDCTL_API=3 etcdctl snapshot save "$BACKUP_DIR/etcd-snapshot-$DATE.db" \
  --endpoints="$ETCD_ENDPOINT" \
  --cacert="$ETCD_CACERT" \
  --cert="$ETCD_CERT" \
  --key="$ETCD_KEY"

# Verify snapshot
ETCDCTL_API=3 etcdctl snapshot status "$BACKUP_DIR/etcd-snapshot-$DATE.db" \
  --write-out=table

# Upload to S3
aws s3 cp "$BACKUP_DIR/etcd-snapshot-$DATE.db" \
  "s3://fintech-velero-backups-us-east-1/etcd-snapshots/etcd-snapshot-$DATE.db" \
  --sse aws:kms \
  --sse-kms-key-id arn:aws:kms:us-east-1:123456789:key/backup-key

echo "etcd snapshot backed up: etcd-snapshot-$DATE.db"

# Restore from etcd snapshot (disaster recovery, kubeadm cluster)
# ETCDCTL_API=3 etcdctl snapshot restore etcd-snapshot.db \
#   --data-dir=/var/lib/etcd-restore \
#   --initial-cluster="master=https://10.0.1.10:2380" \
#   --initial-advertise-peer-urls="https://10.0.1.10:2380" \
#   --name=master
```

---

## DR Drill Process

A backup that has never been restored is not a backup — it is an untested assumption.

### Quarterly DR Drill Procedure

```bash
#!/bin/bash
# quarterly-dr-drill.sh
# Run quarterly to verify RTO and RPO targets are achievable

echo "=== Quarterly DR Drill ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Cluster: payment-prod-us-east-1"
echo "DR Target: RTO=4hr, RPO=15min"

DRILL_START=$(date +%s)

# Phase 1: Verify backup freshness (RPO check)
LATEST_BACKUP=$(velero backup get --output json | jq -r '.items | sort_by(.metadata.creationTimestamp) | last | .metadata.name')
BACKUP_TIME=$(velero backup get "$LATEST_BACKUP" --output json | jq -r '.metadata.creationTimestamp')
BACKUP_AGE_MINUTES=$(( ($(date +%s) - $(date -d "$BACKUP_TIME" +%s)) / 60 ))

echo "Latest backup: $LATEST_BACKUP (age: ${BACKUP_AGE_MINUTES} minutes)"
if [ "$BACKUP_AGE_MINUTES" -gt 30 ]; then
  echo "WARNING: Latest backup is ${BACKUP_AGE_MINUTES} minutes old — exceeds RPO target of 15 minutes"
fi

# Phase 2: Restore to DR cluster
echo "Restoring to DR cluster (us-west-2)..."
export KUBECONFIG=~/.kube/payment-dr-us-west-2.yaml

RESTORE_START=$(date +%s)
velero restore create \
  --from-backup "$LATEST_BACKUP" \
  --include-namespaces payments \
  --restore-volumes=true \
  --wait
RESTORE_END=$(date +%s)

RESTORE_MINUTES=$(( (RESTORE_END - RESTORE_START) / 60 ))
echo "Restore time: ${RESTORE_MINUTES} minutes"

# Phase 3: Verify restored state
echo "Verifying restored payment-api..."
kubectl rollout status deployment/payment-api -n payments --timeout=300s

echo "Running smoke tests against DR cluster..."
DR_ENDPOINT=$(kubectl get svc payment-api -n payments -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

# Health check
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://$DR_ENDPOINT/actuator/health")
if [ "$HTTP_STATUS" != "200" ]; then
  echo "FAIL: Health check returned $HTTP_STATUS"
  exit 1
fi

# Test payment authorization (against test accounts)
PAYMENT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://$DR_ENDPOINT/v2/payments" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DR_TEST_TOKEN" \
  -d '{"amount": 1.00, "currency": "USD", "source": "test-account-123", "idempotencyKey": "drill-'$(date +%s)'"}')

if [ "$PAYMENT_STATUS" != "201" ]; then
  echo "FAIL: Test payment returned $PAYMENT_STATUS"
  exit 1
fi

echo "PASS: Payment smoke test succeeded"

# Phase 4: Measure RTO
DRILL_END=$(date +%s)
TOTAL_MINUTES=$(( (DRILL_END - DRILL_START) / 60 ))

echo "=== DR Drill Complete ==="
echo "Total time: ${TOTAL_MINUTES} minutes"
echo "RTO target: 240 minutes"
echo "RTO achieved: ${TOTAL_MINUTES} minutes"

if [ "$TOTAL_MINUTES" -gt 240 ]; then
  echo "FAIL: RTO target NOT achieved — investigate bottlenecks"
else
  echo "PASS: RTO target achieved"
fi

# Phase 5: Cleanup DR environment
echo "Cleaning up DR environment..."
kubectl delete namespace payments -n payments --context payment-dr-us-west-2

# Phase 6: Document results
cat > "dr-drill-$(date +%Y%m%d).md" <<EOF
# DR Drill Report — $(date +%Y-%m-%d)
Operator: $USER
Backup used: $LATEST_BACKUP
Backup age: ${BACKUP_AGE_MINUTES} minutes (RPO target: 15 min)
Restore time: ${RESTORE_MINUTES} minutes
Total RTO: ${TOTAL_MINUTES} minutes (target: 240 min)
Smoke tests: PASSED
Issues found: [document any issues here]
Next drill: $(date -d "+3 months" +%Y-%m-%d)
EOF

echo "Report saved: dr-drill-$(date +%Y%m%d).md"
```

---

## Stateless vs Stateful Workload DR

DR strategy differs significantly between stateless and stateful workloads.

```
Stateless workloads (payment-api, fraud-api, compliance-api):
  - No persistent data to restore
  - Recovery = re-deploy from container registry + Git
  - If Git and ECR are in a different region, recovery is fast (< 15 minutes)
  - Velero backup of manifests: good for restoring RBAC, ConfigMaps, Secrets
  - RTO: 15-30 minutes (mostly Kubernetes pod startup time)

Stateful workloads (PostgreSQL, Kafka, Redis):
  - Persistent data must be restored from backup (Velero + EBS snapshots)
  - PostgreSQL: Velero snapshot + pg_basebackup for point-in-time recovery
  - Kafka: topic configuration from Velero, message replay from upstream if possible
  - Redis: usually rebuilt from source of truth (DB) — no need to restore cache
  - RTO: 1-4 hours (dominated by EBS snapshot restore time and DB validation)

Control plane (etcd):
  - If etcd is recoverable: 0 data loss, cluster state intact
  - If etcd snapshot restore: may miss last few minutes of writes
  - EKS: AWS manages etcd — no need to back up etcd separately on EKS
  - Self-managed K8s: back up etcd every 15 minutes
```

---

## Velero Monitoring

```yaml
# Prometheus rules for Velero backup monitoring
groups:
  - name: velero.backup.fintech
    rules:
      # Alert if backup is failing
      - alert: VeleroBackupFailed
        expr: |
          velero_backup_failure_total{schedule="payment-namespaces-daily"} > 0
        for: 0m
        labels:
          severity: critical
          team: payments-platform
        annotations:
          summary: "Velero backup failed — DR capability degraded"
          runbook: "https://wiki.fintech/runbooks/velero-backup-failure"

      # Alert if no backup has completed in 25 hours (missed scheduled backup)
      - alert: VeleroBackupMissed
        expr: |
          time() - velero_backup_last_successful_timestamp{schedule="payment-namespaces-daily"} > 90000
        for: 0m
        labels:
          severity: warning
          team: payments-platform
        annotations:
          summary: "No successful backup in 25 hours — check Velero"

      # Alert if backup duration is too long (indicates sizing issues)
      - alert: VeleroBackupSlowly
        expr: |
          velero_backup_duration_seconds{schedule="payment-namespaces-daily"} > 7200
        labels:
          severity: warning
        annotations:
          summary: "Backup taking > 2 hours — check for large volumes or slow S3"
```

---

## Key Takeaways for Senior Engineers

1. **Test your restore quarterly, not annually** — a restore procedure that works in theory but fails at 3am during a real disaster is not DR. Run the full restore procedure on the DR cluster every quarter, measure the actual RTO, and fix the gaps.

2. **EBS snapshots via Velero are fast but not point-in-time consistent** — for PostgreSQL, combine Velero EBS snapshots with application-level hooks (CHECKPOINT before snapshot) and logical backups (pg_basebackup, pgBackRest) for complete recovery options.

3. **Cross-region backup replication is non-negotiable for financial data** — a backup stored only in the region that just failed is not a backup. Enable S3 Cross-Region Replication to your DR region with a 15-minute SLA.

4. **Stateless services recover from Git + ECR, not from Velero** — your payment API manifest is in Git; the image is in ECR. Velero for stateless services is primarily for RBAC, Secrets, and ConfigMaps, not deployment specs. This simplifies your DR strategy considerably.

5. **etcd backup matters only for self-managed clusters** — EKS manages etcd for you. If you use EKS, focus Velero on application namespaces. For self-managed clusters (kubeadm), add etcd snapshots every 15 minutes to your backup strategy.

6. **Measure RPO against your backup schedule, not your intent** — if your backup schedule is daily but you have a 15-minute RPO commitment, you have a gap. RPO is determined by the actual time between backups, not the target. Close the gap with more frequent backups or synchronous replication.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "A payment platform uses Velero to back up Kubernetes resources and EBS volumes to S3. The backup schedule runs every 6 hours. After a region failure, the team restores from backup. The last backup was 5 hours and 45 minutes before the failure. What is the actual RPO experienced in this scenario and what does it mean for in-flight payments?",
      "options": ["RPO = 0 because Velero uses continuous replication", "RPO = 5 hours 45 minutes; any payment transactions processed in that window are lost and must be recovered through manual reconciliation with payment processors or payment reversal", "RPO = 6 hours because the backup schedule defines the RPO", "RPO = time since last Velero backup minus PostgreSQL WAL lag which reduces the actual data loss"],
      "correct": 1,
      "explanation": "RPO is the maximum acceptable data loss measured in time. With a 6-hour backup schedule, the worst-case RPO is just under 6 hours. In this scenario the actual data loss is 5h45m of payment transactions. For a payment platform this is catastrophic — thousands of payments would be lost. The fix is not faster Velero backups (Velero is for K8s resources, not database WAL) but PostgreSQL streaming replication to a cross-region standby with an RPO of seconds, plus pgBackRest or pg_basebackup with WAL archiving to S3 for point-in-time recovery."
    },
    {
      "text": "A Velero BackupSchedule includes a pre-backup hook: exec command ['psql', '-c', 'CHECKPOINT']. What does this accomplish and why is it important for consistent backups?",
      "options": ["It locks the database to prevent writes during the backup, ensuring a clean snapshot", "It forces PostgreSQL to flush all dirty buffers from shared_buffers to data files, ensuring the EBS snapshot captures a consistent state rather than a partial write that only exists in memory", "It creates a PostgreSQL-level backup that Velero can use instead of the EBS snapshot", "It stops the PostgreSQL service gracefully before the EBS snapshot begins"],
      "correct": 1,
      "explanation": "PostgreSQL maintains a write-ahead log (WAL) and dirty buffer cache. EBS snapshots are point-in-time consistent at the block level, but if PostgreSQL has unflushed dirty pages in shared_buffers at snapshot time, the snapshot may capture a state that PostgreSQL cannot automatically recover from replay. CHECKPOINT forces all dirty buffers to be written to disk and advances the WAL, so the snapshot captures a clean recovery point. PostgreSQL can recover from this snapshot cleanly on startup without needing WAL replay from before the checkpoint."
    },
    {
      "text": "An EKS cluster is destroyed in a region failure. The team executes velero restore --from-backup payment-platform-backup-20241108. The restore completes but the payment-api pods are in ImagePullBackOff state. What is the most likely cause?",
      "options": ["Velero did not restore the Deployment manifests correctly", "The ECR image repository is in the failed region and the restored pods cannot pull images from a cross-region ECR endpoint; images must be replicated to the DR region's ECR or a multi-region registry must be used", "Velero restores pods in a Pending state by design; they need to be manually started", "The Kubernetes version in the DR cluster is different from the source cluster"],
      "correct": 1,
      "explanation": "ECR repositories are regional. If the image registry (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com/payment-api) is in the failed region, pods in the DR region cannot pull images. The DR architecture must include ECR replication: enable cross-region replication in ECR to automatically copy images to the DR region's ECR. Alternatively use a global registry (GitHub Container Registry, Docker Hub) or a cross-region-accessible ECR Public registry. This is a common gap in DR plans that test coverage would catch."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "Design and Test a Complete Kubernetes Disaster Recovery System",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {
      "id": "1",
      "description": "Create a Velero BackupSchedule that backs up the payment namespace every 2 hours with: a pre-backup hook executing psql CHECKPOINT on the PostgreSQL pod, label selector backup.velero.io/include=true to include only production resources, TTL of 7 days (168 hours), S3 bucket in the DR region as the backup storage location. Configure S3 Cross-Region Replication to additionally copy backups to a third region for extra durability. Verify the backup includes: Deployments, Services, ConfigMaps, Secrets, PVCs, and HPA objects."
    },
    {
      "id": "2",
      "description": "Implement a quarterly DR drill automation using a Tekton Pipeline with these tasks: (a) trigger-backup: create an on-demand Velero backup and wait for completion, (b) provision-dr-cluster: use eksctl to provision a minimal DR cluster (3 nodes) in the DR region, (c) restore: velero restore --from-backup with --include-namespaces=payment, (d) smoke-test: execute 100 synthetic payment transactions against the DR endpoint, (e) measure-rto: calculate time from drill-start to first successful payment, (f) teardown: delete the DR cluster. The pipeline must report RTO in the final step and fail if RTO > 15 minutes."
    },
    {
      "id": "3",
      "description": "Design a PostgreSQL DR architecture that achieves RPO <= 5 minutes using: streaming replication to a cross-region hot standby (async replication, lag monitoring with pg_stat_replication), WAL archiving to S3 with pgBackRest (archive every 60 seconds), and a pgBackRest point-in-time recovery runbook. The runbook must include: the exact command to restore to a specific timestamp, estimated restore time for a 500GB database, and the validation query to verify data integrity after restore."
    },
    {
      "id": "4",
      "description": "Implement a DrRecoveryValidator that runs as the final step of any DR restore and validates: (a) all expected Deployments are Ready (not just Created), (b) the payment-api health endpoint returns HTTP 200, (c) a test payment transaction completes successfully end-to-end, (d) PostgreSQL replication lag from the DR standby to the primary is re-established within 5 minutes of restore completion, (e) all PVCs are bound and their capacity matches the backup metadata. The validator must produce a structured DrValidationReport with pass/fail per check and total validation time."
    }
  ]
}
-->
