# behavior-events — API & Controller

File: `controller/AppEventController.java` (base path `/api/events`)

## 1. Ba endpoint

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| `POST` | `/api/events` | (không có ở service — dựa vào gateway) | Nhận 1 event hoặc mảng event |
| `POST` | `/api/events/Reprocess?from=&to=` | (không có) | Chạy lại forward cho event cũ theo khoảng `created_at` |
| `GET` | `/api/events/health` | (không có) | Health check, trả `"OK"` |

## 2. `POST /api/events` — track event

### Request

```jsonc
// Dạng 1: 1 object
{
  "action":     "event",              // BẮT BUỘC — "event" | "view"
  "page":       "DetailJobPage",      // BẮT BUỘC — tên màn hình
  "name":       "nguoi_dung_ung_tuyen_thanh_cong",  // BẮT BUỘC — tên hành vi
  "session_id": "abc-123",            // BẮT BUỘC
  "user_id":    "10234",              // optional — app v1
  "customer_id":"550e8400-...",       // optional — app v2 gửi sẵn
  "timestamp":  "2026-06-17T10:00:00",// optional — thiếu thì lấy now()
  "meta_data":  { "device": { "platform": "android" } }   // optional, tự do
}

// Dạng 2: mảng các object trên
[ {...}, {...} ]
```

🔑 **Naming**: `TrackEventRequest` gắn `@JsonNaming(SnakeCaseStrategy.class)` → JSON dùng `snake_case` (`session_id`, `meta_data`), Java field dùng camelCase.
`@JsonIgnoreProperties(ignoreUnknown = true)` → app thêm field mới không làm vỡ API.

### Response — LUÔN là mảng, HTTP 202 Accepted

```json
{
  "success": true,
  "data": [
    { "eventId": "9f1c...", "status": "ACCEPTED", "message": "Event đã được ghi nhận" }
  ]
}
```
`status` = `ACCEPTED` | `FAILED` (FAILED chỉ khi serialize JSON lỗi — hiếm).

⚠️ **202 nghĩa là "đã nhận", KHÔNG phải "đã lưu".** Việc lưu diễn ra bất đồng bộ ở consumer.

### Code

```java
@PostMapping
public ResponseEntity<ApiResponse<List<TrackEventResponse>>> trackEvent(@RequestBody JsonNode body) {
    List<TrackEventRequest> requests = body.isArray()
            ? objectMapper.convertValue(body, new TypeReference<List<TrackEventRequest>>() {})
            : List.of(objectMapper.convertValue(body, TrackEventRequest.class));
    requests.forEach(this::validate);                          // ← validate THỦ CÔNG
    List<TrackEventResponse> responses = appEventService.publishEvents(requests);
    return ResponseEntity.accepted().body(ApiResponse.success(responses));
}
```

### 🔑 Vì sao phải validate thủ công

Body khai là `JsonNode` → Spring **không biết** kiểu đích nên `@Valid` vô nghĩa. Phải tự gọi Bean Validation:

```java
private void validate(TrackEventRequest request) {
    Set<ConstraintViolation<TrackEventRequest>> violations = validator.validate(request);
    if (!violations.isEmpty()) {
        String message = violations.stream()
                .map(ConstraintViolation::getMessage)
                .collect(Collectors.joining(", "));
        throw new ValidationException(message);       // → GlobalExceptionHandler → 400
    }
}
```
`Validator` ở đây là `javax.validation.Validator` — Spring Boot tự đăng ký bean này khi có `spring-boot-starter-validation`.

⚠️ **Hệ quả cần biết**: nếu 1 event trong mảng sai, `forEach` ném ngay → **cả mảng bị 400**, không event nào được publish. Đây là "all or nothing" ở khâu validate (nhưng khâu publish thì mỗi event độc lập — xem `publishEvents`).

## 3. `POST /api/events/Reprocess`

```java
@PostMapping("/Reprocess")
public ResponseEntity<ApiResponse<ReprocessResult>> reprocess(
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) LocalDateTime from,
        @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) LocalDateTime to) { ... }
```
- Format: `2026-01-01T00:00:00`
- Trả `{ total, forwarded, skipped }`
- **Dùng khi nào?** Thêm mapping mới vào `t_behavior_mapping` → các event cũ trước đó bị skip nay có thể forward lại.
- ⚠️ Chạy **đồng bộ** trong request → khoảng ngày lớn sẽ timeout HTTP. Nên gọi từng ngày một.
- ⚠️ Không idempotent về phía CDP: gọi 2 lần thì CDP nhận 2 lần cùng behavior.

## 4. `ApiResponse<T>` — wrapper chuẩn

`model/common/ApiResponse.java`
```java
{ "success": boolean, "message": String, "data": T }
```
Factory: `success(data)`, `success(message, data)`, `ok(message)`, `error(message)`.
🔑 Cùng shape với `ApiResponse` bên customer-service → client parse thống nhất.

## 5. `GlobalExceptionHandler`

`exception/GlobalExceptionHandler.java` — `@RestControllerAdvice`

| Exception | HTTP | Body |
|---|---|---|
| `ResourceNotFoundException` | 404 | `error(ex.getMessage())` |
| `ValidationException` | 400 | message của exception |
| `IllegalArgumentException` | 400 | |
| `IllegalStateException` | 400 | |
| `NoSuchElementException` | 404 | |
| `MethodArgumentNotValidException` | 400 | gộp mọi `FieldError.defaultMessage` |
| `Exception` (catch-all) | 500 | `"Lỗi hệ thống, vui lòng thử lại sau"` + `log.error(DebuggingDTO)` |

🔑 Catch-all **không** trả message gốc ra client (tránh lộ stack/nội bộ), nhưng **có** log đầy đủ qua `DebuggingDTO`.

## 6. Swagger

`swagger/Swagger2Config.java` — springfox 2.8.0, quét `com.ttt.v3m.app.event.controller`.
Truy cập: `http://host:9093/swagger-ui.html`
> Service này **không có** security scheme trong Swagger (khác customer-service có `Authorization` apiKey) vì không tự xác thực.

## 7. Đi tiếp

→ [`03-kafka.md`](03-kafka.md)
