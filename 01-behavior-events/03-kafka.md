# behavior-events — Kafka (2 producer + 1 consumer)

## 1. Sơ đồ

```
POST /api/events ──publish──> [app-event-topic] ──consume──> AppEventConsumer
                                                                    │
                                                             saveEvent() → PG
                                                                    │
                                                          BehaviorForwardService
                                                                    │
                                                       publish──> [cdp-behavior-topic] ──> cdp-service
```

| Class | Topic (config key) | Chiều |
|---|---|---|
| `AppEventProducer` | `kafka.event-topic` (mặc định `app-event-topic`) | gửi |
| `AppEventConsumer` | `kafka.event-topic` | nhận |
| `BehaviorEventProducer` | `kafka.behavior-topic` (mặc định `cdp-behavior-topic`) | gửi |

Serializer: **String** cả key lẫn value (payload là JSON string tự serialize bằng `ObjectMapper`).
💡 Vì sao không dùng `JsonSerializer` của Spring Kafka? Vì bên nhận là **cdp-service (không cùng codebase)** — gửi String JSON thuần tránh gắn header type-id của Spring vào message.

---

## 2. `AppEventProducer` — gửi bất đồng bộ + callback

```java
public void send(String key, String payload) {
    kafkaTemplate.send(eventTopic, key, payload)
            .addCallback(new ListenableFutureCallback<SendResult<String, String>>() {
                @Override public void onSuccess(SendResult<String,String> r) {
                    log.debug("Kafka send success: key={}, offset={}, partition={}", ...);
                }
                @Override public void onFailure(Throwable ex) {
                    log.error("Kafka send failed: key={}, topic={}, debug={}", key, eventTopic, DebuggingDTO.build(ex));
                }
            });
}
```

🔑 **Không `.get()`** → không chặn request. Đánh đổi: broker chết thì API vẫn trả 202 và event **mất** (chỉ còn log ERROR).
Muốn chắc chắn hơn phải: `.get(timeout)` (chậm) hoặc outbox pattern (phức tạp). Dự án chọn phương án nhẹ vì đây là analytics.

**Key = `eventId` (UUID)** → phân bố đều mọi partition. Đánh đổi: **không đảm bảo thứ tự** giữa các event của cùng 1 user. Chấp nhận được vì mỗi event độc lập, và `timestamp` đã nằm trong payload.

## 3. `BehaviorEventProducer` — key = `customerId`

```java
kafkaTemplate.send(behaviorTopic, customerId, payload)
```
🔑 Key khác chủ đích: **mọi behavior của cùng 1 customer vào cùng partition** → cdp-service xử lý **đúng thứ tự** cho từng khách hàng (quan trọng khi tính feature/segment).

## 4. `AppEventConsumer` — xử lý lỗi 3 tầng

```java
@KafkaListener(topics = "${kafka.event-topic:app-event-topic}",
               groupId = "${spring.kafka.consumer.group-id}")
public void consume(ConsumerRecord<String, String> record) {
    AppEventMessage message;
    try {
        message = objectMapper.readValue(record.value(), AppEventMessage.class);
    } catch (Exception e) {
        log.error("AppEvent deserialize failed: offset={}, partition={}, debug={}", ...);
        return;                                   // ← (A) NUỐT, commit offset
    }

    if (message.getEventId() == null || message.getAction() == null) {
        log.warn("Skipping malformed event ...");
        return;                                   // ← (B) NUỐT, commit offset
    }

    try {
        appEventService.saveEvent(message);
    } catch (Exception e) {
        log.error("saveEvent failed: eventId={}, debug={}", ...);
        throw e;                                  // ← (C) NÉM LẠI, KHÔNG commit
    }
}
```

🔑 **Đây là quyết định quan trọng nhất của consumer** — 3 nhánh, 3 cách khác nhau, có lý do:

| Nhánh | Loại lỗi | Xử lý | Vì sao |
|---|---|---|---|
| (A) deserialize fail | Message **hỏng vĩnh viễn** | nuốt + return | Retry bao nhiêu lần cũng hỏng. Ném ra sẽ khiến consumer lặp vô hạn trên cùng offset ⇒ **chặn cứng cả partition** (poison pill). |
| (B) thiếu field bắt buộc | Message **sai vĩnh viễn** | nuốt + return | Như trên. |
| (C) `saveEvent` fail | Lỗi **tạm thời** (DB down, deadlock) | ném lại | Không commit offset ⇒ Kafka **giao lại** message ⇒ tự khỏi khi DB sống. Đây chính là giá trị "Kafka làm buffer". |

⚠️ **Đánh đổi của (C):** nếu lỗi là vĩnh viễn (vd cột DB không đủ dài), consumer sẽ kẹt lặp mãi. Chưa có DLQ (dead letter queue) hay giới hạn retry — điểm yếu đã biết.

`ConsumerRecord` (thay vì chỉ nhận `String`) để log được `offset` + `partition` — cực kỳ hữu ích khi debug production.

## 5. Cấu hình Kafka (`application-bk.yml`)

```yaml
spring:
  kafka:
    listener:
      missing-topics-fatal: false      # topic chưa tồn tại → không sập app lúc startup
    consumer:
      group-id: app_event_service
      auto-offset-reset: earliest      # consumer mới đọc từ đầu, không bỏ sót lịch sử
      key-deserializer: ...StringDeserializer
      value-deserializer: ...StringDeserializer
      bootstrap-servers: 192.168.20.62:9092
    producer:
      bootstrap-servers: 192.168.20.62:9092
      key-serializer: ...StringSerializer
      value-serializer: ...StringSerializer
kafka:
  event-topic: app-event-topic
  behavior-topic: cdp-behavior-topic
```

💡 `auto-offset-reset: earliest` vs `latest`:
- `earliest` — group mới đọc lại từ offset 0 (không mất dữ liệu, nhưng deploy group-id mới = xử lý lại toàn bộ).
- `latest` — chỉ đọc message mới.
Ở đây chọn `earliest` vì mất event là mất dữ liệu phân tích.

## 6. Payload Kafka: `AppEventMessage`

`model/message/AppEventMessage.java` — **khác** `TrackEventRequest`:

| Field | `TrackEventRequest` (API) | `AppEventMessage` (Kafka) |
|---|---|---|
| naming | snake_case | camelCase (mặc định) |
| `eventId` | ❌ không có | ✅ server sinh |
| `publishedAt` | ❌ | ✅ thời điểm publish |
| còn lại | giống | giống |

🔑 **Vì sao tách 2 DTO?** Contract với client (snake_case, không có eventId) khác contract nội bộ. Tách ra thì đổi 1 bên không ảnh hưởng bên kia.

## 7. Đi tiếp

→ [`04-service-layer.md`](04-service-layer.md)
