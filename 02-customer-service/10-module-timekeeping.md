# customer-service — Module Timekeeping (chấm công)

Module **sâu nhất về nghiệp vụ**. Class chính: `TimekeepServiceImpl` (612 dòng).
Phụ: `FaceRecognitionServiceImpl`, `RecruitmentAreaCacheServiceImpl`, `WorkerRecruitmentStatusSyncService`, `WorkerProfileServiceImpl`, `GeoUtils`.

---

## 1. Bảng endpoint (`TimekeepController`, base `/timekeeping`)

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| POST | `/check` | JWT | 🔑 Check-in / check-out |
| GET | `/status?recruitmentId=` | JWT | Trạng thái hiện tại (`CHECK_IN`/`CHECK_OUT`) + bản ghi mới nhất |
| POST | `/monthly` | JWT | Lịch sử theo tháng (app tab lịch) |
| GET | `/my-recruitments` | JWT | Danh sách vị trí được chấm công + khu vực + JobStatus |
| POST | `/resign?recruitmentId=` | JWT | "Nghỉ làm" — JobStatus → Resigned (chỉ local) |
| POST | `/start-work?recruitmentId=` | JWT | "Vào làm"/"Đi làm" — JobStatus → Working (chỉ local) |
| POST | `/missed-checkout/report` | JWT | Worker tự báo quên check-out |
| GET | `/admin/list` | **public** | Admin: danh sách theo vị trí + khoảng ngày |
| PUT | `/admin/approve` | **public** | Admin: duyệt/từ chối bản ghi |
| GET | `/missed-checkout` | **public** | Danh sách quên check-out theo ngày |
| POST | `/missed-checkout/reset` | **public** | Auto checkout hàng loạt |
| GET | `/sync?date=` | **public** | hr-backend lấy dữ liệu theo `time_date` |
| GET | `/sync/updated?date=` | **public** | hr-backend lấy theo `updated_at` (bắt cả thay đổi do duyệt) |

⚠️ Nhóm `admin`/`sync`/`missed-checkout` nằm trong `PUBLIC_URLS` — auth do **gateway** đảm nhiệm (hr-backend/CRM gọi server-to-server).

---

## 2. `timekeep_record` — bảng chính

| Cột | Ý nghĩa |
|---|---|
| `id` | UUID String (sinh ở `@PrePersist`) |
| **`user_id`** | 🔑 `t_user.id` — định danh worker nội bộ, **luôn có** |
| `customer_id` | CDP UUID — **chỉ để bắn event ATTENDANCE**, có thể null |
| `profile_id`, `recruitment_id`, `recruitment_name` | Vị trí đang chấm |
| **`type_check`** | 🔑 `1`=Check-in `2`=Check-out `4`=Missed `5`=Auto |
| `time_check` (datetime), `time_date` (date) | Mốc chấm + ngày (tách để query theo ngày nhanh) |
| `is_failed` + `failure_reason_code` | Chấm thất bại (`INVALID_LOCATION`, `FACE_MISMATCH`, `SELFIE_MISSING`, `FACE_UNAVAILABLE`, `FACE_API_ERROR`, `MISSING_CHECKIN`) |
| `location` | JSON `{latitude, longitude}` |
| `evident_image` | objectKey S3 ảnh chụp lúc chấm |
| **`timekeeping_status`** | 🔑 `1`=Invalid `2`=Valid |
| `related_checkin_id` | UUID của bản ghi check-in tương ứng (ghép cặp) |
| `hr_timekeep_id` | UNIQUE — id bên CRM, chỉ có với bản ghi sync từ hr-backend (dedup) |

🔑 **Phân biệt `is_failed` và `timekeeping_status`:**
- `is_failed` — **hệ thống** xác định chấm công **thất bại** (GPS ngoài vùng, mặt không khớp)
- `timekeeping_status` — **admin** duyệt hợp lệ hay không (1=chưa/không hợp lệ, 2=hợp lệ)

---

## 3. 🔑 `checkIn()` — luồng đầy đủ

```
POST /timekeeping/check  { recruitmentId, typeCheck, latitude, longitude, selfieBase64, profileId, recruitmentName }
   │
   ├─ (0) resolveCustomerId(userId)     ← chỉ để bắn CDP, null cũng chấm được
   │
   ├─ (1) NẾU typeCheck = CHECK-IN: kiểm tra ca đang mở
   │      lấy bản ghi HỢP LỆ gần nhất (is_failed = false)
   │      là CHECK-IN?
   │        ├─ mở ≥ 16h (forgot-checkout-window-hours) → tự ghi MISS_CHECKOUT đóng ca cũ, cho chấm tiếp
   │        └─ mở < 16h → ném "Bạn có ca chấm công chưa kết thúc. Vui lòng check-out trước."
   │
   ├─ (2) GPS validation (Timer metric timekeeping.gps_validation{result})
   │      areas = areaCacheService.findByRecruitmentId(recruitmentId)
   │        ├─ có areas → findContainingArea() (ray-casting)
   │        │     null → isFailed=true, code=INVALID_LOCATION, result="fail"
   │        │     có   → result="pass"
   │        └─ RỖNG   → FAIL-OPEN, vẫn cho chấm, result="skipped"
   │
   ├─ (3) Face recognition (chỉ CHECK-IN, bỏ qua nếu GPS đã fail)
   │      faceImageUrl = t_user.kyc_face_url (public URL)
   │        ├─ có  → EKYC matchingFace(reference, selfie); không pass → isFailed + code
   │        └─ null → bỏ qua, log.warn (admin review tay)
   │
   ├─ (4) NẾU CHECK-OUT: tìm relatedCheckinId (bản ghi check-in hợp lệ gần nhất)
   │
   ├─ (5) uploadEvidentImage(selfieBase64) → S3 public-read
   │      timekeeping/{yyyy}/{MM}/{dd}/{userId}/evident_{HHmmssSSS}.jpg
   │      lỗi → trả null, KHÔNG chặn chấm công (metric timekeeping.evident_image_upload{result})
   │
   ├─ (6) save timekeep_record
   │      timekeepingStatus = isFailed ? INVALID(1) : VALID(2)
   │
   └─ (7) publishAttendanceEvent(entity) → Kafka cdp-behavior-topic
          customerId null → SKIP (log info), không bắn được thì không cộng điểm
```

---

## 4. ⚠️ SB-5202 — bug "check-in thất bại chặn luôn lần chấm sau"

### Sự cố
Bản ghi chấm **lỗi** (GPS ngoài vùng / face không khớp) vẫn được lưu làm audit với `type_check = 1`.
Mọi chỗ xác định "ca đang mở" lấy **bản ghi gần nhất** ⇒ dòng failed bị hiểu là ca chưa đóng ⇒ worker bị chặn `"Bạn có ca chấm công chưa kết thúc"` và **không chấm lại được**. `getCheckStatus` cũng trả `CHECK_OUT` → app hiện sai nút.

### Fix
Thêm query **bỏ qua hẳn dòng failed**:
```java
Optional<TimekeepRecordEntity> findTopByUserIdAndRecruitmentIdAndIsFailedFalseOrderByTimeCheckDesc(
        String userId, Integer recruitmentId);
```
Dùng ở **cả 5 chỗ** hỏi "ca đang mở": `checkIn` (chặn ca chưa đóng), `getCheckStatus`, tìm `relatedCheckinId` cho check-out, `reportMissedCheckout`, `autoCloseOpenShift`.
Và job `findMissedCheckouts` thêm `AND t.is_failed = 0`.

### 🔑 Vì sao "bỏ qua dòng failed" đúng hơn "xem dòng gần nhất có failed không"
Javadoc repository giải thích:
> *"Bỏ qua hẳn dòng failed cũng xử lý đúng ca ngược lại: **đang mở ca thật rồi chấm lỗi 1 phát thì bản ghi hợp lệ gần nhất vẫn là ca đang mở** → vẫn chặn, bắt check-out."*

Query cũ đã **xoá khỏi repository** để không ai dùng nhầm lại.

💡 **Bài học:** khi thêm 1 trạng thái mới (bản ghi failed) vào bảng, phải rà **mọi truy vấn** đang giả định bảng chỉ chứa bản ghi "thành công".

---

## 5. 🔑 GPS validation — `GeoUtils.isPointInsidePolygon` (ray-casting)

`utils/common/GeoUtils.java`

```java
/**
 * Port nguyên semantics từ TimeKeepV2PolygonGeometry.IsPointInsidePolygon bên hr-backend (ray-casting)
 * để customer-service và CRM cho CÙNG KẾT QUẢ trên cùng dữ liệu — lệch semantics thì worker chấm công
 * qua app v2 và qua CRM sẽ ra 2 kết quả khác nhau trên cùng 1 khu vực.
 *
 * Quy ước trục giữ đúng như hr-backend: x = latitude, y = longitude.
 */
private static final double COORDINATE_TOLERANCE = 1e-9;   // khớp CoordinateTolerance bên hr-backend
```

```java
public static boolean isPointInsidePolygon(Double latitude, Double longitude, List<CoordinatePointDto> polygon) {
    if (latitude == null || longitude == null || polygon == null) return false;
    double x = latitude, y = longitude;
    if (Double.isNaN(x) || Double.isNaN(y)) return false;

    int n = polygon.size();
    if (n < 3) return false;                                  // dưới 3 đỉnh không phải đa giác

    // Trùng đỉnh → tính là NẰM TRONG
    for (CoordinatePointDto v : polygon) {
        if (v == null || v.getLatitude() == null || v.getLongitude() == null) return false;
        if (nearlyEqual(v.getLatitude(), x) && nearlyEqual(v.getLongitude(), y)) return true;
    }

    boolean inside = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {              // duyệt từng CẠNH (j→i)
        double p1X = polygon.get(j).getLatitude(),  p1Y = polygon.get(j).getLongitude();
        double p2X = polygon.get(i).getLatitude(),  p2Y = polygon.get(i).getLongitude();

        double yMin = Math.min(p1Y, p2Y), yMax = Math.max(p1Y, p2Y);
        if (y <= yMin || y > yMax) continue;                  // tia không cắt cạnh này
        if (x > Math.max(p1X, p2X)) continue;

        double dy = p2Y - p1Y;
        if (nearlyEqual(dy, 0)) { if (nearlyEqual(p1X, p2X)) inside = !inside; continue; }

        double xInt = (y - p1Y) * (p2X - p1X) / dy + p1X;     // giao điểm tia ngang với cạnh
        if (nearlyEqual(p1X, p2X) || x <= xInt) inside = !inside;
    }
    return inside;
}
```

### 💡 Ray-casting là gì
Bắn 1 tia từ điểm ra vô cực, đếm số lần cắt cạnh đa giác. **Lẻ = trong, chẵn = ngoài**. `inside = !inside` mỗi lần cắt chính là đếm chẵn/lẻ.

### 🔑 Vì sao PORT NGUYÊN từ C# thay vì tự viết
Đây là điểm hay nhất của class này. Nếu tự viết bằng thư viện Java (JTS, chẳng hạn), 2 hệ thống sẽ khác nhau ở **biên** (điểm nằm đúng trên cạnh, đúng đỉnh, cạnh nằm ngang) — và worker chấm công đúng ranh giới sẽ được CRM chấp nhận nhưng app từ chối (hoặc ngược lại).
→ Có test `GeoUtilsCrossCheckTest` để đối chiếu kết quả với vector chuẩn từ C#.

💡 **Bài học tổng quát:** khi 2 hệ thống phải cho **cùng kết quả** trên cùng dữ liệu, port nguyên thuật toán (kể cả những chỗ trông "kỳ") an toàn hơn viết lại "sạch hơn".

### 🔑 Fail-open khi chưa cấu hình khu vực
```java
} else {
    // Fail-open: vị trí chưa cấu hình khu vực bên CRM (hoặc cache chưa có) thì VẪN CHO chấm công.
    // KHÁC hr-backend v2 (fail-closed "chưa thuộc khu vực nào") — cố ý giữ hành vi cũ của
    // customer-service để bật validate không làm hàng loạt vị trí thiếu cấu hình fail đồng loạt.
    gpsResult = "skipped";
    log.warn("No work areas for recruitmentId={}, GPS validation skipped: userId={}", ...);
}
```
🔑 Đây là **quyết định khác biệt có chủ ý** so với hr-backend. Đánh đổi: validate GPS "không có tác dụng" ở vị trí thiếu cấu hình — nên có metric để theo dõi:
```java
// result=skipped tăng nhanh = khu vực chưa được cấu hình / cache việc làm chưa có areas
//                              (validate đang không có tác dụng);
// result=fail tăng vọt      = cấu hình khu vực sai.
gpsSample.stop(Timer.builder("timekeeping.gps_validation").tag("result", gpsResult).register(meterRegistry));
```
💡 Comment này là ví dụ mẫu mực: **metric nào tăng thì nghĩa là gì** — viết ngay cạnh chỗ đo.

### Đủ 1 khu vực là hợp lệ
```java
/** Khớp hr-backend v2: đủ nằm trong 1 khu vực là hợp lệ, không cần trong tất cả. */
private Integer findContainingArea(List<WorkAreaDto> areas, Double latitude, Double longitude) {
    for (WorkAreaDto area : areas)
        if (GeoUtils.isPointInsidePolygon(latitude, longitude, area.getCoordinates())) return area.getAreaId();
    return null;
}
```

---

## 6. 🔑 Face recognition — `FaceRecognitionServiceImpl`

```java
@Value("${face-recognition.min-similarity:0.6}") private double minSimilarity;

public FaceVerifyResult verify(String customerId, String selfieBase64, String faceImageUrl) {
    if (StringUtils.isBlank(selfieBase64)) return FaceVerifyResult.fail("SELFIE_MISSING");
    if (StringUtils.isBlank(faceImageUrl)) return FaceVerifyResult.fail("FACE_UNAVAILABLE");

    byte[] selfieBytes = Base64.getDecoder().decode(selfieBase64);
    HttpResponse<byte[]> imageDownload = Unirest.get(faceImageUrl).asObject(RawResponse::getContentAsBytes);
    if (!imageDownload.isSuccess() || imageDownload.getBody() == null) return FaceVerifyResult.fail("FACE_UNAVAILABLE");

    // 🔑 Dùng chung EkycProxy (Feign + SpringFormEncoder) với luồng KYC — Unirest multipart
    // ÂM THẦM LÀM SAI LỆCH nội dung ảnh nhị phân (đã verify bytes tải về khớp MD5 với gốc,
    // nhưng AI trả similarity thấp bất thường qua Unirest so với cùng ảnh gửi qua curl/Feign).
    MultipartFile referenceFile = new InMemoryMultipartFile("image",  "face.jpg",   IMAGE_JPEG_VALUE, faceBytes);
    MultipartFile selfieFile    = new InMemoryMultipartFile("selfie", "selfie.jpg", IMAGE_JPEG_VALUE, selfieBytes);

    EkycApiResponse<EkycMatchFaceResult> response = ekycProxy.matchingFace(apiKey, referenceFile, selfieFile);
    ...
    double similarity = matchResult.getSimilarity() != null ? matchResult.getSimilarity() : 0;
    boolean passed = similarity >= minSimilarity;
    return passed ? FaceVerifyResult.pass(similarity) : FaceVerifyResult.fail("FACE_MISMATCH");
}
```

### ⚠️ Bug rất khó tìm: Unirest làm hỏng multipart nhị phân
Comment ghi lại quá trình debug:
- Tải ảnh về, so **MD5** với ảnh gốc → **khớp** (tức tải đúng).
- Nhưng AI trả similarity **thấp bất thường** khi gửi qua Unirest, còn cùng ảnh gửi qua `curl`/Feign thì bình thường.
- ⇒ Vấn đề nằm ở **cách Unirest encode multipart**, không phải ở dữ liệu.
- Fix: dùng chung `EkycProxy` (Feign + `SpringFormEncoder`) với luồng KYC.

💡 **Bài học:** khi kết quả từ dịch vụ ngoài "sai một cách khó hiểu", nghi ngờ **tầng vận chuyển** trước khi nghi ngờ thuật toán của họ. Và cách xác minh: gửi cùng dữ liệu bằng công cụ khác (`curl`) để cô lập biến.

### `FaceVerifyResult` — kiểu trả về tự định nghĩa
```java
@Getter class FaceVerifyResult {
    private final boolean passed; private final double similarity; private final String failureCode;
    public static FaceVerifyResult pass(double similarity) { ... }
    public static FaceVerifyResult fail(String code)       { ... }
}
```
🔑 Không dùng `boolean` trần — cần cả `similarity` (để log/tuning ngưỡng) và `failureCode` (để lưu vào DB, phân biệt nguyên nhân).

### Ảnh tham chiếu lấy từ đâu
```java
private String resolveFaceImageUrl(Long userId) {
    return userRepository.findKycFaceUrlById(userId)
            .filter(key -> !key.isEmpty())
            .map(storageService::getPublicUrl)
            .orElse(null);
}
```
🔑 `t_user.kyc_face_url` — chính selfie đã xác minh trong luồng **KYC**. Đó là lý do ảnh face KYC phải upload **public-read** (xem [06](06-module-kyc.md)).
Chưa KYC → `null` → **bỏ qua** face check, cho chấm công, admin review tay.

---

## 7. Missed checkout — 3 cơ chế

| Cơ chế | Trigger | `type_check` |
|---|---|---|
| **Auto khi check-in ca mới** | Ca cũ mở ≥ 16h, user chấm ca mới | `4` MISSED |
| **Worker tự báo** | `POST /missed-checkout/report` | `4` MISSED |
| **Auto hàng loạt** | `POST /missed-checkout/reset?date=` | `5` AUTO |

### `writeMissedCheckout()` — dùng chung 2 cơ chế đầu
```java
private TimekeepRecordEntity writeMissedCheckout(TimekeepRecordEntity openCheckin) {
    TimekeepRecordEntity missed = TimekeepRecordEntity.builder()
            .userId(openCheckin.getUserId()).customerId(openCheckin.getCustomerId())   // copy từ ca gốc
            .profileId(...).recruitmentId(...).recruitmentName(...)
            .typeCheck(TYPE_MISSED)                       // 4
            .timeCheck(now).timeDate(now.toLocalDate())
            .isFailed(true).failureReasonCode("MISSING_CHECKIN")
            .timekeepingStatus(STATUS_INVALID)
            .relatedCheckinId(openCheckin.getId())
            .build();
    missed = timekeepRecordRepository.save(missed);
    timekeepRecordRepository.updateStatus(openCheckin.getId(), STATUS_INVALID);   // 🔑 ca gốc cũng Invalid
    publishAttendanceEvent(missed);
    return missed;
}
```

### `findMissedCheckouts` — native query với `NOT EXISTS`
```sql
SELECT t.* FROM timekeep_record t
 WHERE t.time_date = :date
   AND t.type_check = 1
   AND t.is_failed = 0                              -- SB-5202
   AND NOT EXISTS (
       SELECT 1 FROM timekeep_record co
        WHERE co.related_checkin_id = t.id
          AND co.type_check IN (2, 4, 5))           -- đã có checkout/missed/auto
```
🔑 Dùng **native query** vì JPQL không diễn đạt `NOT EXISTS` với self-join gọn bằng.

### `autoCheckout()` — batch
```java
List<TimekeepRecordEntity> missed = timekeepRecordRepository.findMissedCheckouts(date);
List<TimekeepRecordEntity> autoRecords = missed.stream()
        .map(checkin -> TimekeepRecordEntity.builder()
                ... .typeCheck(TYPE_AUTO)                       // 5
                .timeCheck(date.atTime(23, 59, 59))             // 🔑 cuối ngày
                .isFailed(false)                                // KHÔNG phải lỗi của worker
                .timekeepingStatus(STATUS_INVALID)              // nhưng cũng chưa hợp lệ
                .relatedCheckinId(checkin.getId()).build())
        .collect(Collectors.toList());
timekeepRecordRepository.saveAll(autoRecords);
```

---

## 8. `getCheckStatus()` — app dựa vào để hiện nút

```java
Optional<TimekeepRecordEntity> latestOpt = repo.findTopBy...IsFailedFalseOrderByTimeCheckDesc(userId, recruitmentId);

String checkState;
if (!latestOpt.isPresent() || latestOpt.get().getTypeCheck() != TYPE_CHECKIN) {
    checkState = CHECK_STATE_IN;                    // chưa có ca / ca gần nhất đã đóng
} else {
    long openHours = Duration.between(latestOpt.get().getTimeCheck(), LocalDateTime.now()).toHours();
    checkState = (openHours >= forgotCheckoutWindowHours) ? CHECK_STATE_IN : CHECK_STATE_OUT;
}
```
🔑 Logic **khớp chính xác** với `checkIn()` — cùng ngưỡng 16h. Nếu 2 chỗ lệch nhau, app hiện nút "Check-out" nhưng server lại nhận check-in (hoặc ngược lại).

---

## 9. `publishAttendanceEvent()` — biên sang CDP

```java
private void publishAttendanceEvent(TimekeepRecordEntity entity) {
    if (entity.getCustomerId() == null) {
        log.info("Skip ATTENDANCE publish (no customerId): id={}, userId={}", ...);
        return;                                       // 🔑 không bắn được thì thôi
    }
    try {
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("timekeepId", entity.getId());
        meta.put("profileId", ...); meta.put("recruitmentId", ...); meta.put("timeDate", ...);
        meta.put("isFailed", entity.getIsFailed());
        meta.put("timekeepingStatus", entity.getTimekeepingStatus() == STATUS_VALID ? "VALID" : "INVALID");
        meta.put("attendanceType", resolveAttendanceType(entity.getTypeCheck()));   // CHECKIN/CHECKOUT/MISSED/AUTO
        meta.put("location", entity.getLocation());

        Map<String, Object> event = new LinkedHashMap<>();
        event.put("customerId", entity.getCustomerId());
        event.put("behaviorType", "ATTENDANCE");
        event.put("channel", "APP");
        event.put("behaviorTime", entity.getTimeCheck().toString());
        event.put("metadata", objectMapper.writeValueAsString(meta));    // 🔑 metadata = STRING JSON

        kafkaTemplate.send(cdpBehaviorTopic, entity.getCustomerId(), objectMapper.writeValueAsString(event));
    } catch (Exception e) {
        log.error("Failed to publish ATTENDANCE event: id={}, debug={}", entity.getId(), DebuggingDTO.build(e));
    }                                                 // 🔑 nuốt — không làm hỏng việc chấm công
}
```
🔑 Payload **giống hệt** cấu trúc mà `BehaviorForwardService` bên behavior-events dựng (`customerId`, `behaviorType`, `channel`, `behaviorTime`, `metadata` là string JSON) — vì cùng đi vào 1 topic, cùng 1 consumer bên cdp-service.
`channel = "APP"` (từ app) hoặc `"HR_SYNC"` (từ `HrTimekeepingSyncConsumer`).

### `approve()` — duyệt lại thì bắn event
```java
if (request.getTimekeepingStatus() == STATUS_VALID && prevStatus != STATUS_VALID
        && record.getTypeCheck() == TYPE_CHECKIN) {
    record.setTimekeepingStatus(STATUS_VALID);
    publishAttendanceEvent(record);                   // 🔑 giờ mới đủ điều kiện cộng điểm
}
```
🔑 Liên hệ với `CdpBehaviorSavedConsumer.isRewardable()`: `CHECKIN` chỉ rewardable khi `timekeepingStatus = VALID`. Admin duyệt xong mới bắn → mới cộng điểm.

---

## 10. `uploadEvidentImage()` — ảnh bằng chứng chấm công

```java
LocalDateTime now = LocalDateTime.now();
String objectKey = String.format("timekeeping/%s/%d/evident_%s.jpg",
        DateTimeFormatter.ofPattern("yyyy/MM/dd").format(now),      // 🔑 NGÀY trước
        userId,                                                     //    userId sau
        DateTimeFormatter.ofPattern("HHmmssSSS").format(now));
storageService.uploadPublic(new InMemoryMultipartFile("evident", objectKey, "image/jpeg", bytes), objectKey);
```

🔑 **Phân cấp theo NGÀY trước, userId sau** — comment giải thích:
> *"vận hành chủ yếu thao tác theo mốc thời gian (đặt lifecycle rule dọn ảnh cũ theo prefix, xoá/archive 1 khoảng ngày, ước lượng dung lượng phát sinh mỗi ngày). Để userId lên trước thì mọi việc đó phải quét toàn bucket."*

🔑 **PUBLIC-READ chứ không presigned** — *"ảnh là dữ liệu lịch sử, admin mở bằng `<img src>` bất kỳ lúc nào, presigned sẽ hết hạn"*.

🔑 **Upload lỗi KHÔNG chặn chấm công**:
```java
} catch (Exception e) {
    result = "fail";
    log.error("Upload ảnh chấm công thất bại, vẫn tiếp tục chấm công: userId={}, debug={}", ...);
    return null;
} finally {
    sample.stop(Timer.builder("timekeeping.evident_image_upload").tag("result", result).register(meterRegistry));
}
```
> *"mất ảnh bằng chứng còn đỡ hơn chặn worker chấm công"*

### `toSyncItem()` — đổi objectKey → URL ở biên đồng bộ
```java
/**
 * DB lưu evident_image dạng objectKey, nhưng CRM cần URL đầy đủ để admin mở ảnh bằng <img src>
 * — CRM không biết bucket/endpoint của S3. Nên đổi sang URL public NGAY Ở BIÊN ĐỒNG BỘ,
 * giữ objectKey trong DB để đổi bucket/domain sau này không phải sửa dữ liệu cũ.
 */
private TimekeepSyncItem toSyncItem(TimekeepRecordEntity e) {
    TimekeepSyncItem item = TimekeepSyncItem.from(e);
    if (item.getEvidentImage() != null && !item.getEvidentImage().isEmpty())
        item.setEvidentImage(storageService.getPublicUrl(item.getEvidentImage()));
    return item;
}
```
💡 **Nguyên tắc lặp lại trong dự án:** DB lưu **định danh ổn định** (objectKey), URL được dựng **ở biên** (lúc trả API / lúc đồng bộ).

---

## 11. 🔑 `IWorkerProfileService` — nguồn duy nhất `userId → profileIds` (SB-5043)

Javadoc interface:
> *"Trước SB-5043 logic này nằm riêng trong `TimekeepServiceImpl`; thưởng thì lại map bằng `customerId` (CDP). Nay **cả 2 nghiệp vụ đọc cùng một chỗ** để không thể lệch danh sách hồ sơ — và CDP ra khỏi nghiệp vụ, chỉ còn phục vụ tra cứu + bắn event."*

```java
public interface IWorkerProfileService {
    List<ActiveRecruitmentDto> getPositions(Long userId);    // cache cache:my-recruitments:{userId} TTL 180s
    List<Long> getProfileIds(Long userId);
    boolean ownsProfile(Long userId, Long profileId);        // 🔑 hàng rào chống IDOR
    void evict(Long userId);
}
```

### Gọi hr-backend bằng PHONE, không phải customerId
```java
HrApiResponse<List<HrActiveRecruitmentItem>> response =
        hrBackendProxy.getListRecruitmentOfUserSystem(phone, hrBackendProperties.getApplyApiKey());
```
Proxy:
```java
/**
 * phone (PII) đi qua HEADER X-App-Phone — KHÔNG qua query param —
 * tránh lộ SĐT vào URL (FeignException message, access log).
 */
@GetMapping("/api/AppUserCore/GetListRecruitmentOfUserSystem")
HrApiResponse<List<HrActiveRecruitmentItem>> getListRecruitmentOfUserSystem(
        @RequestHeader(value = "X-App-Phone") String phone,
        @RequestHeader("api-key") String apiKey);
```
🔑 **PII trong header, không trong URL** — URL bị ghi vào access log của mọi proxy trên đường đi, và nằm trong message của `FeignException`.

### Metric bắt buộc (gọi 3rd party)
```java
sample.stop(Timer.builder("worker.profile_list")
        .tag("result", metricResult)     // success | not_found | fail
        .register(meterRegistry));
```
`FeignException.NotFound` (404) tách riêng thành `not_found` — vì "worker chưa có hồ sơ" là **bình thường**, không được lẫn vào `fail` làm nhiễu alert.

---

## 12. JobStatus — app-customer sở hữu

`t_worker_recruitment_status`: `user_id` + `recruitment_id` → `job_status`
`1`=Working `2`=Resigned `3`=Available `4`=EndWorking (khớp `GlobalConst.JobStatus` bên hr-backend)

```java
/** Overlay JobStatus lên danh sách vị trí. Không có bản ghi → mặc định Available(3):
 *  worker chưa "Vào làm" → app hiện nút Vào làm; bấm Vào làm gọi /start-work (→ Working). */
private void overlayJobStatus(Long userId, List<ActiveRecruitmentDto> positions) { ... }
```

🔑 **JobStatus KHÔNG được cache** — overlay tươi từ DB mỗi lần đọc. Nhờ vậy `getPositions` cache 180s mà vẫn phản ánh ngay khi worker bấm "Vào làm"/"Nghỉ làm".

```java
public List<ActiveRecruitmentDto> getActiveRecruitments(Long userId) {
    List<ActiveRecruitmentDto> positions = new ArrayList<>(workerProfileService.getPositions(userId));  // 🔑 COPY
    overlayJobStatus(userId, positions);
    return positions;
}
```
⚠️ `new ArrayList<>(...)` — vì `getPositions` có thể trả list bất biến/dùng chung; overlay sửa trực tiếp phần tử sẽ làm hỏng cache.

### `resign` / `startWork` — CHỈ ghi local
```java
public void resign(Long userId, Integer recruitmentId) {
    // Nghỉ làm → JobStatus Resigned (chỉ ghi local) + tự đóng ca đang mở. KHÔNG gọi hr-backend.
    upsertWorkerStatus(userId, recruitmentId, JOB_STATUS_RESIGNED);
    autoCloseOpenShift(userId, recruitmentId);
}
public void startWork(Long userId, Integer recruitmentId) {
    upsertWorkerStatus(userId, recruitmentId, JOB_STATUS_WORKING);
}
```
🔑 Đây là **nghiệp vụ của app**, không đồng bộ ngược lên CRM.

### `WorkerRecruitmentStatusSyncService` — gap-fill từ CRM
```java
/**
 * CHỈ INSERT khi chưa có bản ghi (user_id, recruitment_id) — KHÔNG ghi đè:
 * app-customer sở hữu JobStatus, worker tự bấm Đi làm/Nghỉ làm trong app LUÔN THẮNG.
 * Sync chỉ điền chỗ thiếu. Idempotent.
 */
@Transactional
public int gapFill(List<WorkerRecruitmentStatusSyncItem> items) {
    // 1. batch resolve phone → t_user.id (1 query)
    Map<String, Long> phoneToUserId = userRepository.findByPhoneIn(phones)...;
    // 2. nạp trước các cặp (user_id, recruitment_id) đã tồn tại (tránh N+1)
    Set<String> existing = workerRecruitmentStatusRepository.findByUserIdIn(userIds).stream()
            .map(w -> key(w.getUserId(), w.getRecruitmentId())).collect(Collectors.toSet());
    // 3. chỉ insert item chưa có
    for (...) { if (existing.contains(k) || !seenInBatch.add(k)) continue; toInsert.add(...); }
    workerRecruitmentStatusRepository.saveAll(toInsert);
}
```
🔑 3 kỹ thuật chống N+1: batch resolve phone (1 query), nạp trước tập đã tồn tại (1 query), `saveAll` (1 batch insert).
🔑 `seenInBatch` — chống trùng **trong chính batch** (CRM có thể gửi trùng).

## 13. Đi tiếp

→ [`11-module-rule-config.md`](11-module-rule-config.md)
