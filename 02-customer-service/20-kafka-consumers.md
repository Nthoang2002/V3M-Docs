# customer-service — Kafka Consumers

Package `kafka/` — **3 consumer**. Service này vừa là consumer vừa là producer.

| Class | Topic (config key) | Làm gì |
|---|---|---|
| `CdpBehaviorSavedConsumer` | `kafka.topic.cdp-behavior-consume` (`cdp-behavior-saved`) | 🔑 Behavior đã lưu ở CDP → chạy rule engine |
| `RuleEventConsumer` | `rule.engine.kafka.topic` (`rule-events`) | Event nghiệp vụ bắn thẳng từ hệ C# |
| `HrTimekeepingSyncConsumer` | `kafka.topic.hr-timekeeping-sync` | Chấm công từ CRM → `timekeep_record` + publish CDP |

**Producer** (không có class riêng, dùng `KafkaTemplate` trực tiếp):
- `TimekeepServiceImpl.publishAttendanceEvent()` → `kafka.topic.cdp-behavior-publish`
- `HrTimekeepingSyncConsumer.publishToCdp()` → cùng topic

---

## 1. 🔑 `CdpBehaviorSavedConsumer` — cửa vào rule engine

```java
@KafkaListener(topics = "${kafka.topic.cdp-behavior-consume}", groupId = "${spring.kafka.consumer.group-id}")
public void consume(String raw) {
    // ── (1) Deserialize, xử lý JSON BỌC TRONG STRING ──────────────────
    CdpBehaviorEvent behavior;
    try {
        String json = raw.startsWith("\"") ? MAPPER.readValue(raw, String.class) : raw;   // 🔑
        behavior = MAPPER.readValue(json, CdpBehaviorEvent.class);
    } catch (Exception e) {
        log.error("CDP behavior deserialize failed: rawLen={}, debug={}", raw == null ? 0 : raw.length(), ...);
        return;                                       // nuốt — message hỏng vĩnh viễn
    }

    // ── (2) Validate ──────────────────────────────────────────────────
    if (behavior.getCustomerId() == null || behavior.getBehaviorType() == null) { log.warn(...); return; }
    UUID customerId;
    try { customerId = UUID.fromString(behavior.getCustomerId()); }
    catch (IllegalArgumentException e) { log.warn("Invalid customerId format: {}", ...); return; }

    // ── (3) customerId → userId ───────────────────────────────────────
    var userOpt = userRepository.findByCustomerId(customerId);
    if (userOpt.isEmpty()) { log.debug("No local user for customerId={}, skipping rule engine", ...); return; }

    // ── (4) 🔑 PASSTHROUGH 1:1 ────────────────────────────────────────
    var event = CustomerEvent.builder()
            .userId(userOpt.get().getId())
            .eventType(behavior.getBehaviorType())        // ← KHÔNG có bảng dịch tên
            .metadata(parseMetadata(behavior.getMetadata()))
            .occurredAt(behavior.getBehaviorTime() != null ? behavior.getBehaviorTime() : LocalDateTime.now())
            .build();

    // ── (5) Lọc ATTENDANCE ────────────────────────────────────────────
    if (!isRewardable(behavior.getBehaviorType(), event.getMetadata())) { log.debug(...); return; }

    // ── (6) Dedup Redis ───────────────────────────────────────────────
    if (!acquireDedup(event.getUserId(), event.getEventType(), event.getOccurredAt())) { log.debug(...); return; }

    // ── (7) Chạy rule engine ──────────────────────────────────────────
    try { ruleEngineService.processEvent(event); }
    catch (Exception e) { log.error("processEvent failed: ..."); throw e; }   // 🔑 NÉM LẠI
}
```

### 🔑 (1) `raw.startsWith("\"")` — JSON bọc trong String
```java
String json = raw.startsWith("\"") ? MAPPER.readValue(raw, String.class) : raw;
```
Producer bên cdp-service **đôi khi** serialize 2 lần: object → JSON string → lại serialize string đó thành JSON (`"{\"customerId\":...}"`).
🔑 Xử lý cả 2 dạng bằng cách kiểm tra ký tự đầu. Đây là hàng rào phòng thủ với producer không kiểm soát được.

### 🔑 (4) PASSTHROUGH — không có bảng dịch
```java
.eventType(behavior.getBehaviorType())
```
Đây là **mắt xích cuối** của chuỗi từ vựng:
```
t_behavior_mapping.behavior_type  →  CustomerEvent.eventType  →  rule_condition.trigger_event_type
     (PostgreSQL, repo A)              (không dịch, 1:1)            (MariaDB, repo B)
```
→ Xem [`../00-tong-quan-he-thong.md`](../00-tong-quan-he-thong.md) mục 5.

### 🔑 (5) `isRewardable()` — lọc riêng ATTENDANCE
```java
/**
 * ATTENDANCE event CHỈ trigger reward khi:
 * - attendanceType=CHECKOUT + isFailed=false        (cặp check-in/out hợp lệ)
 * - attendanceType=CHECKIN  + timekeepingStatus=VALID (admin duyệt check-in không có checkout)
 * Các event type khác không có earn rule → không reward.
 */
private boolean isRewardable(String behaviorType, Map<String, Object> metadata) {
    if (!"ATTENDANCE".equals(behaviorType)) return true;        // 🔑 type khác → luôn cho qua

    String attendanceType = String.valueOf(metadata.getOrDefault("attendanceType", ""));
    Object isFailed = metadata.get("isFailed");
    Object status   = metadata.get("timekeepingStatus");

    if ("CHECKOUT".equals(attendanceType))
        return !Boolean.TRUE.equals(isFailed) && !"true".equalsIgnoreCase(String.valueOf(isFailed));
    if ("CHECKIN".equals(attendanceType))
        return "VALID".equalsIgnoreCase(String.valueOf(status)) || "2".equals(String.valueOf(status));
    return false;                                               // MISSED / AUTO / UNKNOWN → không thưởng
}
```

🔑 **Vì sao chỉ CHECKOUT mới tính?** 1 ca làm việc = check-in + check-out. Tính điểm ở check-in thì worker chấm vào rồi về ngay cũng có điểm.
🔑 **Vì sao CHECKIN + VALID vẫn tính?** Trường hợp worker quên check-out, **admin duyệt** ca đó là hợp lệ. Xem `TimekeepServiceImpl.approve()` — nó bắn lại event khi duyệt.

⚠️ `!Boolean.TRUE.equals(isFailed) && !"true".equalsIgnoreCase(String.valueOf(isFailed))` — kiểm tra **2 lần** vì JSON có thể deserialize `isFailed` thành `Boolean` **hoặc** `String`. Phòng thủ với dữ liệu không kiểm soát được kiểu.

### 🔑 (6) Dedup bằng Redis SETNX theo PHÚT
```java
private boolean acquireDedup(Long userId, String eventType, LocalDateTime occurredAt) {
    String minute = (occurredAt != null ? occurredAt : LocalDateTime.now())
            .truncatedTo(ChronoUnit.MINUTES).toString();
    String key = "rule:event:dedup:" + userId + ":" + eventType + ":" + minute;
    return Boolean.TRUE.equals(redisTemplate.opsForValue()
            .setIfAbsent(key, "1", dedupTtlSeconds, TimeUnit.SECONDS));    // mặc định 300s
}
```

**Vì sao cần?** Kafka đảm bảo **at-least-once**. Cùng behavior có thể được giao 2 lần → cộng điểm 2 lần.

🔑 **Cửa sổ theo PHÚT, không theo eventId:**
| Cách | Ưu | Nhược |
|---|---|---|
| Theo `eventId` | Chính xác tuyệt đối | CDP **không gửi eventId** trong payload behavior |
| Theo `(userId, eventType, phút)` | Không cần id | ⚠️ 2 hành vi **thật** cùng loại trong 1 phút → chỉ tính 1 |

Đánh đổi được chấp nhận: các nhiệm vụ hiện tại (đăng nhập, ứng tuyển, chấm công) không có ca hợp lệ nào cần đếm 2 lần trong 1 phút.

🔑 **Dùng `occurredAt` (thời điểm hành vi) chứ không `now()`** → message được giao lại sau 3 phút vẫn sinh **cùng key** → vẫn dedup được (miễn trong TTL 300s).

### 🔑 (7) Ném lại exception từ `processEvent`
```java
try { ruleEngineService.processEvent(event); }
catch (Exception e) { log.error(...); throw e; }
```
So sánh 3 nhánh:
| Lỗi | Xử lý | Vì sao |
|---|---|---|
| Deserialize / thiếu field / UUID sai | **nuốt** | Hỏng vĩnh viễn — retry vô ích, sẽ chặn partition |
| Không tìm thấy user | **nuốt** (debug) | Bình thường (worker CRM không có tài khoản app) |
| `processEvent` fail | **ném lại** | Có thể là lỗi tạm thời (DB down) → Kafka giao lại |

⚠️ **Rủi ro của (7):** nếu lỗi vĩnh viễn (bug logic), consumer kẹt vòng lặp vô hạn trên cùng offset.
🔑 Nhưng **dedup Redis đã ghi key rồi** ⇒ lần retry sau sẽ bị dedup chặn ⇒ event **bị bỏ luôn**.
💡 Đây là tương tác tinh tế giữa dedup và retry: dedup ghi **trước** khi xử lý ⇒ retry không có tác dụng sau khi key đã tồn tại. Là đánh đổi giữa "không cộng điểm 2 lần" và "không mất event".

---

## 2. `RuleEventConsumer` — event từ hệ C#

```java
@KafkaListener(topics = "${rule.engine.kafka.topic:rule-events}", groupId = "${spring.kafka.consumer.group-id}")
public void consume(String raw) {
    CustomerEvent event;
    try { event = MAPPER.readValue(raw, CustomerEvent.class); }
    catch (Exception e) { log.error("Kafka deserialize failed: raw='{}', debug={}", raw, ...); return; }

    if (event.getUserId() == null || event.getEventType() == null) { log.warn(...); return; }
    if (!acquireDedup(event.getUserId(), event.getEventType(), event.getOccurredAt())) {
        log.info("Duplicate rule event skipped: type={}, userId={}", ...); return;
    }
    try { ruleEngineService.processEvent(event); }
    catch (Exception e) { log.error(...); throw e; }
}
```

🔑 **Khác `CdpBehaviorSavedConsumer` ở 3 điểm:**
1. Nhận thẳng `CustomerEvent` (đã có `userId`) — **không** phải resolve từ `customerId`
2. **Không** có `isRewardable()` — mọi event đều đi vào engine
3. **Không** xử lý JSON bọc String

💡 Đây là "cửa sau" cho hệ C# bắn event nghiệp vụ trực tiếp, không đi vòng qua CDP.
⚠️ `log.error("Kafka deserialize failed: raw='{}'", raw)` — **log cả payload thô**. Nếu payload chứa PII thì lộ vào log. `CdpBehaviorSavedConsumer` cẩn thận hơn (chỉ log `rawLen`).

⚠️ **Dùng chung key dedup** `rule:event:dedup:...` với `CdpBehaviorSavedConsumer` → cùng `(userId, eventType, phút)` từ 2 nguồn khác nhau sẽ chặn lẫn nhau. Có thể là chủ ý (cùng 1 hành vi), cũng có thể là chỗ chưa lường.

---

## 3. `HrTimekeepingSyncConsumer` — chấm công từ CRM

```java
@KafkaListener(topics = "${kafka.topic.hr-timekeeping-sync}", groupId = "${spring.kafka.consumer.group-id}")
@Transactional                                    // 🔑 khác 2 consumer kia
public void consume(String raw) {
    CdpBehaviorEvent event = ... ;                // cùng cách xử lý JSON bọc String
    if (event.getCustomerId() == null) { log.warn(...); return; }

    TimeKeepBehaviorMetaDto meta = parseMetadata(event.getMetadata());
    if (meta == null || meta.getTimeKeepId() == null) { log.warn("missing timeKeepId in metadata"); return; }

    boolean isNew = upsertRecord(event, meta);

    if (isNew) publishToCdp(event, meta);         // 🔑 CHỈ bắn CDP khi là bản ghi MỚI
    else       log.info("HrTimekeepingSync: updated existing record hrTimekeepId={}, ...", ...);
}
```

### 🔑 Upsert theo `hr_timekeep_id` (UNIQUE) — dedup
```java
private boolean upsertRecord(CdpBehaviorEvent event, TimeKeepBehaviorMetaDto meta) {
    Optional<TimekeepRecordEntity> existing = recordRepository.findByHrTimekeepId(meta.getTimeKeepId());
    ...
    if (existing.isPresent()) { /* cập nhật */ return false; }
    /* tạo mới */ return true;
}
```
🔑 **Trả `boolean isNew`** để quyết định có bắn CDP không → **CRM gửi lại cùng bản ghi thì không cộng điểm 2 lần**.
Đây là dedup **theo id nghiệp vụ**, chắc chắn hơn dedup theo phút.

### Resolve `RelatedCheckInId` (BIGINT → UUID)
```java
// Checkout từ hr-backend có RelatedCheckInId (BIGINT) → tìm UUID tương ứng
String relatedCheckinId = null;
if (meta.getRelatedCheckInId() != null) {
    relatedCheckinId = recordRepository.findByHrTimekeepId(meta.getRelatedCheckInId())
            .map(TimekeepRecordEntity::getId).orElse(null);
}
```
🔑 2 hệ dùng 2 kiểu id khác nhau (`BIGINT` bên CRM, `UUID String` bên app) → phải map qua `hr_timekeep_id`.
⚠️ Phụ thuộc **thứ tự**: bản ghi check-in phải đến trước check-out. Kafka key = `customerId` (cùng partition, giữ thứ tự) nên thường đúng — nhưng nếu sai thứ tự thì `relatedCheckinId` = null.

### `resolveUserId()` — fallback về customerId
```java
/**
 * Resolve customerId (CDP) → t_user.id (String) để ĐỒNG NHẤT với luồng app
 * (timekeep_record.user_id = t_user.id).
 * Không map được t_user (worker không phải app user) → GIỮ customerId (UUID) làm fallback.
 */
private String resolveUserId(String customerId) {
    return userRepository.findByCustomerId(UUID.fromString(customerId))
            .map(u -> String.valueOf(u.getId())).orElse(customerId);
}
```
⚠️ Cột `user_id` do đó chứa **2 loại giá trị**: số (`"123"` = t_user.id) hoặc UUID (worker không có tài khoản app). Query theo `user_id` từ app luôn dùng số nên không lẫn — nhưng phải biết.

### `publishToCdp()` — bắn ngược lên `cdp-behavior-topic`
```java
metaMap.put("timekeepingStatus", "INVALID");        // 🔑 luôn INVALID
metaMap.put("attendanceType", resolveAttendanceType(typeCheck));
payload.put("behaviorType", "ATTENDANCE");
payload.put("channel", "HR_SYNC");                 // 🔑 phân biệt với "APP"
kafkaTemplate.send(cdpBehaviorTopic, event.getCustomerId(), MAPPER.writeValueAsString(payload));
```
🔑 `timekeepingStatus = "INVALID"` cứng → bản ghi từ CRM **không tự động cộng điểm**, phải qua duyệt (`isRewardable` yêu cầu `VALID` cho CHECKIN).
🔑 `channel = "HR_SYNC"` để CDP/phân tích phân biệt được nguồn.

### `@Transactional` — vì sao chỉ consumer này có
Consumer này **ghi DB** (`timekeep_record`) và có thể `findByHrTimekeepId` nhiều lần. 2 consumer kia chỉ **gọi service đã có `@Transactional` riêng**.
⚠️ `kafkaTemplate.send()` trong `publishToCdp()` nằm **trong** transaction nhưng Kafka không transactional → rollback DB thì message vẫn bay. Rủi ro thấp vì `publishToCdp` đã bọc `try/catch`.

---

## 4. Bảng tổng hợp cách xử lý lỗi

| Consumer | Deserialize fail | Validate fail | Xử lý fail |
|---|---|---|---|
| `CdpBehaviorSavedConsumer` | nuốt (log `rawLen`) | nuốt | **ném lại** |
| `RuleEventConsumer` | nuốt (⚠️ log cả `raw`) | nuốt | **ném lại** |
| `HrTimekeepingSyncConsumer` | nuốt (log `rawLen`) | nuốt | (không try/catch riêng → ném lên `@Transactional`) |

🔑 **Nguyên tắc chung:** lỗi **vĩnh viễn** → nuốt (tránh poison pill chặn partition). Lỗi **tạm thời** → ném lại (Kafka giao lại).
⚠️ **Chưa có DLQ** — lỗi tạm thời hoá vĩnh viễn sẽ kẹt mãi.

## 5. Đi tiếp

→ [`21-storage-s3.md`](21-storage-s3.md)
