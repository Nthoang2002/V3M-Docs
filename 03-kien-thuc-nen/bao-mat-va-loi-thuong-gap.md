# Kiến thức nền — Bảo mật & các lỗi thường gặp trong V3M

Tổng hợp mọi bài học bảo mật + bug đã xảy ra thật, rút từ 2 repo.

---

# PHẦN A — BẢO MẬT

## A1. 🔑 IDOR — lỗ hổng nguy hiểm nhất của dự án

**IDOR** (Insecure Direct Object Reference): đổi `?profileId=1234` → `1235` để xem dữ liệu người khác.

### Ba chỗ đã được gác

| Chỗ | Rủi ro | Cách gác |
|---|---|---|
| `/rewards/*?profileId=` | 🔑 `profileId` **tuần tự, dễ đoán**, dữ liệu là **thu nhập** | `requireOwnedProfile()` → **403** |
| `/profile/kyc/confirm` (`frontKey`, `backKey`) | Dùng ảnh CCCD của người khác để KYC | `validateKeyOwnership()` — `startsWith("kyc/{userId}/")` → **403** |
| `/incentives/*` | Xem hoa hồng người khác | **Không nhận `profileIds` từ client**, dựng server-side từ JWT |

### 🔑 403 chứ không 404
```java
// Trả 403 (không phải 404) cho mọi trường hợp không thuộc — KHÔNG TIẾT LỘ profileId nào tồn tại.
```
404 cho attacker biết "id này có tồn tại, chỉ không phải của bạn" ⇒ enumerate được.

### 💡 Bài học lớn: bỏ một thứ ở A làm mất lá chắn ở B
SB-5043 bỏ `customerId` khỏi lời gọi hr-backend. `customerId` trông chỉ là "tham số dư" — nhưng nó chính là thứ hr-backend dùng để kiểm tra sở hữu (`ProfileBelongsToCustomerAsync`).
🔑 **Khi refactor bỏ tham số, phải hỏi: tham số đó có đang được dùng để kiểm tra quyền ở đâu không?**

### 💡 Kỹ thuật: nhúng sở hữu vào định danh tài nguyên
```java
String cccdPrefix = "kyc/" + userId + "/";
if (!frontKey.startsWith(cccdPrefix)) throw 403;
```
Kiểm tra sở hữu bằng 1 phép `startsWith`, **không cần query DB**.

---

## A2. ⚠️ `/admin/**` nằm trong `PUBLIC_URLS`

```java
private static final String[] PUBLIC_URLS = { "/auth/**", "/admin/**", ... };
```
🔑 **Mọi endpoint dưới `/admin/` đều permitAll ở tầng URL.**

Vì thế các API admin thật phải đặt ở path khác:
`/gift-redemptions/**` · `/earn-transactions/**` · `/users/**` · `/gift-price-history/**` · `/earn-rules/**` · `/gifts/*/points`

Ngoại lệ duy nhất an toàn: `POST /admin/cache/refresh` có `@PreAuthorize("hasRole('ADMIN')")` ở **tầng method**.

💡 **Bài học:** 1 dòng `permitAll` đặt sai chỗ có thể vô hiệu hoá phân quyền cả nhóm API. Khi thêm endpoint, **luôn kiểm tra nó có bị prefix nào trong `PUBLIC_URLS` nuốt không**.

---

## A3. ⚠️ Thứ tự kiểm tra quyết định đúng/sai về TIỀN

### Ví dụ 1 — `ApplyServiceImpl.resolveReferralId()`
```java
// KHÔNG được xét applyYourself trước: ApplyController tự suy cờ này TỪ SỰ CÓ MẶT của referralCode
// (có mã → false), nên xét trước thì NLD tự ứng tuyển có nhập mã sẽ thành người giới thiệu của
// CHÍNH MÌNH → TỰ ĂN HOA HỒNG.
if (code == null || code.trim().isEmpty()) { ... }     // ← xét MÃ trước
```

### Ví dụ 2 — `AuthServiceImpl.login()`
```java
if (!passwordEncoder.matches(plainPassword, user.getPassword())) throw BadCredentials;  // ← mật khẩu TRƯỚC
if (user.getStatus() == UserStatus.BLOCKED) throw Disabled;                             // ← trạng thái SAU
```
Ngược lại thì attacker biết "SĐT này tồn tại nhưng bị khoá" mà không cần mật khẩu.

### Ví dụ 3 — `ApplyServiceImpl.apply()`
```java
Long referralId = resolveReferralId(request, appUserId);   // validate TRƯỚC
...
hrBackendClient.createProfile(...);                        // gọi HTTP SAU
```
> *"hồ sơ đã tạo bên CRM thì **không rollback được qua HTTP**"*

🔑 **Nguyên tắc:** với thao tác không rollback được, mọi validate phải xong trước khi gọi.

---

## A4. Không tin client — bảng ranh giới tin cậy

| Nguồn | Tin được? | Ví dụ |
|---|---|---|
| `@RequestAttribute("userId")` (từ JWT qua filter) | ✅ | Mọi nghiệp vụ dùng cái này |
| `@RequestParam` / `@RequestBody` | ❌ | `profileId`, `frontKey`, `referralCode` — phải validate + gác |
| Header `X-Forwarded-For` | ❌ | Chỉ dùng audit, không phân quyền |
| Client "đã ẩn nút" | ❌ | `acceptMission` vẫn gate server-side điều kiện hiển thị |

```java
// SB-4386: chặn nhận nếu chưa thoả điều kiện hiển thị. Gate SERVER-SIDE —
// không tin client đã ẩn mission, vì user vẫn có thể gọi accept trực tiếp theo ID.
```
```java
// người giới thiệu = chính người đang gọi API, lấy appUserId từ JWT. KHÔNG nhận id do client gửi lên
// — tin client thì ai cũng tự khai mình là người giới thiệu của mọi hồ sơ để nhận hoa hồng.
```

---

## A5. PII trong log — quy tắc `/log-standard`

| Dữ liệu | Được log? |
|---|---|
| `userId`, `profileId`, `recruitmentId`, `eventId` | ✅ id kỹ thuật |
| SĐT | ⚠️ chỉ mask: `090***12` |
| Tên, CCCD, ngày sinh, địa chỉ | ❌ không bao giờ |
| Giá trị query param thô | ❌ (có thể chứa PII) |
| FCM token | ⚠️ 12 ký tự đầu |
| Exception message | ⚠️ **cẩn thận** |

### 🔑 Bẫy: exception message chứa PII
```java
} catch (Exception e) {
    // Không dùng DebuggingDTO ở đây — Jackson MismatchedInputException có thể nhúng
    // nguyên giá trị OCR (tên/CCCD/địa chỉ, PII) vào message khi field sai kiểu dữ liệu
    log.warn("OCR auto-fill profile failed: userId={}, exceptionType={}", userId, e.getClass().getSimpleName());
}
```

### 🔑 PII trong URL
```java
/**
 * phone (PII) đi qua HEADER X-App-Phone — KHÔNG qua query param —
 * tránh lộ SĐT vào URL (FeignException message, access log).
 */
@RequestHeader(value = "X-App-Phone") String phone
```
💡 URL bị ghi vào access log của **mọi proxy trên đường đi**, và nằm trong message của `FeignException`.

### ⚠️ Chỗ chưa chuẩn
```java
log.error("Kafka deserialize failed: raw='{}', debug={}", raw, ...);   // RuleEventConsumer — log cả payload
```
So với `CdpBehaviorSavedConsumer` (chỉ log `rawLen`) thì chỗ này lỏng hơn.

---

## A6. SSRF / LFI khi tải URL từ nguồn ngoài

```java
private byte[] downloadBytes(String rawUrl) throws Exception {
    URL url = new URL(rawUrl);
    // Chỉ cho phép http/https — ngăn file://, ftp://, jar:// gây SSRF/LFI
    String protocol = url.getProtocol();
    if (!"http".equals(protocol) && !"https".equals(protocol))
        throw new IllegalArgumentException("Unsupported protocol in raw URL: " + protocol);
    try (InputStream in = url.openStream()) { return in.readAllBytes(); }
}
```
⚠️ URL này đến từ hr-backend. `file:///etc/passwd` sẽ khiến job **đọc file trên server rồi upload lên S3**.

⚠️ **Còn thiếu:** giới hạn kích thước (`readAllBytes()` không giới hạn → OOM), chặn IP nội bộ (`169.254.169.254` metadata endpoint, `127.0.0.1`, `10.0.0.0/8`).

---

## A7. HTML injection trong PDF

```java
// Nội dung render ra HTML rồi convert PDF → ESCAPE mọi giá trị người dùng tự nhập
// (họ tên, địa chỉ, sđt) để tránh HTML INJECTION phá vỡ bố cục PDF.
.replace("{{fullName}}", esc(user.getFullName()))
private String esc(String value) { return value != null ? HtmlUtils.htmlEscape(value) : ""; }
```

---

## A8. Public vs Private trên object storage

⚠️ `ctv/{userId}/contract.pdf` — `userId` **tuần tự** ⇒ objectKey đoán được ⇒ public URL = lộ hợp đồng mọi CTV.
```java
// Lưu objectKey (KHÔNG phải URL) — nội dung chứa PII đầy đủ nên KHÔNG dùng getPublicUrl()
// (vĩnh viễn, không xác thực, objectKey ĐOÁN ĐƯỢC từ userId tuần tự)
// — build lại presigned URL (hết hạn, ký) mỗi lần đọc.
```

🔑 Quy tắc: file nào **đoán được key** + **chứa PII** ⇒ bắt buộc PRIVATE + presigned.

---

## A9. Message lỗi không tiết lộ thông tin

```java
throw new BadCredentialsException("Số điện thoại hoặc mật khẩu không đúng");   // giống nhau cho cả 2 case
```
```java
catch (Exception e) { throw new BadCredentialsException("Số điện thoại hoặc mật khẩu không đúng"); }  // RsaUtil
```
```java
return ResponseEntity.status(500).body(ApiResponse.error("Lỗi hệ thống, vui lòng thử lại sau"));      // catch-all
```

---

## A10. Cờ nguy hiểm trên production

```java
@Value("${otp.enable:true}") private Boolean otpEnable;
...
if (!otpEnable) { return; }        // verifyRegisterOtp BỎ QUA kiểm tra
```
⚠️ `otp.enable=false` trên prod = **ai cũng đổi được mật khẩu của bất kỳ ai**.

Tương tự: `management.endpoints.web.exposure.include: "*"` + `/actuator/**` trong `PUBLIC_URLS` — chỉ an toàn nếu Prometheus scrape qua mạng nội bộ và gateway không route `/actuator/**` ra ngoài.

---

# PHẦN B — LỖI THƯỜNG GẶP (đã xảy ra thật)

## B1. Spring proxy — annotation vô tác dụng khi self-invocation

Xuất hiện **3 lần**: `UserSyncItemService`, `GiftRedemptionTxService`, `FcmDispatchService`.
→ [`spring-boot-annotations.md`](spring-boot-annotations.md) mục 2.

## B2. Thứ tự kế thừa exception (SB-4842)

`MissingServletRequestParameterException` là **lớp con** của `ServletRequestBindingException` ⇒ thiếu param bị trả **401** thay vì 400.
> *"app gặp 401 sẽ đi refresh token vô ích rồi lặp lại đúng lỗi cũ"*

🔑 Khi thêm `@ExceptionHandler`, luôn hỏi: *"exception nào là lớp con của cái này và sẽ bị nuốt oan?"*
🔑 *"Verify bằng service chạy thật vì unit test gọi handler trực tiếp KHÔNG chứng minh được Spring chọn handler con thay vì cha."*

## B3. Race condition — check-then-act qua mạng

```
Request A: lookup(phone) → không thấy      Request B: lookup(phone) → không thấy
Request A: create(phone) → customer 1      Request B: create(phone) → customer 2  ❌ TRÙNG
```
Fix: đẩy cả 2 bước sang **1 API nguyên tử của bên sở hữu dữ liệu** (`ResolveOrCreate`).
🔑 **Nguyên tắc:** check-then-act qua mạng **luôn** có race.

## B4. 🔑🔑 Bốn failure của `MissionEnrollmentService`

| # | Triệu chứng | Nguyên nhân | Fix |
|---|---|---|---|
| 1 | Burst 8 request → **7 cái 500** | `saveAll` ném `DataIntegrityViolationException`, Hibernate mark **rollback-only** | `ON DUPLICATE KEY UPDATE id = id` |
| 2 | `HikariPool-1 - Connection is not available, timed out after 30000ms` | 15 statement × transaction riêng = 2 connection × 15 lượt | Gộp **1 statement cho cả request** |
| 3 | `DeadlockLoserDataAccessException` | Khoá unique index theo thứ tự ngược nhau | **Sắp xếp row** trước khi ghi |
| 4 | Cạn pool | `REQUIRES_NEW` luôn cần connection thứ 2 | **Bỏ** `REQUIRES_NEW` |

**Kết quả đo:** 8/16/24/32 request song song đều 200, đúng 21 dòng, 0 exception.

🔑 *"KHÔNG bắt exception ở đây vì trong cùng transaction, **catch không cứu được** (tx đã rollback-only)."*

## B5. Poison record làm đói job (`CdpBackfillJob`)

Job luôn lấy `PageRequest.of(0, batchSize)`. Bản ghi **không bao giờ xử lý được** (user thiếu phone) sẽ:
đứng đầu → luôn được chọn → luôn fail → chiếm hết slot → **user hợp lệ không bao giờ tới lượt**.
Fix: **loại khỏi query nguồn** (`AND u.phone IS NOT NULL AND u.phone <> ''`).

## B6. Trạng thái mới làm hỏng truy vấn cũ (SB-5202)

Thêm bản ghi chấm công **thất bại** (`is_failed=1`, `type_check=1`) ⇒ **5 truy vấn** "ca đang mở" hiểu nhầm là ca chưa đóng ⇒ worker bị chặn.
Fix: query mới bỏ hẳn dòng failed, áp dụng ở **cả 5 chỗ**, **xoá query cũ khỏi repository**.
🔑 Khi thêm trạng thái mới vào bảng, **rà mọi truy vấn** đang giả định bảng chỉ chứa bản ghi "thành công".

## B7. Chặn quá tay tạo bế tắc (SB-5174)

`delete()` chặn **mọi** tài khoản `isDefault`, mà `create()` **luôn** set tài khoản đầu tiên làm mặc định ⇒ user có 1 tài khoản không xoá được.
Fix: chỉ chặn khi `countByUserId > 1`.
🔑 Khi viết ràng buộc "không được xoá X", kiểm tra **trạng thái biên** — X có phải phần tử cuối không? Có đường thoát không?

## B8. Copy field mà không map (SB-5145, gender)

- `bankName`/`bankShortName` copy thẳng từ request mà app **chỉ gửi `bankId`** ⇒ luôn NULL.
- `gender` copy thẳng `req.getGender()` (quy ước app v1: F=1, M=2) vào `t_user.gender` (id master-data: 7/8/9) ⇒ **sai id hoàn toàn cho mọi user sync từ CRM**.

🔑 Fix chung: **server tự resolve từ nguồn đáng tin**, không nhận từ client / không copy giữa 2 quy ước khác nhau.
🔑 `mapHrGenderToMasterDataId` trả `null` cho giá trị không xác định — *"không đoán, để tránh ghi đè dữ liệu đã đúng từ nguồn khác"*.

## B9. Tầng vận chuyển làm hỏng dữ liệu nhị phân

Unirest multipart **âm thầm làm sai lệch** ảnh: MD5 bytes tải về **khớp** ảnh gốc, nhưng AI trả similarity thấp bất thường; cùng ảnh gửi qua `curl`/Feign thì bình thường.
Fix: dùng chung `EkycProxy` (Feign + `SpringFormEncoder`).
🔑 Khi kết quả từ dịch vụ ngoài "sai một cách khó hiểu", nghi ngờ **tầng vận chuyển** trước. Xác minh bằng cách gửi cùng dữ liệu qua công cụ khác.

## B10. S3-compatible ≠ tương thích 100%

3 flag phải tắt: `pathStyleAccessEnabled(true)`, `checksumValidationEnabled(false)` (403 SignatureDoesNotMatch), `chunkedEncodingEnabled(false)`.

## B11. Từ vựng dùng chung trôi dạt (SB-4815)

`behavior_type` (PostgreSQL, repo A) và `trigger_event_type` (MariaDB, repo B) là **cùng từ vựng, không có ràng buộc kỹ thuật nào**.
Đo trên UAT: giao điểm giữa 2 bên **chỉ có 1 mã** (`DAILY_LOGIN`).
Lệch 1 ký tự ⇒ nhiệm vụ không bao giờ chạy, **không có log lỗi** (chỉ `log.info "no mapping"`).
🔑 Cần **quy trình đối chiếu định kỳ**.

## B12. Tràn số khi ép `long` → `int`

```java
int start = (int) pageable.getOffset();     // getOffset() = page * size, là LONG
if (start < 0 || start >= gifts.size()) return Page.empty();   // 🔑 check < 0
```
`?page=999999999&size=100` → tràn thành **số âm** → `subList` ném `IndexOutOfBoundsException` → 500.

## B13. `List.of()` + `contains(null)` = NPE

```java
if (gift.getType() == null) { log.warn(...); return true; }        // phải check TRƯỚC
return !urboxProperties.getExcludedGiftTypes().contains(gift.getType());
```
`List.of()` (immutable list của Java 9+) ném `NullPointerException` khi `contains(null)`. `Arrays.asList()` thì không.

## B14. `@Builder.Default`

```java
@Builder.Default private Integer currentCount = 0;
```
Thiếu annotation này ⇒ `builder().build()` cho `null` thay vì `0`.

## B15. `@Enumerated` mặc định là ORDINAL

Luôn khai `@Enumerated(EnumType.STRING)`. ORDINAL lưu số thứ tự ⇒ thêm giá trị vào giữa enum làm **lệch nghĩa toàn bộ dữ liệu cũ**.

## B16. `Comparator` + null

```java
.sorted(Comparator.comparing(HrRecruitmentItem::getIndexJob, Comparator.nullsLast(Integer::compareTo)))
```
Không có `nullsLast` ⇒ NPE khi sort.

## B17. `toMap` + key trùng

```java
.collect(Collectors.toMap(UrboxGiftItem::getId, UrboxGiftItem::getTitle, (a, b) -> a))
```
Thiếu merge function ⇒ `IllegalStateException: Duplicate key`.

## B18. Timezone

```dockerfile
ENV TZ="Asia/Ho_Chi_Minh"
```
`LocalDateTime.now()` phụ thuộc timezone JVM. Container mặc định UTC ⇒ lệch 7 tiếng ⇒ `period_key` DAILY sai, `time_date` sai.

## B19. Font trong container

Container `openjdk:11-jre` **không có font tiếng Việt** ⇒ PDF ra ô vuông. Phải bundle font vào jar (`resources/fonts/DejaVuSans.ttf`).

## B20. Kafka poison pill

Message hỏng vĩnh viễn mà consumer ném exception ⇒ Kafka giao lại mãi ⇒ **partition đứng im**.
Fix: **nuốt** lỗi deserialize/validate, chỉ **ném lại** lỗi tạm thời.
