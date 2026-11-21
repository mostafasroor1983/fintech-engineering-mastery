---
id: track-02-lesson-21
title: "مسألة الجنرالات البيزنطيين في الأنظمة المالية"
slug: byzantine-fault-tolerance
track: track-02
trackName: "هندسة الأنظمة الموزعة"
sequence: 21
difficulty: principal
estimatedMinutes: 70
status: published
tags: [Byzantine, BFT, fault-tolerance, trust, PBFT]
prerequisites: []
---

# مسألة الجنرالات البيزنطيين في الأنظمة المالية

> [!NOTE]
> الأعطال البيزنطية — حيث تتصرف العقد بخبث أو بشكل اعتباطي بدل أن تتوقف ببساطة — هي أصعب فئة من أعطال الأنظمة الموزعة في التحليل. ومع أن معظم البنية التحتية المالية تتعامل مع أعطال التوقف، فقد جعل صعود شبكات البلوك تشين، ومخططات الدفع متعددة الأطراف، والتسوية بين المؤسسات، تحمّلَ الأعطال البيزنطية (BFT) موضوعًا يجب أن يفهمه كل مهندس رئيسي.

## الأعطال البيزنطية مقابل أعطال التوقف

**عطل التوقف** (crash-stop) أبسط نماذج الفشل: إما أن تعمل العقدة بشكل صحيح أو تتوقف عن الرد. وتتعامل Paxos وRaft وZab كلها مع أعطال التوقف. فإذا تعطلت عقدة في منتصف عملية، تبقى متعطلة — ولا ترسل رسائل مضللة إلى العقد الأخرى.

**العطل البيزنطي** أي انحراف عن البروتوكول — بما في ذلك إرسال بيانات خاطئة، أو رسائل متناقضة إلى نظراء مختلفين، أو المشاركة الانتقائية في بعض الجولات دون غيرها، أو محاولة إفساد النظام فعليًا. والاسم مأخوذ من مسألة الجنرالات البيزنطيين.

```
Crash fault:
  Node A: [works correctly]  ───────────────── [crashes, stops]
  Other nodes just see: "A is not responding"

Byzantine fault:
  Node A: [works correctly] ─── [sends vote=YES to B] [sends vote=NO to C] [lies to D]
  Other nodes see contradictory information — cannot determine truth
```

في عطل التوقف ترى العقد الأخرى فقط أن العقدة لا ترد. أما في العطل البيزنطي فترى معلومات متناقضة — تصويت "نعم" لعقدة و"لا" لأخرى — ولا تستطيع تحديد الحقيقة.

في الأنظمة المالية يقابل السلوك البيزنطي:
- معالج دفع مخترق يوافق على المعاملات بانتقائية
- عقدة في شبكة بين المؤسسات توقّع المعاملات مرتين
- مُدقِّق في بلوك تشين يراوغ (يوقّع كتلتين متعارضتين)
- تهديد داخلي يتلاعب بنظام تسوية موزع

---

## مسألة الجنرالات البيزنطيين

قدّم Lamport وShostak وPease **مسألة الجنرالات البيزنطيين** عام 1982. والقصة الرمزية:

> عدة فرق من الجيش البيزنطي تحاصر مدينة معادية. ويقود كل فرقة جنرال. ويجب أن يتفق الجنرالات على خطة مشتركة (الهجوم أو الانسحاب). ولا يتواصلون إلا عبر الرسل. وقد يكون بعض الجنرالات خونة يحاولون منع الجنرالات المخلصين من الاتفاق.

الفكرة الأساسية من الورقة الأصلية:

**مع f عقدة بيزنطية (خائنة)، تحتاج إلى 3f+1 عقدة على الأقل للوصول إلى اتفاق.** (هذا صحيح للرسائل "الشفهية" غير الموقّعة؛ والحد نفسه 3f+1 ينطبق على البروتوكولات العملية في الشبكات الحقيقية شبه المتزامنة حتى مع التوقيعات. ولا تستطيع الرسائل الموقّعة الاكتفاء بأقل إلا في شبكة متزامنة تمامًا.)

لـ f=1 (خائن واحد): تحتاج 4 عقد على الأقل (3×1+1=4)
ولـ f=2 (خائنين): تحتاج 7 عقد على الأقل (3×2+1=7)

وهذا يختلف جوهريًا عن تحمّل أعطال التوقف، الذي يحتاج فقط 2f+1 عقدة (فعطل واحد يحتاج 3 عقد فقط).

```
Why 3f+1?

A node can only wait for n - f replies: up to f nodes may never answer.
Of those n - f replies, up to f may come from traitors.
So at least (n - f) - f = n - 2f replies are honest, and the honest
replies must outnumber the traitors' replies:

    n - 2f > f
    n > 3f
    n >= 3f + 1
```

لا تستطيع العقدة انتظار أكثر من n − f ردًا، لأن f عقدة قد لا ترد أبدًا. ومن هذه الردود قد يأتي f من الخونة. فيبقى n − 2f ردًا صادقًا على الأقل، ويجب أن تفوق الردود الصادقة ردود الخونة: n − 2f > f، أي n ≥ 3f + 1.

---

## تحمّل الأعطال البيزنطية العملي (PBFT)

‏**PBFT**، الذي قدّمه Castro وLiskov عام 1999، كان أول خوارزمية BFT عملية بتعقيد رسائل متعدد الحدود. وهو أساس كثير من بروتوكولات إجماع البلوك تشين.

يعمل PBFT في **مشاهد** (views، مثل الفترات في Raft). ولكل مشهد **أساسي** (قائد) يرتب الطلبات. وللبروتوكول ثلاث مراحل:

1. **ما قبل التحضير (Pre-prepare)**: يبث الأساسي الطلب إلى كل النسخ مع رقم تسلسلي
2. **التحضير (Prepare)**: تبث كل نسخة رسالة PREPARE بعد استلام ما قبل التحضير والتحقق منه
3. **الالتزام (Commit)**: بعد استلام 2f رسالة PREPARE، تبث كل نسخة COMMIT
4. **الرد**: بعد استلام 2f+1 رسالة COMMIT، تنفّذ النسخة الطلب وترد على العميل

ولا يقبل العميل نتيجة إلا بعد استلام f+1 ردًا متطابقًا (من f+1 نسخة مختلفة).

```java
/**
 * Conceptual PBFT implementation for educational purposes.
 * Production BFT implementations require careful cryptographic signing
 * of every message to prevent forgery.
 */
@Service
public class PbftReplica {

    private final String replicaId;
    private final int totalReplicas;  // n = 3f + 1
    private final int faultThreshold; // f = (n-1) / 3

    private final MessageLog messageLog = new MessageLog();
    private final Map<String, Set<PrepareMessage>> prepareLog = new ConcurrentHashMap<>();
    private final Map<String, Set<CommitMessage>> commitLog = new ConcurrentHashMap<>();
    private final Set<String> commitSent = ConcurrentHashMap.newKeySet();   // once per (view, seq)
    private final Set<String> executed   = ConcurrentHashMap.newKeySet();

    public PbftReplica(String replicaId, int totalReplicas) {
        this.replicaId = replicaId;
        this.totalReplicas = totalReplicas;
        this.faultThreshold = (totalReplicas - 1) / 3;

        log.info("PBFT Replica {}: n={}, f={} (tolerates {} Byzantine faults)",
            replicaId, totalReplicas, faultThreshold, faultThreshold);
    }

    /**
     * Phase 1: Primary receives client request and sends PRE-PREPARE to all replicas.
     * The request is assigned a sequence number within the current view.
     */
    public void handleClientRequest(ClientRequest request, long view, long seqNum) {
        if (!isPrimary(view)) {
            throw new NotPrimaryException("Only the primary can send PRE-PREPARE");
        }

        // Sign the message to prevent forgery
        PrePrepareMessage prePrepare = PrePrepareMessage.builder()
            .view(view)
            .sequenceNumber(seqNum)
            .requestDigest(digest(request))
            .request(request)
            .signature(sign(request))
            .build();

        messageLog.record(prePrepare);
        broadcast(prePrepare);
    }

    /**
     * Phase 1 → Phase 2: Backup replica receives PRE-PREPARE, validates, sends PREPARE.
     */
    public void handlePrePrepare(PrePrepareMessage msg) {
        // Validate: correct view, sequence number in valid range, valid signature
        if (!isValid(msg)) {
            log.warn("Rejecting invalid PRE-PREPARE from suspected Byzantine primary");
            return;
        }

        // Check we haven't accepted a different pre-prepare for this (view, seqNum)
        if (messageLog.hasConflictingPrePrepare(msg.view(), msg.sequenceNumber())) {
            log.error("BYZANTINE DETECTED: conflicting PRE-PREPARE for view={} seq={}",
                msg.view(), msg.sequenceNumber());
            initiateViewChange(msg.view()); // Trigger view change to elect new primary
            return;
        }

        messageLog.record(msg);

        PrepareMessage prepare = PrepareMessage.builder()
            .view(msg.view())
            .sequenceNumber(msg.sequenceNumber())
            .requestDigest(msg.requestDigest())
            .replicaId(replicaId)
            .signature(sign(msg))
            .build();

        messageLog.record(prepare);
        broadcast(prepare);
    }

    /**
     * Phase 2 → Phase 3: Replica collects 2f PREPARE messages (plus own),
     * enters "prepared" state, broadcasts COMMIT.
     */
    public void handlePrepare(PrepareMessage msg) {
        // Valid signature AND the digest matches the PRE-PREPARE we accepted
        if (!isValid(msg) || !messageLog.matchesPrePrepare(msg)) return;

        String key = msg.view() + ":" + msg.sequenceNumber();
        prepareLog.computeIfAbsent(key, k -> ConcurrentHashMap.newKeySet()).add(msg);

        // Prepared = the PRE-PREPARE plus 2f matching PREPAREs from different
        // replicas. commitSent.add() is true only once, so COMMIT goes out once.
        if (prepareLog.get(key).size() >= 2 * faultThreshold && commitSent.add(key)) {
            log.debug("Reached prepared state for seq={}", msg.sequenceNumber());

            CommitMessage commit = CommitMessage.builder()
                .view(msg.view())
                .sequenceNumber(msg.sequenceNumber())
                .requestDigest(msg.requestDigest())
                .replicaId(replicaId)
                .signature(sign(msg))
                .build();

            messageLog.record(commit);
            broadcast(commit);
        }
    }

    /**
     * Phase 3 → Execute: Replica collects 2f+1 COMMIT messages,
     * executes the request, sends reply to client.
     */
    public void handleCommit(CommitMessage msg) {
        if (!isValid(msg)) return;

        String key = msg.view() + ":" + msg.sequenceNumber();
        commitLog.computeIfAbsent(key, k -> ConcurrentHashMap.newKeySet()).add(msg);

        // Need 2f+1 matching commits (own included) to reach "committed" state
        if (commitLog.get(key).size() >= 2 * faultThreshold + 1 && executed.add(key)) {
            // Execute the operation (must be in sequence number order)
            executeInOrder(msg.sequenceNumber());
        }
    }

    private void executeInOrder(long seqNum) {
        // Execute all requests in sequence number order
        // Skip already executed, wait for gaps to fill
        log.info("Replica {}: executing request at seq={}", replicaId, seqNum);
        // ... execute business logic, send reply to client
    }

    private boolean isPrimary(long view) {
        // Primary is determined by: view mod n
        return replicaId.equals(replicaIdForView(view));
    }

    private boolean isValid(SignedMessage msg) {
        // Verify cryptographic signature — critical for Byzantine resistance
        return signatureVerifier.verify(msg.signature(), msg.payload());
    }
}
```

النسخة "محضّرة" عندما يكون لديها ما قبل التحضير و2f رسالة PREPARE متطابقة من نسخ مختلفة، ويجب أن يطابق الملخص ما قبل التحضير المقبول. ولا تُرسل رسالة COMMIT ولا يُنفّذ الطلب إلا مرة واحدة لكل (مشهد، رقم تسلسلي). وكل رسالة يجب أن تكون موقّعة تشفيريًا لمنع التزوير.

---

## تغيير المشهد: التعامل مع أساسي بيزنطي

يجب أن يتعامل PBFT مع حالة كون الأساسي بيزنطيًا (خبيثًا). فإذا اكتشفت النسخ أن الأساسي لا يُحرز تقدمًا (بناءً على المهلة)، تبدأ **تغيير المشهد** لانتخاب أساسي جديد.

```java
@Service
public class PbftViewChangeManager {

    private final int faultThreshold;
    private final AtomicLong currentView;

    public void initiateViewChange(long suspectedView) {
        long newView = suspectedView + 1;
        log.warn("Initiating view change: view {} → {}. Primary suspected Byzantine.",
            suspectedView, newView);

        // Carry forward every request this replica has PREPARED (with its
        // proof: the pre-prepare and 2f prepares), so the new primary
        // cannot drop or reorder anything that may already be committed
        List<PreparedState> preparedStates = messageLog.getPreparedSinceCheckpoint();

        ViewChangeMessage viewChange = ViewChangeMessage.builder()
            .newView(newView)
            .lastStableCheckpoint(messageLog.lastStableCheckpoint())
            .preparedProofs(preparedStates)
            .replicaId(replicaId)
            .signature(sign(newView + replicaId))
            .build();

        broadcast(viewChange);
    }

    /**
     * When the new primary has 2f+1 valid VIEW-CHANGE messages (its own
     * included), it broadcasts a NEW-VIEW message and takes over.
     */
    public void handleViewChange(ViewChangeMessage msg) {
        viewChangeLog.add(msg);

        if (viewChangeLog.size(msg.newView()) >= 2 * faultThreshold + 1) {
            if (isPrimaryForView(msg.newView())) {
                log.info("Becoming primary for view {}", msg.newView());
                broadcastNewView(msg.newView(), viewChangeLog.get(msg.newView()));
            }
        }
    }
}
```

تنقل كل نسخة إلى المشهد الجديد كل طلب حضّرته (مع إثباته: ما قبل التحضير و2f تحضيرًا)، فلا يستطيع الأساسي الجديد إسقاط أو إعادة ترتيب أي شيء قد يكون التُزم به. وعندما يجمع الأساسي الجديد 2f+1 رسالة VIEW-CHANGE صالحة (بما فيها رسالته)، يبث NEW-VIEW ويتولى القيادة.

---

## BFT عمليًا في التقنية المالية

### شبكات البلوك تشين

أبرز تطبيق لـ BFT في التقنية المالية هو البلوك تشين. فإثبات العمل (Bitcoin) وإثبات الحصة (Ethereum بعد الدمج) آليات إجماع تتحمل الأعطال البيزنطية، لكنها تضحي بالأداء (الإنتاجية والزمن) مقابل العضوية المفتوحة.

وتختار شبكات البلوك تشين المصرّح بها إجماعها حسب كل نشر:
- **Hyperledger Fabric**: تستخدم خدمة الترتيب Raft (يتحمل التوقف) افتراضيًا؛ وأضاف الإصدار 3.0 من Fabric مرتّبًا بيزنطيًا (SmartBFT)
- **R3 Corda**: تستخدم الموثّقين (notaries) لمنع الإنفاق المزدوج؛ ويمكن أن يعمل عنقود الموثّق ببروتوكول يتحمل التوقف أو ببروتوكول BFT
- **ConsenSys Quorum ‏(GoQuorum / Besu)**: ‏QBFT أو IBFT ‏(BFT)، أو Raft
- **Tendermint / CometBFT**: تستخدمها الشبكات المبنية على Cosmos؛ BFT بنهائية فورية

```java
/**
 * Example: Interacting with a Hyperledger Fabric network
 * for cross-institutional payment settlement.
 * The endorsement policy (k-of-n organisations must sign the result)
 * protects against dishonest peers executing the chaincode; the
 * ordering service is BFT only if a BFT orderer is configured.
 */
@Service
public class FabricPaymentSettlementClient {

    private final Gateway gateway;

    public SettlementResult settlePayment(SettlementRequest request) throws Exception {
        Network network = gateway.getNetwork("settlement-channel");
        Contract contract = network.getContract("payment-settlement");

        // Endorsement policy ensures multiple orgs sign off on the transaction
        byte[] result = contract.submitTransaction(
            "settlePayment",
            request.paymentId(),
            request.debitOrg(),
            request.creditOrg(),
            String.valueOf(request.amountCents()),
            request.currency()
        );

        return SettlementResult.fromBytes(result);
    }

    /**
     * Query with endorsement from multiple peers for Byzantine-safe reads.
     * Querying a single peer is vulnerable to that peer lying.
     */
    public PaymentStatus queryPaymentStatus(String paymentId) throws Exception {
        Network network = gateway.getNetwork("settlement-channel");
        Contract contract = network.getContract("payment-settlement");

        // evaluateTransaction queries peers but doesn't create a transaction
        // For BFT reads, query multiple peers and compare results
        byte[] result = contract.evaluateTransaction("getPaymentStatus", paymentId);
        return PaymentStatus.fromBytes(result);
    }
}
```

تحمي سياسة المصادقة (يجب أن توقّع k من n مؤسسة النتيجة) من النظراء غير الأمناء أثناء تنفيذ العقد الذكي؛ أما خدمة الترتيب فتكون بيزنطية فقط إذا ضُبط مرتّب BFT. والاستعلام من نظير واحد معرّض لكذب ذلك النظير، فاستعلم عدة نظراء وقارن النتائج للقراءات الآمنة بيزنطيًا.

### شبكات الدفع متعددة الأطراف

عندما تشارك عدة مؤسسات مالية في شبكة دفع مشتركة (مثل شبكة عملة رقمية لبنك مركزي، أو نظام تسوية بين البنوك في اتحاد)، يجب أن تتحمل الشبكة السلوك البيزنطي من أي مشارك منفرد.

```java
@Service
public class ConsortiumPaymentValidator {

    private final List<ConsortiumMemberClient> members;
    private final int totalMembers;
    private final int byzantineTolerance;  // f = (n-1)/3

    /**
     * Validate a payment by collecting endorsements from consortium members.
     * Requires f+1 consistent responses to tolerate f Byzantine members.
     *
     * Example: 7 members, f=2 → need 3 consistent responses (f+1=3)
     * to guarantee at least one honest member confirms the result.
     */
    public ValidationResult validatePayment(Payment payment) {
        List<CompletableFuture<MemberValidation>> validations = members.stream()
            .map(member -> CompletableFuture.supplyAsync(() -> {
                try {
                    return member.validate(payment);
                } catch (Exception e) {
                    return MemberValidation.error(member.id(), e.getMessage());
                }
            }).orTimeout(3, TimeUnit.SECONDS)
              .exceptionally(ex -> MemberValidation.timeout(member.id())))
            .collect(Collectors.toList());

        // Collect all responses
        Map<ValidationDecision, List<String>> decisionGroups = validations.stream()
            .map(CompletableFuture::join)
            .filter(MemberValidation::isComplete)
            .collect(Collectors.groupingBy(
                MemberValidation::decision,
                Collectors.mapping(MemberValidation::memberId, Collectors.toList())
            ));

        // Find the decision with f+1 or more consistent votes
        // (guaranteed to be honest if f+1 agree, since we can have at most f liars)
        int requiredConsistentVotes = byzantineTolerance + 1;

        for (Map.Entry<ValidationDecision, List<String>> entry : decisionGroups.entrySet()) {
            if (entry.getValue().size() >= requiredConsistentVotes) {
                log.info("Payment {} validated: decision={} by members={}",
                    payment.id(), entry.getKey(), entry.getValue());
                return ValidationResult.of(entry.getKey(), entry.getValue());
            }
        }

        // No decision reached a threshold — cannot validate
        log.error("Payment {} could not be validated: insufficient consistent votes. " +
            "Byzantine activity suspected.", payment.id());
        return ValidationResult.indeterminate(decisionGroups);
    }
}
```

يُشترط f+1 ردًا متسقًا لتحمّل f عضوًا بيزنطيًا: فمع 7 أعضاء وf=2 تحتاج 3 ردود متسقة، لأن ذلك يضمن أن عضوًا أمينًا واحدًا على الأقل أكّد النتيجة.

---

## متطلب f+1 من 3f+1

فهم **لماذا** يكون 3f+1 هو الحد الأدنى أمر حاسم لتحديد حجم شبكة BFT:

```java
@Component
public class BftNetworkSizer {

    /**
     * Given the number of Byzantine faults to tolerate,
     * returns the minimum cluster size.
     */
    public int minimumClusterSize(int byzantineFaultsToTolerate) {
        return 3 * byzantineFaultsToTolerate + 1;
    }

    /**
     * Given a cluster size, returns the maximum Byzantine faults it can tolerate.
     */
    public int maximumFaults(int clusterSize) {
        return (clusterSize - 1) / 3;
    }

    /**
     * Safety check: will this configuration actually be Byzantine fault tolerant?
     */
    public boolean isBftSafe(int clusterSize, int faultsToTolerate) {
        return clusterSize >= minimumClusterSize(faultsToTolerate);
    }

    /**
     * Practical sizing for consortium payment networks:
     *
     * 4 members: tolerates 1 Byzantine member (one rogue institution)
     * 7 members: tolerates 2 Byzantine members
     * 10 members: tolerates 3 Byzantine members
     *
     * Note: each additional Byzantine member requires 3 more total members.
     * This is why large BFT networks are expensive to scale.
     */
    public void logSizingGuide(int maxExpectedByzantineMembers) {
        for (int f = 1; f <= maxExpectedByzantineMembers; f++) {
            log.info("f={} Byzantine faults: minimum cluster size = {}",
                f, minimumClusterSize(f));
        }
    }
}
```

‏4 أعضاء تتحمل عضوًا بيزنطيًا واحدًا، و7 تتحمل اثنين، و10 تتحمل ثلاثة. فكل عضو بيزنطي إضافي يتطلب 3 أعضاء إضافيين، ولهذا تكون شبكات BFT الكبيرة مكلفة التوسع.

---

## BFT مقابل CFT: متى تستخدم كلًا منهما

بروتوكولات **CFT** (تحمّل أعطال التوقف) مثل Raft وPaxos تفترض أن العقد إما تعمل بشكل صحيح أو تتوقف. وهي أبسط وأسرع وتتطلب عقدًا أقل (2f+1 لـ f عطل توقف). ويناسب CFT عندما:
- تشغّل منظمة واحدة كل العقد
- يكون الوصول المادي إلى العقد مضبوطًا
- يكون نموذج التهديد أعطال العتاد، وأخطاء البرمجيات، وانقسامات الشبكة — لا الأطراف الخبيثة

ويناسب **BFT** عندما:
- تشارك عدة منظمات مستقلة قد تكون متخاصمة
- قد يخترق مهاجمون خارجيون العقد
- يحتاج العمل إلى إجماع لا يستطيع أي مشارك منفرد إفساده، مع سجل قابل للتحقق ومقاوم للتلاعب
- يتعامل النظام مع تسوية نهائية عالية القيمة (لا مجرد أفضل جهد)

```java
@Component
public class ConsensusProtocolSelector {

    /**
     * Decision framework: CFT vs BFT for financial systems
     */
    public ConsensusRecommendation recommend(FinancialSystemContext context) {

        // Single-org systems: use CFT (Raft/Paxos)
        if (context.isControlledByOneOrganization()) {
            return ConsensusRecommendation.builder()
                .protocol("RAFT_OR_PAXOS")
                .reasoning("Single organization — crash fault model sufficient. " +
                    "Use Raft for leader-based consensus (etcd, CockroachDB, TiKV).")
                .minimumNodes(2 * context.tolerableCrashFaults() + 1)
                .build();
        }

        // Multi-org with trusted governance: use CFT with strict access controls
        if (context.hasStrongGovernanceModel() && context.allParticipantsAreRegulated()) {
            return ConsensusRecommendation.builder()
                .protocol("RAFT_WITH_PERMISSIONING")
                .reasoning("All participants are regulated entities with legal accountability. " +
                    "Byzantine behavior is unlikely; stick with CFT for performance. " +
                    "Use permissioned Hyperledger Fabric or similar.")
                .minimumNodes(2 * context.tolerableCrashFaults() + 1)
                .build();
        }

        // Multi-org with adversarial potential: use BFT
        return ConsensusRecommendation.builder()
            .protocol("PBFT_OR_TENDERMINT")
            .reasoning("Multiple independent organizations, potential adversarial behavior. " +
                "BFT required. Consider Tendermint for instant finality, " +
                "or Hyperledger Fabric with BFT orderer for enterprise permissioned.")
            .minimumNodes(3 * context.tolerableByzantineFaults() + 1)
            .performanceNote("BFT has O(n²) message complexity — keep network small (<100 nodes). " +
                "For larger networks, use sharding or hierarchical BFT.")
            .build();
    }
}
```

---

## تعقيد الرسائل وقابلية التوسع

لـ PBFT تعقيد رسائل **O(n²)** في كل جولة إجماع (كل عقدة ترسل رسالة إلى كل عقدة أخرى في مرحلتي التحضير والالتزام). وتقلّص البروتوكولات الأحدث مثل HotStuff (وما تفرّع منها) هذا إلى O(n) بتوجيه الأصوات عبر القائد وتجميع التوقيعات. أما في PBFT الكلاسيكي فالكلفة التربيعية تحد أحجام العناقيد العملية:

| العقد (n) | الرسائل في كل جولة | عملي؟ |
|---|---|---|
| 4 | 16 | نعم |
| 10 | 100 | نعم |
| 100 | 10,000 | على الحافة |
| 1,000 | 1,000,000 | لا |

لشبكة دفع بين مؤسسات كثيرة المشاركين، يلزم BFT هرمي أو مقسّم:

```
Hierarchical BFT for large payment networks:

Tier 1: Central bank + major settlement banks (7 nodes, BFT, f=2)
         ↓ (settlement finality)
Tier 2: Regional clearing houses (each is a client of Tier 1)
         ↓ (clearing)
Tier 3: Individual banks and payment processors
```

في الطبقة الأولى البنك المركزي والبنوك الكبرى للتسوية (7 عقد، BFT، f=2)، ثم غرف المقاصة الإقليمية كعملاء للطبقة الأولى، ثم البنوك ومعالجو الدفع.

---

## العناصر التشفيرية الأساسية لـ BFT

تعتمد بروتوكولات BFT بشدة على التشفير لمنع العقد البيزنطية من تزوير الرسائل:

```java
@Service
public class BftMessageSigner {

    private final PrivateKey signingKey;
    private final Map<String, PublicKey> peerPublicKeys;

    /**
     * Sign a PBFT message. Every message in a BFT protocol must be
     * signed to prevent Byzantine nodes from impersonating others.
     */
    public byte[] sign(byte[] messageBytes) {
        try {
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(signingKey);
            signer.update(messageBytes);
            return signer.sign();
        } catch (GeneralSecurityException e) {
            throw new BftSigningException("Failed to sign message", e);
        }
    }

    /**
     * Verify a message signature from a known peer.
     * If verification fails, the sender may be Byzantine (forging messages).
     */
    public boolean verify(String senderId, byte[] messageBytes, byte[] signature) {
        PublicKey senderKey = peerPublicKeys.get(senderId);
        if (senderKey == null) {
            log.warn("No known public key for sender {}", senderId);
            return false;
        }

        try {
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(senderKey);
            verifier.update(messageBytes);
            return verifier.verify(signature);
        } catch (GeneralSecurityException e) {
            log.error("Signature verification failed for sender {}: {}", senderId, e.getMessage());
            return false;
        }
    }

    /**
     * Compute a collision-resistant digest of a payment request.
     * Used in PBFT to identify the request across all three phases
     * without transmitting the full request repeatedly.
     */
    public byte[] digest(PaymentRequest request) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return md.digest(request.toCanonicalBytes());
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }
}
```

يجب توقيع كل رسالة في بروتوكول BFT لمنع العقد البيزنطية من انتحال صفة غيرها. وإذا فشل التحقق من التوقيع، فقد يكون المرسل بيزنطيًا. ويُستخدم ملخص SHA-256 لتعريف الطلب عبر المراحل الثلاث دون إرساله كاملًا مرارًا.

---

## نصائح للإنتاج وأخطاء شائعة

### الخطأ 1: استخدام CFT حيث يلزم BFT

أخطر خطأ هو استخدام بروتوكول CFT (Raft، أو Paxos) في بيئة متعددة المنظمات وافتراض أنه يوفر تحمّل الأعطال البيزنطية. فعقدة مخترقة واحدة في عنقود Raft تستطيع أن تجعل العنقود ينتخبها قائدًا ثم تفسد السجل:

```java
// Assessment: does this system need BFT?
public boolean needsBft(NetworkTrustModel trustModel) {
    return switch (trustModel) {
        case SINGLE_ORGANIZATION -> false;    // CFT sufficient
        case CONSORTIUM_REGULATED -> false;   // CFT + strong governance
        case OPEN_CONSORTIUM -> true;         // BFT required
        case PUBLIC_PERMISSIONLESS -> true;   // BFT required (blockchain)
    };
}
```

### الخطأ 2: BFT لا يمنع الاحتيال على مستوى التطبيق

يضمن BFT صحة بروتوكول الإجماع — أي أن العقد تتفق على المعاملات التي تُنفّذ. لكنه **لا** يمنع أن تكون المعاملات المتفق عليها احتيالية:

```java
// BFT ensures all nodes agree that this transaction happened.
// It does NOT validate that the transaction is legitimate.
// Application-level fraud detection is still required.
@Service
public class BftPaymentValidator {

    private final BftConsensusClient consensusClient;
    private final FraudDetectionService fraudService;  // Still needed!

    public ValidationResult validate(Payment payment) {
        // BFT-based consensus: all nodes agree this payment was submitted
        ConsensusResult consensus = consensusClient.submitForConsensus(payment);

        // Application-level validation: is this payment actually legitimate?
        FraudAssessment fraud = fraudService.assess(payment);

        return ValidationResult.of(consensus, fraud);
    }
}
```

### الخطأ 3: توقعات أداء BFT

بروتوكولات BFT أبطأ بكثير من بروتوكولات CFT. وهذه أرقام تقريبية بمراتب الحجم (تعتمد كثيرًا على العتاد، والتجميع، وحجم الرسائل، والمسافة الشبكية):

- **Raft** ‏(CFT): نحو 10,000-50,000 معاملة في الثانية على عتاد عادي
- **PBFT** ‏(BFT): نحو 1,000-10,000 معاملة في الثانية في عناقيد صغيرة (أقل من 20 عقدة)
- **Tendermint** ‏(BFT): نحو 1,000-10,000 معاملة في الثانية

ولأنظمة الدفع عالية الإنتاجية، التصميم الشائع في الاتحادات هو BFT في طبقة التسوية المشتركة وCFT داخل معالجة المعاملات في كل مؤسسة.

---

## الخلاصة

تحمّل الأعطال البيزنطية هو أقوى أشكال الإجماع الموزع — وأكثرها كلفة. والحقائق الأساسية للأنظمة المالية:

| الخاصية | CFT ‏(Raft/Paxos) | BFT ‏(PBFT/Tendermint) |
|---|---|---|
| نموذج الأعطال | التوقف | اعتباطي (خبيث) |
| أقل عدد عقد لـ f عطل | 2f+1 | 3f+1 |
| تعقيد الرسائل | O(n) | O(n²) |
| الحجم العملي للعنقود | مئات | أقل من 100 عقدة |
| الإنتاجية | عالية | أقل |
| حالة الاستخدام | منظمة واحدة | عدة منظمات، والبلوك تشين |

‏BFT هو الأداة الصحيحة لشبكات البلوك تشين المصرّح بها، وأنظمة التسوية بين المؤسسات، وأي بنية تحتية مالية يتضمن نموذج تهديدها مشاركين مخترقين أو خبثاء. أما البنية التحتية المالية لمنظمة واحدة، فيوفر CFT أداءً أفضل وتشغيلًا أبسط بأمان مقبول.

المفاضلة الأساسية: **كل عطل بيزنطي تتحمله يكلفك عقدة واحدة أكثر مما يكلفه عطل توقف**. وفي الأنظمة المالية التي يمكن فيها بناء الثقة عبر التنظيم، والاتفاقات القانونية، وضوابط الوصول، فإن استبعاد الأعطال البيزنطية من نموذج التهديد — واستخدام CFT — هو غالبًا القرار الهندسي الصحيح.

<!-- KNOWLEDGE-CHECK
{
  "questions": [
    {
      "text": "ما أقل عدد من النسخ اللازمة لتحمّل f عطلًا بيزنطيًا (خبيثًا)؟",
      "options": ["f + 1", "2f + 1", "3f + 1", "4f + 1"],
      "correct": 2,
      "explanation": "يتطلب تحمّل الأعطال البيزنطية 3f + 1 نسخة على الأقل لتحمّل f عطلًا بيزنطيًا. لأن البروتوكول يجب أن يميّز f عقدة خبيثة ترسل معلومات خاطئة عن f عقدة متعطلة، ويصل مع ذلك إلى اتفاق بين العقد الصحيحة الباقية."
    },
    {
      "text": "كيف يختلف العطل البيزنطي عن عطل التوقف في نظام مالي؟",
      "options": ["أعطال التوقف تحدث في العتاد فقط؛ والأعطال البيزنطية أخطاء برمجية", "عطل التوقف يعني أن العقدة تتوقف عن الرد؛ والعطل البيزنطي يعني أن العقدة ترسل رسائل خاطئة أو متناقضة أو خبيثة إلى العقد الأخرى بينما تبدو مشاركة", "تُكتشف الأعطال البيزنطية تلقائيًا بمجاميع TCP الاختبارية", "تتطلب أعطال التوقف نسخًا أكثر من الأعطال البيزنطية لتحملها"],
      "correct": 1,
      "explanation": "العقدة المتوقفة تتوقف ببساطة. أما العقدة البيزنطية فترسل فعليًا معلومات مضللة — تصوّت بـ نعم لبعض النظراء وبـ لا لآخرين، أو ترسل بيانات معاملات مزورة. وهذا أصعب كثيرًا في الاكتشاف لأن العقدة تبدو عاملة بينما تفسد الإجماع."
    },
    {
      "text": "في أي سيناريو للبنية التحتية المالية يكون تحمّل الأعطال البيزنطية أكثر تبريرًا من تحمّل أعطال التوقف المعياري؟",
      "options": ["عنقود معالجة مدفوعات داخلي في بنك واحد", "شبكة تسوية بين عدة بنوك يمكن فيها أن يُخترق أي مشارك أو يتصرف لمصلحته الذاتية", "نظام تداول عالي التردد يحسّن للزمن بالميكروثواني", "عنقود PostgreSQL من نسخة أساسية ونسخ متماثلة مع نسخ متزامن"],
      "correct": 1,
      "explanation": "يكون BFT مبررًا عندما يتضمن نموذج التهديد مشاركين قد يتصرفون بخبث — مثل بلوك تشين مصرّح به أو شبكة تسوية بين البنوك تشارك فيها عدة مؤسسات مستقلة ولا يثق الجميع بأي طرف منفرد ثقة كاملة."
    }
  ]
}
-->

<!-- PRACTICAL-CHALLENGE
{
  "title": "تحليل الأعطال البيزنطية وإجماع BFT للتسوية بين المؤسسات",
  "difficulty": "advanced",
  "estimatedMinutes": 45,
  "tasks": [
    {"id": "1", "description": "نفّذ محاكاة مبسطة لـ PBFT بـ 4 عقد (3f+1 لـ f=1) باستخدام خيوط Java. وشغّل تدفق البروتوكول في الحالة العادية لمعاملة تسوية: مراحل ما قبل التحضير، والتحضير، والالتزام. وتحقق من التزام المعاملة عندما تكون العقد الأربع كلها أمينة."},
    {"id": "2", "description": "وسّع المحاكاة بحيث تكون إحدى العقد الأربع بيزنطية: ترسل أصوات PREPARE وCOMMIT لقيمة إلى عقدتين أمينتين ولقيمة متعارضة إلى الثالثة. وتحقق من أن العقد الأمينة الثلاث ما زالت تتفق على نتيجة واحدة، مؤكدًا تحمّل الأعطال البيزنطية مع f=1 وN=4."},
    {"id": "3", "description": "حلّل مفاضلة الأداء: قِس تعقيد رسائل PBFT ‏(O(N^2)) مقابل Raft ‏(O(N)) لـ N = 4 و7 و10 عقد بعدّ الرسائل في محاكاتك. ووثّق عند أي N تصبح كلفة BFT غير عملية لحالة تسوية لحظية باتفاقية 100ms."},
    {"id": "4", "description": "صمّم نموذج تهديد لشبكة تسوية بلوك تشين مصرّح بها من 7 بنوك أعضاء. وحدّد أي سيناريوهات الفشل تتطلب BFT (مُدقِّق مخترق، ومراوغة) وأيها يعالجها CFT المعياري (تعطل عقدة، وانقسام شبكة). واكتب سجل قرار معماري من صفحة واحدة يبرر خدمة ترتيب BFT (مثل Hyperledger Fabric مع SmartBFT) بدل خدمة مبنية على Raft لهذا السيناريو."}
  ]
}
-->
