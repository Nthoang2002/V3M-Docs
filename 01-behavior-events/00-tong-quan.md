# behavior-events (app-event-service) — Tổng quan

| | |
|---|---|
| **Repo** | `behavior-events/` |
| **artifactId** | `app-event-service` |
| **Base package** | `com.ttt.v3m.app.event` |
| **Tên đăng ký Eureka** | `APP-EVENT-SERVICE` (application.id = 33) |
| **Port** | 9093 |
| **DB** | PostgreSQL `cdp`, schema `app_event` (+ đọc MariaDB `v3m` và PG `cdp.public`) |
| **Quy mô** | 25 class main, ~1.776 dòng — đọc hết trong 1 buổi |

---

## 1. Service này làm gì

Nhận **hành vi người dùng trên app** (mở màn hình, bấm nút, ứng tuyển…), lưu lại làm dữ liệu thô, và **chuyển tiếp** những hành vi "có ý nghĩa nghiệp vụ" sang CDP.

```
POST /api/events                    ← app gửi (1 event hoặc 1 mảng event)
    → AppEventController
    → IAppEventService.publishEvents()
    → KafkaTemplate → topic app-event-topic        ← trả 202 Accepted NGAY
                          ↓
                  AppEventConsumer
                          ↓
                  IAppEventService.saveEvent()
                          ↓
              PostgreSQL app_event.t_app_event     ← lưu RAW, metadata = JSONB
                          ↓
                  BehaviorForwardService.tryForward()
                          ↓
              Kafka cdp-behavior-topic             ← chỉ event có mapping
```

---

## 2. 🔑 Năm quyết định thiết kế phải nói được

### (1) Kafka làm buffer, không phải để "cho hiện đại"
Controller **không ghi DB**. Nó publish lên Kafka rồi trả `202 Accepted`.
- App không phải chờ DB → **latency thấp, không mất event khi DB chậm/down**.
- DB down → event vẫn nằm trong Kafka, consumer xử lý lại khi DB sống.
- Đánh đổi: **eventually consistent** — client không biết event đã lưu chưa. Chấp nhận được vì đây là *analytics*, không phải giao dịch tiền.

### (2) `eventId` do SERVER sinh, không nhận từ client
`AppEventServiceImpl.publishEvent()` → `UUID.randomUUID()`.
- Dùng luôn làm **Kafka message key** (phân bố partition đều).
- Dùng làm khoá **dedup** ở `saveEvent()` (`existsByEventId`) + UNIQUE constraint DB.
- Client gửi id thì client có thể gửi trùng / gửi bậy.

### (3) Endpoint nhận cả object lẫn array — nhưng LUÔN trả array
```java
public ResponseEntity<ApiResponse<List<TrackEventResponse>>> trackEvent(@RequestBody JsonNode body) {
    List<TrackEventRequest> requests = body.isArray()
            ? objectMapper.convertValue(body, new TypeReference<List<TrackEventRequest>>() {})
            : List.of(objectMapper.convertValue(body, TrackEventRequest.class));
```
Vì app v1 gửi 1 object, app v2 batch nhiều event. **Response luôn là mảng** → contract ổn định, client không phải phân nhánh khi đọc.
⚠️ Hệ quả: `@Valid` **không chạy** trên `JsonNode` → phải validate thủ công (xem `02-api-controller.md`).

### (4) Bảng dịch tên nằm trong DB, không hardcode
`t_behavior_mapping (action, match_value) → behavior_type`.
- Thêm hành vi mới = INSERT 1 dòng, **không deploy lại**.
- Cache in-memory (`BehaviorMappingCache`), reload mỗi 2 tiếng + `@PostConstruct`.
- ⚠️ Không khớp mapping = **bỏ qua im lặng** (`log.info "no mapping"`). Đây là điểm nghẽn "event biến mất không dấu vết" — cần biết khi debug.

### (5) Hai đường resolve `customerId` — vì có app v1 và v2
- **App v2**: gửi sẵn `customer_id` trong body → dùng thẳng.
- **App v1**: chỉ có `user_id` (là `base_user.id` của hệ cũ) → phải đi 2 chặng:
  ```
  userId --(MariaDB v3m.base_user)--> phone --(PG cdp.customer_identity)--> customerId
  ```
  Cả 2 chặng đều được cache in-memory với **sentinel `__NOT_FOUND__`** (tránh query lặp cho user chắc chắn không có).
- Không resolve được → **bỏ qua forward**, nhưng vẫn LƯU vào `t_app_event` (dữ liệu thô không mất).

---

## 3. Ranh giới trách nhiệm

| Service này **CÓ** làm | Service này **KHÔNG** làm |
|---|---|
| Nhận + lưu raw event | Tính điểm / nghiệp vụ (đó là customer-service) |
| Dịch tên hành vi qua bảng mapping | Lưu `customer_behavior` (đó là cdp-service) |
| Forward sang CDP topic | Xác thực người dùng (auth ở gateway/customer-service) |
| Reprocess event cũ | Đọc/ghi bảng nghiệp vụ của app |

---

## 4. Điểm yếu đã biết (nói ra được là điểm cộng)

| Vấn đề | Chi tiết |
|---|---|
| **Không có auth ở service** | `/api/events` không kiểm token. Dựa hoàn toàn vào gateway. Ai vào được mạng nội bộ là bắn được event giả. |
| **Bỏ qua im lặng** | Thiếu mapping → chỉ log INFO, không metric, không alert. |
| **Không có metric** | Khác customer-service (đã có Micrometer). Service này chưa đo gì. |
| **`POST /api/events/Reprocess` chạy đồng bộ** | Quét cả khoảng ngày trong 1 request HTTP → khoảng lớn sẽ timeout. Không có auth riêng. |
| **`UserResolutionCache` không có TTL / giới hạn size** | `ConcurrentHashMap` chỉ lớn dần; user đổi SĐT thì cache sai đến khi restart. |
| **`t_app_event` không có TTL/partition** | Bảng chỉ phình. Chưa có lifecycle. |

---

## 5. Đi tiếp

→ [`01-cau-truc-package.md`](01-cau-truc-package.md)
