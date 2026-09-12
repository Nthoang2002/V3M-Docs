# behavior-events — Service layer

3 class: `AppEventServiceImpl`, `BehaviorForwardService`, `BehaviorReprocessService`.

---

## 1. `IAppEventService` (interface)

```java
public interface IAppEventService {
    TrackEventResponse publishEvent(TrackEventRequest request);          // publish 1 event
    List<TrackEventResponse> publishEvents(List<TrackEventRequest> r);   // publish nhiều, độc lập
    void saveEvent(AppEventMessage message);                             // consumer gọi, persist
}
```
> Convention repo: **Javadoc bắt buộc trên public method của interface service** (`service/iface/`).

---

## 2. `AppEventServiceImpl`

### 2.1 `publishEvent()` — API → Kafka

```java
public TrackEventResponse publishEvent(TrackEventRequest request) {
    String eventId = UUID.randomUUID().toString();          // 🔑 server sinh
    LocalDateTime now = LocalDateTime.now();

    AppEventMessage message = AppEventMessage.builder()
            .eventId(eventId)
            .action(request.getAction())
            ...
            .timestamp(request.getTimestamp() != null ? request.getTimestamp() : now)  // client không gửi → now
            .publishedAt(now)
            .build();

    try {
        String payload = objectMapper.writeValueAsString(message);
        appEventProducer.send(eventId, payload);
        log.info("Event published to Kafka: eventId={}, action={}", eventId, request.getAction());
    } catch (JsonProcessingException e) {
        log.error(...);
        return TrackEventResponse.builder().eventId(eventId)
                .status(EventResponseStatus.FAILED).message("Không thể xử lý event").build();
    }
    return TrackEventResponse.builder().eventId(eventId)
            .status(EventResponseStatus.ACCEPTED).message("Event đã được ghi nhận").build();
}
```

🔑 **Phân biệt 2 mốc thời gian:**
- `timestamp` — **lúc hành vi xảy ra trên app** (client gửi; app offline rồi gửi sau vẫn đúng).
- `publishedAt` — **lúc server nhận**. Chênh lệch 2 mốc = độ trễ mạng/offline của client.

### 2.2 `publishEvents()` — mỗi event độc lập

```java
return requests.stream().map(this::publishEvent).collect(Collectors.toList());
```
1 event lỗi serialize → chỉ event đó `FAILED`, các event khác vẫn `ACCEPTED`.
⚠️ Khác với khâu **validate** ở controller (all-or-nothing). Nhớ phân biệt.

### 2.3 `saveEvent()` — Kafka → PostgreSQL

```java
@Override
@Transactional
public void saveEvent(AppEventMessage message) {
    if (appEventRepository.existsByEventId(message.getEventId())) {   // (1) DEDUP
        log.warn("Duplicate event skipped: eventId={}", message.getEventId());
        return;
    }

    String metadataJson = null;                                       // (2) metadata → JSON string
    if (message.getMetaData() != null && !message.getMetaData().isEmpty()) {
        try {
            metadataJson = objectMapper.writeValueAsString(message.getMetaData());
        } catch (JsonProcessingException e) {
            log.warn("Failed to serialize metadata for eventId={}: {}", ...);   // ⚠️ KHÔNG ném
        }
    }

    AppEventEntity entity = AppEventEntity.builder()... .build();
    appEventRepository.save(entity);                                  // (3) lưu
    log.info("Event saved to DB: eventId={}, action={}", ...);

    behaviorForwardService.tryForward(message);                       // (4) forward CDP
}
```

**4 điểm cần nhớ:**

| # | Điểm | Vì sao |
|---|---|---|
| 1 | Dedup bằng `existsByEventId` | Kafka đảm bảo **at-least-once** → cùng message có thể được giao lại. Cột `event_id` còn có UNIQUE ở DB làm lớp bảo vệ cuối. |
| 2 | Metadata lỗi serialize → **chỉ warn** | Metadata là dữ liệu phụ tự do. Mất metadata còn hơn mất cả event. |
| 3 | `@Transactional` | Save + forward nằm cùng transaction. Nếu save rollback thì… |
| 4 | `tryForward` gọi trong transaction | ⚠️ **Bẫy**: forward là `kafkaTemplate.send()` **async không transactional**. Nếu transaction rollback SAU khi send, message CDP vẫn đã bay đi. Thực tế `tryForward` là câu lệnh cuối và không ném exception (nó `return false`), nên rủi ro thấp — nhưng đây là chỗ cần biết. |

---

## 3. 🔑 `BehaviorForwardService` — trái tim của service

Nhiệm vụ: quyết định **event nào được lên CDP** và **mang tên gì**.

```java
public boolean tryForward(AppEventMessage event) {
    String customerId = event.getCustomerId();

    // ── (A) Resolve customerId ────────────────────────────────────────
    if (customerId == null || customerId.isBlank()) {
        if (event.getUserId() == null || event.getUserId().isBlank()) {
            log.warn("Behavior forward skipped — no customerId or userId: eventId={}", ...);
            return false;
        }
        Optional<String> resolved = userResolutionCache.resolveCustomerId(event.getUserId());
        if (resolved.isEmpty()) {
            log.warn("Behavior forward skipped — userId not mapped to customer: ...");
            return false;
        }
        customerId = resolved.get();
    }

    // ── (B) Chọn giá trị để tra bảng dịch ─────────────────────────────
    String action = event.getAction();
    String matchValue = "event".equals(action) ? event.getName() : event.getPage();

    // ── (C) Tra bảng dịch ─────────────────────────────────────────────
    Optional<String> behaviorType = mappingCache.resolve(action, matchValue);
    if (behaviorType.isEmpty()) {
        log.info("Behavior forward skipped — no mapping: action={}, matchValue={}", action, matchValue);
        return false;                          // ⚠️ BỎ QUA IM LẶNG
    }

    // ── (D) Dựng payload chuẩn CDP ────────────────────────────────────
    Map<String, Object> metaMap = new HashMap<>();
    if (event.getSessionId() != null && !event.getSessionId().isBlank())
        metaMap.put("sessionId", event.getSessionId());

    Map<String, Object> payload = new HashMap<>();
    payload.put("customerId",   resolvedCustomerId);
    payload.put("behaviorType", behaviorType.get());
    payload.put("channel",      "APP");
    payload.put("device",       resolveDevice(event));      // metaData.device.platform
    payload.put("behaviorTime", event.getTimestamp() != null ? event.getTimestamp().toString() : null);
    payload.put("metadata",     metaMap.isEmpty() ? "{}" : objectMapper.writeValueAsString(metaMap));

    behaviorEventProducer.send(resolvedCustomerId, objectMapper.writeValueAsString(payload));
    return true;
}
```

### 🔑 Quy tắc `matchValue` — bắt buộc nhớ

| `action` | Match theo field | Ý nghĩa |
|---|---|---|
| `"event"` | `name` | **Sự kiện nghiệp vụ** (bấm nút, ứng tuyển thành công) |
| bất kỳ khác (thực tế `"view"`) | `page` | **Mở màn hình** |

Tra bảng `t_behavior_mapping` bằng khoá ghép `action:matchValue`.

### ⚠️ Ba lý do event bị bỏ (đều KHÔNG phải lỗi, chỉ log)

1. Không có `customerId` **và** không có `userId` → `log.warn`
2. Có `userId` nhưng không resolve ra `customerId` → `log.warn`
3. Không khớp mapping → `log.info` ← **im lặng nhất, khó phát hiện nhất**

💡 Khi debug "nhiệm vụ không cộng điểm", đây là chỗ đầu tiên phải grep log:
```
grep "Behavior forward skipped" app-event-service.log
```

### `payload.metadata` là **STRING JSON**, không phải object

```java
payload.put("metadata", metaMap.isEmpty() ? "{}" : objectMapper.writeValueAsString(metaMap));
```
Vì contract của CDP quy định thế. Bên customer-service `CdpBehaviorSavedConsumer.parseMetadata()` phải `readValue` lần nữa để dùng.
🔑 Đây là chỗ **JSON lồng JSON** — dễ nhầm khi đọc log.

### `resolveDevice()` — đọc an toàn từ Map lồng nhau

```java
private String resolveDevice(AppEventMessage event) {
    if (event.getMetaData() == null) return null;
    Object device = event.getMetaData().get("device");
    if (device instanceof Map) {
        Object platform = ((Map<?, ?>) device).get("platform");
        return platform != null ? platform.toString() : null;
    }
    return null;
}
```
💡 `instanceof Map` thay vì cast thẳng — `metaData` là `Map<String,Object>` tự do, client gửi `device` là String cũng không được sập.

---

## 4. `BehaviorReprocessService` — chạy lại event cũ

```java
private static final int PAGE_SIZE = 500;

public ReprocessResult reprocess(LocalDateTime from, LocalDateTime to) {
    long total = 0, forwarded = 0, skipped = 0;
    int page = 0;
    Page<AppEventEntity> result;

    do {
        result = eventRepository.findByCreatedAtBetween(
                from, to, PageRequest.of(page, PAGE_SIZE, Sort.by("createdAt")));

        for (AppEventEntity entity : result.getContent()) {
            total++;
            try {
                if (behaviorForwardService.tryForward(toMessage(entity))) forwarded++;
                else skipped++;
            } catch (Exception e) {
                skipped++;
                log.error("Reprocess failed for event: eventId={}, debug={}", ...);
            }
        }
        log.info("Reprocess progress: page={}/{}, total={}, forwarded={}, skipped={}", ...);
        page++;
    } while (result.hasNext());

    return new ReprocessResult(total, forwarded, skipped);
}
```

**Ba chi tiết đáng học:**

| Chi tiết | Vì sao |
|---|---|
| Phân trang 500, không `findAll()` | Khoảng ngày rộng có thể vài trăm nghìn dòng → `findAll` sẽ OOM. |
| Lọc theo **`created_at`** chứ không `timestamp` | `created_at` = lúc server ghi (mốc kỹ thuật, đơn điệu tăng). `timestamp` = lúc app phát sinh (client gửi, có thể lệch/lùi). Reprocess theo mốc kỹ thuật mới đúng. |
| `try/catch` **trong vòng lặp** | 1 event lỗi không làm hỏng cả job — đếm vào `skipped` rồi đi tiếp. |
| Log tiến độ mỗi trang | Job dài, không có log thì không biết còn sống hay treo. |

⚠️ **Vòng lặp phân trang này tiềm ẩn "dịch trang"**: khi đang chạy mà có INSERT mới vào khoảng đó thì `page` cũ/mới lệch. Ở đây chấp nhận được vì `from/to` là quá khứ.
`toMessage(entity)` — convert entity ngược lại DTO, parse `metadata` từ JSON string; parse lỗi thì `catch (Exception ignored) {}` (metadata phụ, không chặn reprocess).

## 5. Đi tiếp

→ [`05-cache-datasource.md`](05-cache-datasource.md)
