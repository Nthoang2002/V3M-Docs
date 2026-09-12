# customer-service — Module KYC (OCR CCCD + đối chiếu khuôn mặt)

Class: `service/auth/impl/KycServiceImpl.java` (445 dòng)
Controller: `ProfileController` (`/profile/kyc/*`)
Đối tác: **EKYC AI Mobifi** qua `EkycProxy`

---

## 1. Ba endpoint

| Method | Path | Body | Trả về |
|---|---|---|---|
| POST | `/profile/kyc/ocr` | multipart: `front`, `back` | `{ frontKey, backKey, ocrFront, ocrBack }` |
| POST | `/profile/kyc/confirm` | multipart: `frontKey`, `backKey`, `face` | 200 hoặc 400 "Khuôn mặt không khớp" |
| POST | `/profile/kyc/restart` | — | reset `isVerified = false` |

---

## 2. 🔑 Luồng 2 bước — vì sao tách?

```
[Bước 1] POST /profile/kyc/ocr    (front + back)
   ├─ validateImageFile × 2        (≤10MB, ext ∈ {jpg,jpeg,png,heic,webp})
   ├─ upload S3 PRIVATE:  kyc/{userId}/front_{ts}.jpg, kyc/{userId}/back_{ts}.jpg
   ├─ callOcr(front) + callOcr(back)      ← dùng BYTES SẴN CÓ, không tải lại từ S3
   ├─ validateCccdSet(front, back)        ← 🔑 SB-5071, xem mục 4
   ├─ applyOcrDataToProfile()             ← auto-fill t_user (best-effort)
   └─ trả { frontKey, backKey, ocrFront, ocrBack }

[Bước 2] POST /profile/kyc/confirm  (frontKey + backKey + face)
   ├─ validateImageFile(face)
   ├─ validateKeyOwnership(userId, frontKey, backKey)   ← 🔑 chống IDOR, xem mục 5
   ├─ upload S3 PUBLIC-READ:  avatars/{userId}/face_{ts}.jpg
   ├─ downloadToBytes(frontKey)  ← tải ảnh CCCD mặt trước từ S3
   ├─ callMatchingFace(front, face)
   │     không khớp → 400 "Khuôn mặt không khớp với ảnh trên CCCD"
   └─ lưu t_user: cccdFrontUrl, cccdBackUrl, kycFaceUrl, isVerified = true
```

🔑 **Vì sao tách 2 bước?** Vì UX: app cần hiển thị **kết quả OCR** cho user xác nhận/sửa **trước khi** chụp selfie. Nếu gộp 1 bước, user chụp cả 3 ảnh rồi mới biết OCR sai.

🔑 **Vì sao truyền `frontKey`/`backKey` giữa 2 bước, không upload lại?** Tránh upload trùng 2 lần cùng 1 ảnh (tốn băng thông của user). Đánh đổi: phải kiểm tra sở hữu key (mục 5).

---

## 3. Public vs Private trên S3 — quyết định có chủ ý

| File | ACL | Đọc bằng | Vì sao |
|---|---|---|---|
| `kyc/{userId}/front_*.jpg`, `back_*.jpg` | **PRIVATE** | presigned URL (7 ngày) | Ảnh CCCD = PII nhạy cảm |
| `avatars/{userId}/face_*.jpg` | **PUBLIC-READ** | public URL vĩnh viễn | Dùng làm ảnh tham chiếu cho **chấm công** — cần đọc bất cứ lúc nào, presigned sẽ hết hạn |

```java
private String resolvePrivateUrl(String objectKey) {
    return storageService.getPresignedUrl(objectKey, PRESIGNED_EXPIRY_DAYS);  // 7 ngày
}
private String resolvePublicUrl(String objectKey) {
    return storageService.getPublicUrl(objectKey);
}
```
🔑 **DB lưu `objectKey`, không lưu URL.** Đổi bucket/domain sau này không phải sửa dữ liệu cũ.

---

## 4. ⚠️ `validateCccdSet()` — SB-5071, kiểm tra tính hợp lệ của BỘ ảnh

Trước SB-5071, user có thể chụp 2 lần mặt trước, hoặc 2 mặt của 2 thẻ khác nhau → OCR vẫn "thành công" và auto-fill dữ liệu lộn xộn.

### 5 kiểm tra

| # | Kiểm tra | Điều kiện từ chối (400) | Message |
|---|---|---|---|
| 1 | **Cùng một mặt** | `front.viewSide == back.viewSide` | "Hai ảnh thuộc cùng một mặt CCCD…" |
| 2 | **Số CCCD lệch** | `digitsOnly(frontId) != digitsOnly(backId)` | "Số CCCD giữa mặt trước và mặt sau không khớp…" |
| 3 | **Ngày sinh lệch** (khác người) | `frontDob != backDob` | "Thông tin mặt trước và mặt sau không khớp…" |
| 4 | **Hai thẻ khác nhau** | `frontExpire != backExpire` | "Mặt trước và mặt sau thuộc hai CCCD khác nhau…" |
| 5 | **Hết hạn** | `expire.isBefore(now)` | "CCCD đã hết hạn (dd/MM/yyyy)…" |

### 🔑 Nguyên tắc "tolerant" — chỉ so khi CẢ 2 mặt đều có giá trị

```java
String frontId = digitsOnly(extractIdNumber(front));
String backId  = digitsOnly(extractIdNumber(back));
if (frontId != null && backId != null && !frontId.equals(backId)) { reject(...); }
```
Field null/rỗng ở 1 mặt → **bỏ qua check đó**, không chặn.
Lỗi parse OCR → **bỏ qua toàn bộ validate**:
```java
} catch (Exception e) {
    log.warn("CCCD set validation skipped — OCR parse fail: userId={}, exceptionType={}", ...);
    return;
}
```
💡 **Vì sao tolerant?** OCR không đọc được 1 field là chuyện bình thường (ảnh mờ, thẻ cũ). Nếu chặn cứng thì user hợp lệ cũng không KYC được. Chỉ chặn khi có **bằng chứng rõ ràng là sai**.

### Trích field: field chính → fallback MRZ
```java
private String extractIdNumber(EkycOcrDetail detail) {
    EkycOcrFieldsExtracted f = detail.getFieldsExtracted();
    if (f == null) return null;
    if (f.getIdNumber() != null && !isBlank(f.getIdNumber().normalizedOrRawValue()))
        return f.getIdNumber().normalizedOrRawValue();
    return mrzValue(f, EkycMrzFields::getIdNumber);      // 🔑 fallback MRZ (dải mã máy đọc mặt sau)
}
```
💡 **MRZ** = Machine Readable Zone — dải ký tự `<<<` ở mặt sau CCCD, OCR đọc chính xác hơn text thường. Mặt trước có field riêng, mặt sau thường chỉ có MRZ.

### Chuẩn hoá dữ liệu trước khi so
```java
private String digitsOnly(String s) {                   // "012 345 678" → "012345678"
    String d = s.replaceAll("\\D", "");
    return d.isEmpty() ? null : d;
}
private LocalDate parseCccdDate(String raw) {           // "dd/MM/yyyy" | ISO | ISO-datetime
    if (v.contains("T")) return LocalDateTime.parse(v).toLocalDate();
    if (v.contains("-")) return LocalDate.parse(v);
    return LocalDate.parse(v, DateTimeFormatter.ofPattern("dd/MM/yyyy"));
}
```
🔑 AI trả nhiều định dạng khác nhau → phải chuẩn hoá trước khi so sánh, nếu không sẽ so `"01/01/1990"` với `"1990-01-01"` và luôn báo lệch.

### ⚠️ Log không PII
```java
private void rejectCccdSet(Long userId, String reason, String message) {
    log.warn("CCCD set rejected: userId={}, reason={}", userId, reason);   // reason = "same_side"|"id_mismatch"|...
    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
}
```
Chỉ log **mã lý do**, không log số CCCD/ngày sinh.

---

## 5. 🔑 `validateKeyOwnership()` — chống IDOR bằng prefix

```java
private void validateKeyOwnership(Long userId, String frontKey, String backKey) {
    String cccdPrefix = "kyc/" + userId + "/";
    if (!frontKey.startsWith(cccdPrefix) || !backKey.startsWith(cccdPrefix)) {
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "File CCCD không hợp lệ");
    }
}
```

⚠️ **Vì sao cần?** Bước 2 nhận `frontKey`/`backKey` **từ client**. Không kiểm tra thì user A gửi `kyc/999/front_xxx.jpg` (key của user B) → dùng ảnh CCCD của người khác để KYC.

🔑 **Kỹ thuật hay:** đặt `userId` **trong chính objectKey** (`kyc/{userId}/…`) biến việc kiểm tra sở hữu thành 1 phép `startsWith` — không cần query DB.
💡 Đây là mẫu thiết kế đáng nhớ: **mã hoá thông tin sở hữu vào định danh tài nguyên**.

---

## 6. Gọi EKYC AI

### `callOcr()` — 3 tầng exception

```java
private Object callOcr(Long userId, MultipartFile image, String label, String objectKey) {
    try {
        String sessionkey = String.valueOf(System.currentTimeMillis());
        EkycApiResponse<EkycOcrData> response = ekycProxy.ocrVekyc(ekycApiKey, image, sessionkey);
        EkycOcrData ocrData = response.getData();

        if (ocrData == null || ocrData.getCode() == null || ocrData.getCode() != 0) {
            log.warn("OCR vekyc failed: userId={}, side={}, code={}, message={}", ...);
            String clientMsg = (aiMsg != null && !aiMsg.isEmpty()) ? aiMsg : "Không thể OCR ảnh CCCD (" + label + ")";
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, clientMsg);   // 422
        }
        return ocrData.getData();
    } catch (ResponseStatusException e) { throw e; }                          // (1) giữ nguyên
    catch (FeignException e) {                                                // (2) lỗi HTTP
        log.error("OCR Feign error: ... status={}, debug={}", e.status(), DebuggingDTO.build(e));
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Dịch vụ OCR tạm thời không khả dụng");
    } catch (Exception e) {                                                   // (3) còn lại
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Dịch vụ OCR tạm thời không khả dụng");
    }
}
```

| Loại | Status | Ý nghĩa |
|---|---|---|
| AI trả `code != 0` | **422** Unprocessable Entity | Ảnh không đọc được (lỗi của **ảnh**, không phải hệ thống) — message của AI trả thẳng cho user |
| `FeignException` / khác | **502** Bad Gateway | Dịch vụ AI lỗi/timeout — user **thử lại được** |

🔑 `catch (ResponseStatusException e) { throw e; }` **phải đặt đầu tiên** — nếu không, exception 422 mình vừa ném sẽ bị `catch (Exception)` bắt lại và biến thành 502.

### `callMatchingFace()`
```java
MultipartFile frontFile = new InMemoryMultipartFile("image", "front.jpg", MediaType.IMAGE_JPEG_VALUE, frontBytes);
EkycApiResponse<EkycMatchFaceResult> response = ekycProxy.matchingFace(ekycApiKey, frontFile, face);
EkycMatchFaceResult matchResult = response.getData();

if (matchResult == null || matchResult.getResult() == null) {
    log.warn("Matching face: result null hoặc data rỗng ...");
    return false;                          // 🔑 fail-closed: không xác định được = KHÔNG khớp
}
return matchResult.getResult();
```
🔑 Với xác thực danh tính, "không biết" phải quy về "**từ chối**" (fail-closed), ngược với các luồng đọc dữ liệu (fail-soft).

💡 `InMemoryMultipartFile` (`utils/common/`) — wrap `byte[]` thành `MultipartFile` để đưa vào Feign `SpringFormEncoder`. Class tự viết vì Spring không có sẵn implementation nào cho byte array.

---

## 7. `applyOcrDataToProfile()` — auto-fill best-effort

Sau khi OCR thành công, **tự động điền** vào `t_user`: `fullName`, `dob`, `gender`, `nationalId`, `issueDate`, `issuePlace`, `address`.

```java
try {
    ... userRepository.save(user);
    log.info("OCR auto-fill profile: userId={}", userId);
} catch (Exception e) {
    // Không dùng DebuggingDTO — Jackson MismatchedInputException có thể nhúng nguyên giá trị OCR (PII) vào message
    log.warn("OCR auto-fill profile failed: userId={}, exceptionType={}", userId, e.getClass().getSimpleName());
}
```
🔑 **Best-effort**: auto-fill lỗi **không được chặn response OCR** — dữ liệu OCR thô vẫn hữu ích cho app hiển thị.

### Xử lý khác biệt giữa các loại thẻ
```java
// permanentAddress: tuỳ loại thẻ (chip_front vs chip_front_new) mà AI trả ở mặt trước hoặc mặt sau
EkycFieldValue permanentAddress = frontFields != null ? frontFields.getPermanentAddress() : null;
if (permanentAddress == null && backFields != null) permanentAddress = backFields.getPermanentAddress();
```

### Map gender
```java
// t_user.gender lưu id giới tính thật theo master-data CRM: 7=Nam(M), 8=Nữ(F), 9=Khác(O) — SB-4257
private Integer mapGender(EkycFieldValue field) {
    String value = field.getValue().trim().toLowerCase();
    if (value.contains("nữ")) return 8;
    if (value.contains("nam")) return 7;
    return null;
}
```
⚠️ Thứ tự `"nữ"` **trước** `"nam"` — nếu ngược lại, chuỗi "Nữ" (chứa cả "n") vẫn ổn, nhưng nguyên tắc là check giá trị đặc thù trước.

---

## 8. Validate file upload

```java
private static final long MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;                       // 10MB
private static final Set<String> ALLOWED_EXTENSIONS = Set.of("jpg","jpeg","png","heic","webp");

private void validateImageFile(MultipartFile file) {
    if (file == null || file.isEmpty())          → 400 "File không được để trống"
    if (file.getSize() > MAX_FILE_SIZE_BYTES)    → 400 "File không được vượt quá 10MB"
    String ext = StringUtils.getFilenameExtension(file.getOriginalFilename().toLowerCase());
    if (ext == null || !ALLOWED_EXTENSIONS.contains(ext)) → 400 "Chỉ chấp nhận định dạng: ..."
}
```
`heic` — định dạng ảnh mặc định của iPhone, bắt buộc phải cho phép.
⚠️ Chỉ kiểm tra **phần mở rộng tên file**, không kiểm tra magic bytes → user đổi tên `.exe` thành `.jpg` vẫn qua. Ở đây rủi ro thấp (file chỉ được đẩy sang AI, không thực thi), nhưng là điểm có thể siết thêm.

Kèm handler `MaxUploadSizeExceededException` → 400 (Spring chặn ở tầng multipart trước khi vào controller).

---

## 9. Object key có timestamp

```java
private String buildObjectKey(String prefix, String originalFilename) {
    String ext = StringUtils.getFilenameExtension(originalFilename);
    String suffix = (ext != null && !ext.isEmpty()) ? "." + ext : ".jpg";
    return prefix + "_" + System.currentTimeMillis() + suffix;
}
// → "kyc/123/front_1718600000000.jpg"
```
🔑 Timestamp trong tên → **không ghi đè** ảnh cũ, giữ được lịch sử KYC (user restart KYC nhiều lần).

## 10. Đi tiếp

→ [`07-module-profile-bank-agreement.md`](07-module-profile-bank-agreement.md)
