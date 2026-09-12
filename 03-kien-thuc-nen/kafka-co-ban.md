# Kiến thức nền — Kafka trong V3M

---

## 1. Khái niệm tối thiểu

| Khái niệm | Ý nghĩa | Trong V3M |
|---|---|---|
| **Topic** | Kênh chứa message | `app-event-topic`, `cdp-behavior-topic`, … |
| **Partition** | Topic chia nhiều phần để song song hoá | Thứ tự chỉ đảm bảo **trong 1 partition** |
| **Key** | Quyết định message vào partition nào | 🔑 Quan trọng — xem mục 2 |
| **Offset** | Vị trí message trong partition | Log kèm để debug |
| **Consumer group** | Nhóm consumer chia nhau partition | `spring.kafka.consumer.group-id` |
| **Commit offset** | Đánh dấu "đã xử lý xong" | Ném exception = **không commit** = giao lại |

🔑 **At-least-once**: Kafka đảm bảo message được giao **ít nhất 1 lần**, có thể nhiều hơn.
⇒ Consumer **phải idempotent** hoặc có dedup. Xem mục 4.

---

## 2. 🔑 Chọn key — quyết định thiết kế quan trọng

| Producer | Key | Vì sao |
|---|---|---|
| `AppEventProducer` | `eventId` (UUID) | Phân bố đều mọi partition. **Không** cần thứ tự (mỗi event độc lập, đã có `timestamp` trong payload) |
| `BehaviorEventProducer` | `customerId` | 🔑 **Mọi behavior của cùng khách hàng vào cùng partition** → cdp-service xử lý đúng thứ tự cho từng người |
| `TimekeepServiceImpl` | `customerId` | Như trên |
| `HrTimekeepingSyncConsumer.publishToCdp` | `customerId` | Như trên — và giúp check-in đến trước check-out |

💡 **Quy tắc**: key = **thứ mà bạn cần đảm bảo thứ tự theo nó**.
- Cần thứ tự theo user → key = userId/customerId
- Không cần thứ tự → key ngẫu nhiên (phân bố tải tốt hơn)

⚠️ Đánh đổi: key = customerId thì 1 khách hàng "nóng" (nhiều event) sẽ làm lệch tải giữa các partition.

---

## 3. 🔑 Xử lý lỗi trong consumer — nuốt hay ném?

Đây là quyết định lặp lại ở cả 4 consumer trong 2 repo.

```java
try { message = objectMapper.readValue(raw, AppEventMessage.class); }
catch (Exception e) { log.error(...); return; }              // ← NUỐT

if (message.getEventId() == null) { log.warn(...); return; } // ← NUỐT

try { appEventService.saveEvent(message); }
catch (Exception e) { log.error(...); throw e; }             // ← NÉM LẠI
```

| Loại lỗi | Xử lý | Vì sao |
|---|---|---|
| **Vĩnh viễn** (JSON hỏng, thiếu field, UUID sai định dạng) | **Nuốt** + `return` | Retry bao nhiêu lần cũng hỏng. Ném ra ⇒ consumer lặp vô hạn trên cùng offset ⇒ **chặn cứng cả partition** |
| **Tạm thời** (DB down, deadlock, timeout) | **Ném lại** | Không commit offset ⇒ Kafka giao lại ⇒ tự khỏi khi hạ tầng hồi |
| **Không áp dụng** (không tìm thấy user local) | **Nuốt** (`log.debug`) | Bình thường, không phải lỗi |

### 💀 "Poison pill"
Message hỏng vĩnh viễn mà consumer cứ ném exception ⇒ Kafka giao lại mãi ⇒ **partition đó đứng im**, mọi message sau bị kẹt.
🔑 Đây là lý do phải **nuốt** lỗi deserialize.

⚠️ **Điểm yếu của V3M:** chưa có **DLQ (Dead Letter Queue)** và chưa giới hạn số lần retry. Nếu lỗi "tạm thời" hoá vĩnh viễn (vd bug logic trong `processEvent`), consumer sẽ kẹt.
💡 Giải pháp chuẩn: Spring Kafka `DefaultErrorHandler` + `DeadLetterPublishingRecoverer` (retry N lần rồi đẩy sang topic `.DLT`).

---

## 4. 🔑 Ba cách dedup trong dự án

| Cách | Ở đâu | Cơ chế |
|---|---|---|
| **Theo id nghiệp vụ (DB)** | `AppEventServiceImpl.saveEvent` | `existsByEventId` + UNIQUE `event_id` |
| **Theo id nghiệp vụ (upsert)** | `HrTimekeepingSyncConsumer` | `findByHrTimekeepId` + UNIQUE `hr_timekeep_id`; trả `isNew` để quyết định có bắn CDP không |
| **Theo cửa sổ thời gian (Redis)** | `CdpBehaviorSavedConsumer`, `RuleEventConsumer` | `SETNX rule:event:dedup:{userId}:{eventType}:{phút}` TTL 300s |

### Vì sao rule engine phải dedup theo phút?
Payload behavior từ CDP **không có eventId**. Không có id thì phải dùng "vân tay" = `(userId, eventType, phút)`.

⚠️ **Đánh đổi:** 2 hành vi **thật** cùng loại trong 1 phút → chỉ tính 1. Chấp nhận được vì các nhiệm vụ hiện tại không có ca nào cần đếm 2 lần trong 1 phút.

🔑 **Dùng `occurredAt` chứ không `now()`**:
```java
String minute = (occurredAt != null ? occurredAt : LocalDateTime.now()).truncatedTo(ChronoUnit.MINUTES).toString();
```
Message giao lại sau 3 phút vẫn sinh **cùng key** → vẫn dedup được.

⚠️ **Tương tác tinh tế với retry:** dedup ghi key **trước** khi xử lý. Nếu `processEvent` fail và Kafka giao lại, dedup sẽ chặn ⇒ **event bị bỏ luôn**. Là đánh đổi giữa "không cộng điểm 2 lần" và "không mất event" — dự án chọn vế đầu.

---

## 5. Producer — gửi bất đồng bộ

```java
kafkaTemplate.send(topic, key, payload)
        .addCallback(new ListenableFutureCallback<SendResult<String,String>>() {
            @Override public void onSuccess(SendResult<String,String> r) { log.debug(...); }
            @Override public void onFailure(Throwable ex) { log.error("Kafka send failed: ...", DebuggingDTO.build(ex)); }
        });
```
🔑 **Không `.get()`** → không chặn request.
⚠️ Đánh đổi: broker chết thì API vẫn trả 202/200 và message **mất** (chỉ còn log ERROR).

💡 Ba mức đảm bảo:
| Cách | Đảm bảo | Chi phí |
|---|---|---|
| Fire-and-forget + callback (dự án dùng) | Thấp — mất khi broker down | Nhanh nhất |
| `.get(timeout)` | Cao — biết chắc đã gửi | Chậm, chặn request |
| **Outbox pattern** | Cao nhất — ghi DB cùng transaction rồi job đẩy | Phức tạp |

⚠️ **Kafka không transactional với DB.** Trong `saveEvent()`:
```java
appEventRepository.save(entity);            // trong @Transactional
behaviorForwardService.tryForward(message); // → kafkaTemplate.send() — KHÔNG rollback được
```
Nếu transaction rollback **sau** khi send, message CDP vẫn đã bay. Ở đây rủi ro thấp (send là câu lệnh cuối, `tryForward` không ném) nhưng phải biết.

---

## 6. Cấu hình quan trọng

```yaml
spring:
  kafka:
    listener:
      missing-topics-fatal: false      # 🔑 topic chưa tồn tại → không sập app lúc startup
    consumer:
      group-id: app_event_service
      auto-offset-reset: earliest      # 🔑 group mới đọc từ đầu
      key-deserializer:   ...StringDeserializer
      value-deserializer: ...StringDeserializer
    producer:
      key-serializer:   ...StringSerializer
      value-serializer: ...StringSerializer
```

### `auto-offset-reset`
| Giá trị | Hành vi | Khi nào |
|---|---|---|
| `earliest` | Group mới đọc từ offset 0 | 🔑 Dự án dùng — mất event = mất dữ liệu |
| `latest` | Chỉ đọc message mới | Khi lịch sử không quan trọng |
⚠️ `earliest` + đổi `group-id` = **xử lý lại toàn bộ lịch sử**. Cẩn thận khi deploy.

### Vì sao dùng `StringSerializer` chứ không `JsonSerializer`?
🔑 Bên nhận (`cdp-service`) **không cùng codebase**. `JsonSerializer` của Spring nhúng header `__TypeId__` (tên class Java) — bên khác không hiểu, và ràng buộc tên class vào contract. Gửi String JSON thuần thì bên nào cũng parse được.

---

## 7. Sáu topic của V3M — nhớ đúng chiều

| Topic | Producer | Consumer |
|---|---|---|
| `app-event-topic` | app-event-service (REST) | app-event-service |
| `cdp-behavior-topic` | app-event-service **+** customer-service **+** hr-backend | cdp-service |
| `cdp-behavior-saved` | cdp-service | customer-service `CdpBehaviorSavedConsumer` |
| `cdp-transaction-topic` | hr-backend | cdp-service |
| `rule-events` | hệ C# | customer-service `RuleEventConsumer` |
| `hr-timekeeping-sync-topic` | hr-backend | customer-service `HrTimekeepingSyncConsumer` |

🔑 `cdp-behavior-topic` là **cửa duy nhất** vào CDP (3 producer).
🔑 `cdp-service` là **source of truth**: chỉ bắn `cdp-behavior-saved` **sau khi lưu thành công** ⇒ customer-service không bao giờ cộng điểm cho behavior mà CDP chưa ghi nhận.

---

## 8. Bẫy: JSON bọc trong String

```java
String json = raw.startsWith("\"") ? MAPPER.readValue(raw, String.class) : raw;
behavior = MAPPER.readValue(json, CdpBehaviorEvent.class);
```
Producer serialize 2 lần: object → JSON string → serialize string đó thành JSON.
```
Bình thường:  {"customerId":"abc",...}
Bọc 2 lần:    "{\"customerId\":\"abc\",...}"
```
🔑 Xử lý cả 2 dạng bằng cách kiểm tra ký tự đầu — hàng rào phòng thủ với producer không kiểm soát được.

## 9. Bẫy: `metadata` là STRING JSON, không phải object

```java
payload.put("metadata", objectMapper.writeValueAsString(metaMap));    // producer
...
private Map<String, Object> parseMetadata(String metadataJson) {      // consumer
    return MAPPER.readValue(metadataJson, new TypeReference<Map<String,Object>>() {});
}
```
Contract của CDP quy định thế. **JSON lồng JSON** — dễ nhầm khi đọc log.
