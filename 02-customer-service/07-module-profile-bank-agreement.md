# customer-service — Profile · Bank Account · Agreement

3 module nhỏ nhưng có nhiều bài học về validate và audit.

---

## A. Profile (`ProfileServiceImpl`)

`GET /profile` · `PUT /profile`

### 1. `t_user` — bảng trung tâm

`entities/auth/UserEntity.java` — nhóm cột:

| Nhóm | Cột |
|---|---|
| **Định danh** | `id`, `username`, `email`, `phone` (UNIQUE), `customer_id` (UUID, UNIQUE) |
| **Bảo mật** | `password` (BCrypt), `role` (USER/ADMIN), `status` (ACTIVE/INACTIVE/BLOCKED) |
| **Hồ sơ cơ bản** | `full_name`, `dob`, `gender`, `national_id`, `issue_date`, `issue_place`, `address`, `address_birth` |
| **Hồ sơ mở rộng (SB-4257)** | `is_married`, `literacy_id`, `language_ids` (CSV), `ethnic`, `address_temporary`, `experience`, `experience_note`, `introduction` |
| **KYC** | `is_verified`, `cccd_front_url`, `cccd_back_url`, `kyc_face_url` (objectKey S3) |
| **KYC staging** | `cccd_front_raw`, `cccd_back_raw`, `kyc_face_raw` (URL từ CRM, chờ migrate) |
| **CTV / CRM** | `employee_code`, `agent_support` (AbpUsers.Id), `ctv_contract_url` |
| **Khác** | `avatar_path`, `favorite_recruitment_ids` (CSV), `cdp_sync_count`, `source` (APP/CRM_SYNC) |
| **Audit** | `created_at` `@CreatedDate`, `updated_at` `@LastModifiedDate` |

```java
@org.hibernate.annotations.Type(type = "uuid-char")
@Column(name = "customer_id", unique = true, length = 36)
private UUID customerId;
```
🔑 `uuid-char` — MariaDB không có kiểu UUID native. Lưu dạng `VARCHAR(36)` (có gạch nối) chứ không phải `BINARY(16)`, để query bằng tay dễ đọc.
⚠️ **Khác** với `earn_rule.id` — cái đó dùng `BINARY(16)` (xem [11](11-module-rule-config.md)). Trong cùng 1 DB có **2 cách lưu UUID khác nhau**, phải nhớ.

### 2. `updateProfile()` — patch từng field

```java
if (request.getFullName() != null) user.setFullName(request.getFullName());
if (request.getDob() != null)      user.setDob(request.getDob());
...
user.setCdpSyncCount(0);            // 🔑 đánh dấu cần đồng bộ lại sang CDP
```
🔑 Chỉ set khi `!= null` → **PATCH semantics**: client chỉ gửi field muốn đổi, không phải gửi cả object.
🔑 `setCdpSyncCount(0)` — cờ cho `CdpProfileSyncJob` biết bản ghi này cần đẩy sang CDP (job quét `cdpSyncCount < 2`).

### 3. Validate theo master-data

```java
private static final Set<Integer> VALID_GENDER_IDS = Set.of(7, 8, 9);   // 7=Nam 8=Nữ 9=Khác

if (request.getGender() != null) {
    if (!VALID_GENDER_IDS.contains(request.getGender()))
        throw new ValidationException("Giới tính không hợp lệ — phải là 7 (Nam), 8 (Nữ) hoặc 9 (Khác)");
    user.setGender(request.getGender());
}

// literacy/language phải là ID hợp lệ trong master-data — chỉ tra cache 1 lần
if (request.getLiteracyId() != null || request.getLanguageIds() != null) {
    MasterDataResponse masterData = hrCacheService.getMasterData();     // 🔑 1 lần cho cả 2
    ...
}

/** Chặn ID không thuộc master-data. Cache cold (list null/rỗng) → bỏ qua để không chặn nhầm khi chưa sync. */
private void validateMasterDataId(Integer id, List<HrLookupItem> catalog, String label) {
    if (id == null || catalog == null || catalog.isEmpty()) return;     // 🔑 fail-open khi cache trống
    boolean valid = catalog.stream().anyMatch(item -> id.equals(item.getId()));
    if (!valid) throw new ValidationException(label + " không hợp lệ (id=" + id + ")");
}
```
🔑 **Fail-open khi cache trống** — nếu cache chưa sync mà chặn hết thì user không cập nhật được profile. Đánh đổi có ý thức.
⚠️ **Khác** với `BankAccountServiceImpl.resolveBank()` — ở đó cache trống thì **502** (fail-closed), vì lưu tài khoản ngân hàng thiếu tên là hỏng dữ liệu, còn literacy sai thì không nghiêm trọng.

### 4. `language_ids` lưu CSV
```java
/** [1, 2] → "1,2". Rỗng/null → null (xóa ngoại ngữ). */
private String serializeLanguageIds(List<Integer> ids) {
    if (ids == null || ids.isEmpty()) return null;
    return ids.stream().filter(Objects::nonNull).map(String::valueOf).collect(Collectors.joining(","));
}
```
💡 Chuẩn hoá thì phải tách bảng `t_user_language`. Chọn CSV vì: chỉ dùng để hiển thị, không bao giờ query/join theo ngôn ngữ. **Đơn giản hoá có chủ ý** (cùng pattern với `favorite_recruitment_ids`).

### 5. `resolveContractUrl()` — 1 cột chứa 2 dạng dữ liệu
```java
/**
 * ctv_contract_url mang 2 dạng: URL đầy đủ (CRM sync, dùng thẳng) hoặc objectKey S3 nội bộ
 * (app tự ký qua POST /ctv/contract/sign — SB-4652) cần build presigned URL mỗi lần đọc, vì
 * nội dung chứa PII đầy đủ (họ tên/CCCD/ngày sinh/sđt/địa chỉ) không dùng URL public vĩnh viễn.
 */
private String resolveContractUrl(String stored) {
    if (stored.startsWith("http://") || stored.startsWith("https://")) return stored;
    return storageService.getPresignedUrl(stored, 7);
}
```
💡 Kỹ thuật "cột đa hình" — không đẹp về mặt schema nhưng tránh migration + backfill dữ liệu cũ từ CRM. Đánh đổi có ý thức, và **được ghi rõ trong Javadoc** để người sau không nhầm.

### 6. Profile nhúng trạng thái điều khoản
```java
response.setAgreement(agreementService.getStatus(user.getId()));
```
→ App chỉ cần 1 API `GET /profile` là biết có phải hiện màn "chấp nhận điều khoản" không.

---

## B. Bank Account (`BankAccountServiceImpl`)

`GET|POST /profile/bank-accounts` · `PUT|DELETE /profile/bank-accounts/{id}` · `PATCH /{id}/set-default`

### 1. Sắp xếp: mặc định trước
```java
.sorted(Comparator.comparing(UserBankAccountEntity::isDefault).reversed()
        .thenComparingLong(UserBankAccountEntity::getId))
```

### 2. Tài khoản đầu tiên tự động là mặc định
```java
boolean hasAny = bankAccountRepository.existsByUserId(userId);
... .isDefault(!hasAny)
```

### 3. ⚠️ Bài học SB-5145 — server phải tự resolve tên ngân hàng

**Sự cố:** `bank_name`/`bank_short_name` luôn `NULL` cho 6/13 bản ghi `source=APP` trên UAT.
**Nguyên nhân:** service copy 2 field này **thẳng từ request**, mà app **chỉ gửi `bankId`**. Validation không bắt vì 2 field không có `@NotBlank`.

**Fix:** server tự tra từ master-data (chính danh sách app dùng làm bank picker):
```java
private BankListItemResponse resolveBank(Integer bankId) {
    List<BankListItemResponse> banks = hrCacheService.getMasterData().getBanks();
    if (banks == null || banks.isEmpty()) {
        log.error("resolveBank failed: danh sách bank rỗng (master-data cache/hr-backend lỗi), bankId={}", bankId);
        throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                "Không lấy được danh sách ngân hàng, vui lòng thử lại sau");      // 🔑 502
    }
    return banks.stream().filter(b -> b.getId() != null && b.getId().equals(bankId)).findFirst()
            .orElseThrow(() -> {
                log.warn("resolveBank rejected: bankId={} không có trong master-data ({} bank)", bankId, banks.size());
                return new ResponseStatusException(HttpStatus.BAD_REQUEST, "Ngân hàng không hợp lệ");  // 🔑 400
            });
}
```

🔑 **Phân biệt 2 tình huống thay vì gộp làm một:**
| Tình huống | Status | Ý nghĩa cho client |
|---|---|---|
| Danh sách **rỗng** (cache/hr-backend lỗi) | **502** | Thử lại sau |
| Có danh sách, **không thấy bankId** | **400** | Client gửi sai, sửa đi |

Nếu gộp cả 2 thành 400 thì user bị chặn oan khi cache lỗi. Nếu gộp thành 502 thì client sai mà tưởng server hỏng.

**Hệ quả có chủ ý:** `bankId` giờ **được validate** — request với mã VietQR (vd `970436`) thay vì id master-data sẽ bị từ chối thay vì lưu âm thầm.
Và `bankName`/`bankShortName` bị **bỏ khỏi `BankAccountRequest`** — server sở hữu 2 giá trị này.

### 4. ⚠️ Bài học SB-5174 — chặn quá tay tạo ra bế tắc

**Sự cố:** user có **đúng 1** tài khoản không xoá được nó.
**Nguyên nhân:** `delete()` chặn **mọi** tài khoản `isDefault=true`, mà `create()` **luôn** set tài khoản đầu tiên làm mặc định ⇒ bế tắc vĩnh viễn.

```java
// SB-5174: chỉ chặn khi CÒN tài khoản khác — lúc đó mới có cái để đặt làm mặc định thay.
if (entity.isDefault() && bankAccountRepository.countByUserId(userId) > 1) {
    throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
            "Không được xóa tài khoản đang là mặc định. Vui lòng đặt tài khoản khác làm mặc định trước");
}
```
`countByUserId` được thêm mới vào repository. Short-circuit: `entity.isDefault()` false thì không đếm.

💡 **Bài học tổng quát:** khi viết ràng buộc "không được xoá X", luôn kiểm tra **trạng thái biên** — X có phải phần tử cuối cùng không? Có đường thoát không?

### 5. `setDefault()` — bỏ mặc định các tài khoản khác
```java
bankAccountRepository.findByUserId(userId).stream()
        .filter(a -> a.isDefault() && !a.getId().equals(id))
        .forEach(a -> { a.setDefault(false); bankAccountRepository.save(a); });
entity.setDefault(true);
```
⚠️ Không có ràng buộc DB nào đảm bảo "chỉ 1 default" — chỉ có code. Ràng buộc dạng "partial unique index" (`UNIQUE(user_id) WHERE is_default`) MariaDB không hỗ trợ.

---

## C. Agreement (`AgreementServiceImpl`) — Điều khoản & Chính sách

`GET /agreements/current` (public) · `GET /agreements/versions` (public) · `POST /agreements/versions` (**ADMIN**)
`GET /agreements/status` (JWT) · `POST /agreements/accept` (JWT)

### 1. Hai bảng

| Bảng | Nội dung |
|---|---|
| `t_agreement_version` | Master data 1 phiên bản: `version` (`MAJOR.MINOR`), `title`, `content`, `url`, `effective_date`, `is_current`, **`requires_reconsent`** |
| `t_user_agreement` | Bản ghi user chấp nhận: `user_id`, `agreement_version_id`, `accepted_version`, `accepted_at`, `ip_address`. **Append-only** (audit trail) |

```java
// Field đặt tên `current` (không phải `isCurrent`) để derived query Spring Data resolve rõ ràng property `current`.
@Column(name = "is_current", nullable = false)
private boolean current = false;
```
💡 Chi tiết Lombok/Spring Data: `boolean isCurrent` → getter `isCurrent()` → Spring Data suy property là `current`, dễ nhầm. Đặt tên field thẳng là `current` cho khớp.

### 2. 🔑 `requiresReconsent` — cơ chế "bắt ký lại"

Không phải version mới nào cũng bắt user ký lại. Chỉ khi bump **MAJOR** (đổi lớn ảnh hưởng quyền/nghĩa vụ hoặc mục đích xử lý dữ liệu cá nhân).

```java
/** Id của mốc "bắt ký lại" mới nhất. Null nếu chưa có bản nào. */
@Query("SELECT MAX(a.id) FROM AgreementVersionEntity a WHERE a.requiresReconsent = true")
Long findMaxReconsentVersionId();

/** User đã ký mốc bắt ký lại (baseline) hoặc bất kỳ bản nào MỚI HƠN chưa. */
boolean existsByUserIdAndAgreementVersionIdGreaterThanEqual(Long userId, Long agreementVersionId);
```

```java
public AgreementStatusResponse getStatus(Long userId) {
    Long baselineVersionId = versionRepository.findMaxReconsentVersionId();
    boolean needsAcceptance = baselineVersionId != null
            && !userAgreementRepository.existsByUserIdAndAgreementVersionIdGreaterThanEqual(userId, baselineVersionId);
    return AgreementStatusResponse.builder().needsAcceptance(needsAcceptance).build();
}
```

🔑 **Chỉ 2 query, cả 2 đều index-only** — không load nội dung điều khoản, không load `is_current`. API này được gọi **trong mỗi lần `GET /profile`** nên phải cực nhẹ.

🔑 **`>=` chứ không `=`**: user ký bản 3.0 (mới hơn baseline 2.0) thì coi như đã ký baseline. Không bắt ký lại bản cũ.

### 3. `createVersion()` — giữ bất biến "chỉ 1 current"
```java
@Transactional
public AgreementVersionResponse createVersion(CreateAgreementVersionRequest request) {
    if (!version.matches("^\\d+\\.\\d+$")) throw new ValidationException("Version phải theo định dạng MAJOR.MINOR, ví dụ 3.0");
    if (request.getRequiresReconsent() == null)
        throw new ValidationException("Phải chỉ định requiresReconsent (true=đổi lớn bắt ký lại, false=đổi nhỏ)");
    if (versionRepository.findByVersion(version).isPresent()) throw new ValidationException("Version đã tồn tại");

    versionRepository.clearCurrent();        // 🔑 UPDATE ... SET current=false WHERE current=true
    ... .current(true) ...
}
```
🔑 `clearCurrent()` + tạo bản mới trong **cùng transaction** → không bao giờ có 2 bản `is_current=true`, cũng không có khoảnh khắc 0 bản.
🔑 `requiresReconsent` **bắt buộc truyền tường minh** — không có default. Vì đây là quyết định pháp lý, người tạo phải chủ động chọn, không để hệ thống đoán.

### 4. `accept()` — idempotent + chỉ nhận bản hiện hành
```java
if (version != null && !version.equals(current.getVersion()))
    throw new ValidationException("Phiên bản điều khoản không hợp lệ hoặc đã lỗi thời — vui lòng chấp nhận phiên bản hiện hành " + current.getVersion());

if (userAgreementRepository.existsByUserIdAndAgreementVersionId(userId, current.getId())) {
    log.info("Agreement already accepted: userId={}, version={}", ...);
    return getStatus(userId);            // 🔑 idempotent, không tạo bản ghi trùng
}
```
Có cả UNIQUE `uq_user_agreement_version` ở DB làm lớp bảo vệ cuối.

### 5. `ip_address` — audit consent
Lấy từ `X-Forwarded-For` (service chạy sau Zuul gateway):
```java
private String extractClientIp(HttpServletRequest request) {
    String forwarded = request.getHeader("X-Forwarded-For");
    if (forwarded != null && !forwarded.trim().isEmpty()) return forwarded.split(",")[0].trim();
    return request.getRemoteAddr();
}
```
💡 `X-Forwarded-For` có thể là chuỗi `client, proxy1, proxy2` → lấy phần tử **đầu tiên**.
⚠️ Header này client tự đặt được → không dùng để phân quyền, chỉ dùng làm audit.

## Đi tiếp

→ [`08-module-cache-masterdata.md`](08-module-cache-masterdata.md)
