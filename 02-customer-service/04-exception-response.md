# customer-service — Exception & Response chuẩn

## 1. `ApiResponse<T>` — vỏ chung của mọi response

`model/common/ApiResponse.java`
```json
{ "success": true, "message": "…", "data": { … } }
```
Factory: `success(data)`, `success(message, data)`, `ok(message)`, `error(message)`.

`model/common/PageResponse<T>` — bọc `Page<T>` của Spring Data thành shape ổn định cho client (`PageResponse.of(page)`), vì `Page` serialize thẳng ra JSON rất dài dòng và không ổn định giữa các version Spring.

---

## 2. `GlobalExceptionHandler` — 🔑 file đáng học nhất về "map lỗi đúng status"

`exception/GlobalExceptionHandler.java` — `@RestControllerAdvice`

### Bảng đầy đủ

| Exception | HTTP | Message trả về | Ghi chú |
|---|---|---|---|
| `ResourceNotFoundException` | 404 | message gốc | exception tự định nghĩa |
| `ValidationException` | 400 | message gốc | exception tự định nghĩa |
| `IllegalArgumentException` | 400 | message gốc | |
| `IllegalStateException` | 400 | message gốc | |
| `NoSuchElementException` | 404 | message gốc | |
| `BadCredentialsException` | **401** | message gốc | `log.warn` |
| `DisabledException` | **403** | message gốc | tài khoản bị khoá |
| **`MissingServletRequestParameterException`** | **400** | `"Thiếu tham số bắt buộc: {tên}"` | ⚠️ xem bài học dưới |
| **`MethodArgumentTypeMismatchException`** | **400** | `"Tham số không hợp lệ: {tên}"` | ⚠️ xem bài học dưới |
| `ServletRequestBindingException` | **401** | `"Yêu cầu đăng nhập, vui lòng thử lại"` | fallback cho `@RequestAttribute` thiếu |
| `MethodArgumentNotValidException` | 400 | gộp mọi `FieldError.defaultMessage` | `@Valid @RequestBody` fail |
| `MaxUploadSizeExceededException` | 400 | `"File không được vượt quá 10MB"` | |
| `ResponseStatusException` | (status trong exception) | `ex.getReason()` | service ném tường minh |
| `Exception` (catch-all) | **500** | `"Lỗi hệ thống, vui lòng thử lại sau"` | `log.error(DebuggingDTO)` |

---

### ⚠️ Bài học 1 — SB-4902: `@RequestAttribute("userId")` thiếu → 500 sai lệch

Mọi controller dùng `@RequestAttribute("userId") Long userId`. `JwtAuthFilter` **chỉ set attribute này khi JWT hợp lệ**.
Nếu thiếu/hết hạn JWT mà endpoint không bị chặn ở tầng security → Spring ném `ServletRequestBindingException` **trước khi vào controller**.

Không có handler riêng → rơi vào catch-all `Exception` → **500** (đúng ra phải là 401).
Phát hiện khi test end-to-end `/auth/change-password` và `/auth/logout`.

```java
@ExceptionHandler(ServletRequestBindingException.class)
public ResponseEntity<ApiResponse<Void>> handleMissingRequestAttribute(ServletRequestBindingException ex) {
    log.warn("Auth failed (missing/expired JWT): {}", ex.getMessage());
    return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
            .body(ApiResponse.error("Yêu cầu đăng nhập, vui lòng thử lại"));
}
```

---

### ⚠️⚠️ Bài học 2 — SB-4842 fix: thứ tự kế thừa exception quyết định status

**Sự cố:** `GET /rewards/actual-work-bonus` **thiếu** `profileId` → trả **401 "Yêu cầu đăng nhập"** dù JWT hoàn toàn hợp lệ.

**Nguyên nhân:**
```
ServletRequestBindingException            ← handler 401 (thêm ở SB-4902)
   └── MissingServletRequestParameterException   ← LỚP CON!
```
Spring `@ExceptionHandler` chọn handler theo **kiểu cụ thể nhất có handler**. Không có handler cho lớp con → dùng handler của lớp cha → **401**.

**Tác hại thực tế** (comment trong code ghi rõ):
> *"app gặp 401 sẽ đi refresh token vô ích rồi lặp lại đúng lỗi cũ, và người debug bị dẫn sai hướng sang phân quyền."*

**Fix:** tách handler riêng cho lớp con:
```java
@ExceptionHandler(MissingServletRequestParameterException.class)
public ResponseEntity<ApiResponse<Void>> handleMissingRequestParameter(MissingServletRequestParameterException ex) {
    log.warn("Missing required request param: name={}, type={}", ex.getParameterName(), ex.getParameterType());
    return ResponseEntity.status(HttpStatus.BAD_REQUEST)
            .body(ApiResponse.error("Thiếu tham số bắt buộc: " + ex.getParameterName()));
}
```

**Phát hiện thêm cùng họ:** `?profileId=abc` (sai kiểu) ném `MethodArgumentTypeMismatchException` — **không handler nào bắt** → catch-all → **500**, biến lỗi client thành lỗi server (nhiễu alert/metric, app tưởng backend chết). Cũng thêm handler → 400.

**Chi tiết đắt giá về logging:**
```java
log.warn("Request param sai kiểu: name={}, requiredType={}", ex.getName(), ...);
// Chỉ log TÊN param + kiểu cần, KHÔNG log giá trị thô
// vì query param có thể chứa dữ liệu cá nhân (SĐT, tên) theo /log-standard
```

**Chi tiết đắt giá về cách verify:**
> *"Verify bằng service chạy thật vì unit test gọi handler trực tiếp KHÔNG chứng minh được Spring chọn handler con thay vì cha — mà đó chính là chỗ bug."*

💡 **Bài học tổng quát:** khi thêm `@ExceptionHandler`, luôn tự hỏi *"exception nào là lớp con của cái này và sẽ bị nuốt oan?"*

---

### Catch-all — không lộ chi tiết ra ngoài, nhưng log đủ

```java
@ExceptionHandler(Exception.class)
public ResponseEntity<ApiResponse<Void>> handleGeneral(Exception ex) {
    log.error("Unhandled exception: {}", DebuggingDTO.build(ex));
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ApiResponse.error("Lỗi hệ thống, vui lòng thử lại sau"));
}
```

---

## 3. `ResponseStatusException` — cách service ném lỗi có status

Nhiều service ném thẳng:
```java
throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Hồ sơ không thuộc tài khoản này");
throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Không lấy được thông tin thưởng, vui lòng thử lại sau");
```
🔑 Ưu điểm: chọn status **chính xác tại chỗ biết ngữ cảnh**, không phải tạo exception class mới cho từng trường hợp.

### Quy ước status trong dự án

| Status | Khi nào dùng | Ví dụ |
|---|---|---|
| **400** | Client gửi sai | thiếu param, `profileId < 1`, mã giới thiệu sai |
| **401** | Chưa/hết đăng nhập | JWT thiếu/hết hạn, sai mật khẩu |
| **403** | Đã đăng nhập nhưng **không có quyền trên tài nguyên này** | `profileId` không thuộc user (chống IDOR) |
| **404** | Không tìm thấy | user/giao dịch không tồn tại |
| **422** | Xử lý được request nhưng nội dung không hợp lệ về nghiệp vụ | OCR không đọc được ảnh CCCD |
| **502** | **Hệ thống bên ngoài lỗi** | hr-backend/Urbox/EKYC trả lỗi hoặc timeout |
| **500** | Lỗi chính mình, chưa lường trước | catch-all |

🔑 **Vì sao dùng 403 chứ không 404 cho `ownsProfile` fail?**
Comment trong `RewardServiceImpl`:
> *"Trả **403** (không phải 404) cho mọi trường hợp không thuộc — **không tiết lộ profileId nào tồn tại**."*
404 sẽ cho attacker biết "id này có tồn tại, chỉ là không của bạn" ⇒ enumerate được. 403 cho mọi trường hợp thì không phân biệt được.

🔑 **Vì sao phân biệt 502 và 500?**
502 = "không phải lỗi của tôi, là upstream". Giúp:
- Alert/metric phân biệt sự cố nội bộ vs sự cố đối tác.
- App biết là **thử lại được**.

---

## 4. `DebuggingDTO` — chuẩn hoá log exception

`utils/common/DebuggingDTO.java` (giống hệt bên behavior-events)

```java
public static DebuggingDTO build(Throwable throwable) {
    debuggingDTO.setMessage(ExceptionUtils.getMessage(throwable));
    debuggingDTO.setRootCauseMessage(ExceptionUtils.getRootCauseMessage(throwable));
    List<String> stackTrace = Arrays.stream(throwable.getStackTrace())
            .filter(el -> el.getClassName().contains("ttt"))            // 🔑 chỉ giữ class của mình
            .map(el -> String.format("%s.%s(%d)", el.getClassName(), el.getMethodName(), el.getLineNumber()))
            .collect(Collectors.toList());
    debuggingDTO.setStackTrace(stackTrace);
}
```

🔑 **Lọc `contains("ttt")`** — bỏ hết frame của Spring/Hibernate/Tomcat, chỉ giữ frame code của công ty. Stack trace từ 80 dòng còn 3–5 dòng, đọc log nhanh hơn hẳn và tốn ít dung lượng log hơn.

Convention: **mọi `log.error` phải kèm `debug={}` với `DebuggingDTO.build(e)`** (`/log-standard` trong `CLAUDE.md`).

### ⚠️ Ngoại lệ: khi KHÔNG được dùng DebuggingDTO

`KycServiceImpl.applyOcrDataToProfile()`:
```java
} catch (Exception e) {
    // Không dùng DebuggingDTO ở đây — Jackson MismatchedInputException có thể nhúng
    // nguyên giá trị OCR (tên/CCCD/địa chỉ, PII) vào message khi field sai kiểu dữ liệu
    log.warn("OCR auto-fill profile failed: userId={}, exceptionType={}", userId, e.getClass().getSimpleName());
}
```
🔑 `DebuggingDTO` lấy `getMessage()` — mà message của Jackson có thể chứa **nguyên giá trị dữ liệu**. Nếu dữ liệu đó là CCCD/tên/địa chỉ thì PII vào log. Ở chỗ này chỉ log **tên class exception**.

💡 **Nguyên tắc chung của dự án về log:** không bao giờ log PII thô. SĐT phải mask:
```java
private static String mask(String phone) {
    if (phone == null || phone.length() < 5) return "***";
    return phone.substring(0, 3) + "***" + phone.substring(phone.length() - 2);
}
```
(Hàm này lặp lại ở `AuthServiceImpl`, `CdpCustomerServiceImpl`, `WorkerProfileServiceImpl`, `ApplyServiceImpl`, `UserSyncItemService`…)

## 5. Đi tiếp

→ [`05-module-auth.md`](05-module-auth.md)
