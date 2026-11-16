# Duplicate lesson folders resolved (Phase 1)

Date: 2026-11-13. Rule (from `00-duplicates.md`): keep the folder that `_track.json` references; remove
the other. `00-duplicates.md` itself did not match the disk: it listed folders that did not exist and missed most real
collisions, so this table, built from the disk, replaces it.

No content was lost. Identical and empty orphans were removed; every other orphan was **archived** to
`docs/review/archive/duplicates/<track>/<folder>.md` before removal (git history also keeps the originals).
The **merge candidates** are larger than their keeper and may hold unique material; review them in Phase 2
and merge anything worth keeping into the keeper (the brief's rule), then delete the archive copy.

| Track | Removed folder | Kept folder | Bytes (removed / kept) | Action |
|---|---|---|---|---|
| track-01-architecture | `lesson-02-architectural-decision-records` | `lesson-02-adr-practice` | 22,632 / 27,941 | archived, then removed |
| track-01-architecture | `lesson-18-zero-trust-architecture` | `lesson-18-zero-trust` | 20,604 / 30,533 | archived, then removed |
| track-01-architecture | `lesson-19-strangler-fig-migration` | `lesson-19-strangler-fig` | 34,067 / 43,037 | archived, then removed |
| track-02-distributed-systems | `lesson-10-split-brain-partitions` | `lesson-10-split-brain` | 47,668 / 43,833 | archived, then removed · **merge candidate** (larger than keeper) |
| track-02-distributed-systems | `lesson-15-distributed-event-sourcing` | `lesson-15-event-sourcing` | 31,642 / 31,642 | removed (identical to keeper) |
| track-02-distributed-systems | `lesson-16-exactly-once-semantics` | `lesson-16-exactly-once` | 23,677 / 23,677 | removed (identical to keeper) |
| track-02-distributed-systems | `lesson-18-active-active-multi-region` | `lesson-18-active-active` | 23,666 / 23,666 | removed (identical to keeper) |
| track-08-reliability | `lesson-01-slo-error-budget` | `lesson-01-slo-error-budgets` | 0 / 14,818 | removed (empty folder) |
| track-08-reliability | `lesson-03-bulkhead-pattern` | `lesson-03-bulkhead` | 40,534 / 40,534 | removed (identical to keeper) |
| track-08-reliability | `lesson-07-multi-region-active-active` | `lesson-07-multi-region` | 42,986 / 42,986 | removed (identical to keeper) |
| track-08-reliability | `lesson-13-rate-limiting-reliability` | `lesson-13-rate-limiting` | 48,432 / 48,432 | removed (identical to keeper) |
| track-09-performance | `lesson-13-http2-grpc-performance` | `lesson-13-http2-grpc` | 31,326 / 36,643 | archived, then removed |
| track-09-performance | `lesson-19-db-partitioning-performance` | `lesson-19-db-partitioning` | 23,803 / 28,313 | archived, then removed |
| track-09-performance | `lesson-20-reactive-vs-blocking-perf` | `lesson-20-reactive-vs-blocking` | 23,377 / 29,518 | archived, then removed |
| track-10-database | `lesson-06-table-partitioning` | `lesson-06-partitioning` | 25,392 / 32,475 | archived, then removed |
| track-10-database | `lesson-12-jsonb-semi-structured` | `lesson-12-jsonb` | 33,158 / 27,586 | archived, then removed · **merge candidate** (larger than keeper) |
| track-10-database | `lesson-13-time-series-data` | `lesson-13-time-series` | 30,256 / 31,883 | archived, then removed |
| track-10-database | `lesson-16-query-plan-analysis` | `lesson-16-query-plan` | 21,458 / 22,010 | archived, then removed |
| track-11-messaging | `lesson-05-kafka-exactly-once` | `lesson-05-exactly-once` | 28,859 / 24,670 | archived, then removed · **merge candidate** (larger than keeper) |
| track-11-messaging | `lesson-06-outbox-cdc-debezium` | `lesson-06-outbox-cdc` | 24,569 / 22,227 | archived, then removed · **merge candidate** (larger than keeper) |
| track-11-messaging | `lesson-09-event-sourcing-kafka` | `lesson-09-event-sourcing` | 29,136 / 28,727 | archived, then removed · **merge candidate** (larger than keeper) |
| track-11-messaging | `lesson-10-cqrs-kafka` | `lesson-10-cqrs` | 25,593 / 31,300 | archived, then removed |
| track-11-messaging | `lesson-11-dead-letter-queues` | `lesson-11-dlq` | 22,889 / 29,218 | archived, then removed |
| track-11-messaging | `lesson-15-saga-pattern` | `lesson-15-saga` | 22,861 / 28,984 | archived, then removed |
| track-12-cloud-platform | `lesson-03-kubernetes-networking` | `lesson-03-k8s-networking` | 27,795 / 26,922 | archived, then removed · **merge candidate** (larger than keeper) |
| track-12-cloud-platform | `lesson-05-service-mesh-istio` | `lesson-05-service-mesh` | 25,120 / 23,056 | archived, then removed · **merge candidate** (larger than keeper) |
| track-12-cloud-platform | `lesson-08-cloud-native-storage` | `lesson-08-storage` | 28,910 / 27,001 | archived, then removed · **merge candidate** (larger than keeper) |
| track-12-cloud-platform | `lesson-13-cicd-pipelines` | `lesson-13-cicd` | 32,184 / 27,810 | archived, then removed · **merge candidate** (larger than keeper) |
| track-12-cloud-platform | `lesson-14-canary-deployments` | `lesson-14-canary` | 29,644 / 25,596 | archived, then removed · **merge candidate** (larger than keeper) |
| track-12-cloud-platform | `lesson-15-k8s-disaster-recovery` | `lesson-15-k8s-dr` | 27,031 / 29,528 | archived, then removed |
| track-13-security-observability | `lesson-01-distributed-tracing` | `lesson-01-opentelemetry` | 8,333 / 19,017 | archived, then removed |
| track-13-security-observability | `lesson-02-metrics-prometheus` | `lesson-02-distributed-tracing` | 8,894 / 27,995 | archived, then removed |
| track-13-security-observability | `lesson-03-log-aggregation` | `lesson-03-prometheus` | 9,198 / 26,406 | archived, then removed |
| track-13-security-observability | `lesson-03-prometheus-promql` | `lesson-03-prometheus` | 24,420 / 26,406 | archived, then removed |
| track-13-security-observability | `lesson-04-alerting` | `lesson-04-grafana` | 10,714 / 26,848 | archived, then removed |
| track-13-security-observability | `lesson-04-grafana-dashboards` | `lesson-04-grafana` | 19,817 / 26,848 | archived, then removed |
| track-13-security-observability | `lesson-05-apm` | `lesson-05-structured-logging` | 10,115 / 23,512 | archived, then removed |
| track-13-security-observability | `lesson-09-zero-trust-security` | `lesson-09-zero-trust` | 25,317 / 25,143 | archived, then removed · **merge candidate** (larger than keeper) |
| track-13-security-observability | `lesson-12-mtls-spiffe` | `lesson-12-mtls` | 22,350 / 30,683 | archived, then removed |
| track-13-security-observability | `lesson-13-owasp-top-10` | `lesson-13-owasp` | 24,883 / 41,205 | archived, then removed |
| track-13-security-observability | `lesson-14-penetration-testing` | `lesson-14-pentest` | 21,290 / 27,467 | archived, then removed |
| track-13-security-observability | `lesson-16-data-encryption` | `lesson-16-encryption` | 24,658 / 26,573 | archived, then removed |
| track-13-security-observability | `lesson-20-security-observability-framework` | `lesson-20-decision-framework` | 20,582 / 26,329 | archived, then removed |
| track-14-leadership | `lesson-01-principal-engineer-model` | `lesson-01-principal-operating-model` | 0 / 14,690 | removed (empty folder) |
| track-14-leadership | `lesson-08-cross-team-influence` | `lesson-08-cross-team` | 17,412 / 28,165 | archived, then removed |
| track-14-leadership | `lesson-13-technical-interviewing` | `lesson-13-interviewing` | 17,202 / 32,788 | archived, then removed |
