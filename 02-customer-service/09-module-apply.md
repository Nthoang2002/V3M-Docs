# customer-service — Module Apply (ứng tuyển việc làm)

Class: `service/apply/impl/ApplyServiceImpl.java` (214 dòng) · `controller/apply/ApplyController.java` (130)
Bảng: `t_apply`

---

## 1. Hai endpoint

| Method | Path | Mô tả |
|---|---|---|
| POST | `/applies` | Ứng tuyển 1 vị trí — **đồng bộ**, gọi thẳng hr-backend trong request |
| GET | `/applies` | Danh sách hồ sơ đã ứng tuyển của user (theo `app_user_id`) |

---

## 2. 🔑 SB-4863 — Đổi từ BẤT ĐỒNG BỘ sang ĐỒNG BỘ (đi ngược "best practice" một cách có lý)

### Trước (bất đồng bộ)
```
POST /applies → lưu t_apply status=PENDING → trả 200 "đã nhận"
                     ↓ (job nền)
                ApplySyncJob retry gọi hr-backend
                     ↓ thất bại 3 lần → status=FAILED
```

### Sau (đồng bộ — bản hiện tại)
```java
public ApplyResponse apply(UUID customerId, Long appUserId, String creatorPhone, ApplyRequest request) {
    // SB-4863: apply đồng bộ (real-time) — gọi thẳng hr-backend ngay trong request thay vì lưu
    // PENDING cho job nền retry. Lỗi validation từ hr-backend trả THẲNG cho user (không nuốt âm thầm
    // rồi FAILED sau vài lần retry như luồng cũ). KHÔNG bọc @Transactional quanh cả method vì có lời
    // gọi HTTP ra ngoài ở giữa — tránh giữ transaction DB mở suốt thời gian chờ hr-backend.
```

### 🔑 Vì sao đảo ngược?
Nghiệp vụ **ứng tuyển** cần **phản hồi tức thì**: hr-backend từ chối (thiếu field, sai định dạng, đã ứng tuyển rồi) thì user phải biết **ngay** để sửa. Với luồng cũ, user thấy "thành công" rồi 5 phút sau hồ sơ âm thầm `FAILED` — không ai báo.

💡 **Bài học:** "bất đồng bộ để chịu tải" chỉ đúng khi **user không cần biết kết quả ngay**. Ứng tuyển không thuộc loại đó.

### 🔑 `@Transactional` KHÔNG bọc cả method
Có `hrBackendClient.createProfile()` (HTTP) ở giữa. Bọc transaction quanh nó = **giữ connection DB mở suốt thời gian chờ mạng** → cạn connection pool khi hr-backend chậm.
→ Chỉ `applyRepository.save(entity)` chạy trong transaction ngầm của Spring Data.

### Lưu cả bản ghi thất bại
```java
} else {
    // Lưu bản ghi FAILED làm audit/đối soát (không rollback) rồi trả message hr-backend cho user.
    entity.setSyncStatus(SyncStatus.FAILED);
    entity.setFailureReason(result.getFailureReason());
    entity = applyRepository.save(entity);
    log.warn("apply failed id={} appUserId={} recruitmentId={} reason={}", ...);
}
```
Controller đọc `syncStatus` để quyết định status HTTP:
```java
if (response.getSyncStatus() == SyncStatus.FAILED) {
    return ResponseEntity.badRequest().body(ApiResponse.error(response.getFailureReason()));
}
```

---

## 3. `t_apply` — bảng và ý nghĩa từng cột

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `user_id` | VARCHAR(36) NOT NULL | ⚠️ Lịch sử lưu `customerId`. Nay fallback `appUserId.toString()` khi chưa liên kết CDP (để không phải sửa schema) |
| **`app_user_id`** | BIGINT | 🔑 `t_user.id` — **khoá tra cứu chính thức** (luôn có, không phụ thuộc CDP) |
| **`referral_id`** | BIGINT | 🔑 `t_user.id` của **NGƯỜI GIỚI THIỆU** — khoá tính hoa hồng CTV |
| `creator_phone` | VARCHAR(20) | SĐT người tạo hồ sơ, gửi sang hr-backend → `AppProfile.AppUserPhone` |
| `recruitment_id` | INT NOT NULL | Vị trí tuyển dụng |
| `hr_profile_id` | BIGINT | `AppProfile.Id` bên CRM — có khi `SYNCED` |
| `sync_status` | ENUM | `PENDING` / `SYNCED` / `FAILED` |
| `retry_count` | INT | (di sản của luồng cũ, giờ luôn 0) |
| `payload` | TEXT | JSON request gốc — audit/replay |
| `failure_reason` | TEXT | Message lỗi từ hr-backend |

### 🔑 Phân biệt `app_user_id` và `referral_id`
Javadoc entity ghi rõ:
> *"Khác `appUserId` (người **TẠO** hồ sơ): NLD tự ứng tuyển thì `appUserId` chính là ứng viên, nên nhìn `appUserId` **không phân biệt được** tự ứng tuyển với được CTV giới thiệu."*

| | `app_user_id` | `referral_id` |
|---|---|---|
| Ai | Người **bấm nút** ứng tuyển | Người **giới thiệu** |
| NLD tự ứng tuyển | = chính ứng viên | `null` |
| CTV tạo hộ | = CTV | = CTV |
| NLD nhập mã CTV | = NLD | = chủ mã |

### 🔑 Vì sao `creator_phone` tồn tại
Comment trong entity:
> *"gửi kèm AppUserId header sang hr-backend để lưu vào `AppProfile.AppUserPhone`, phục vụ tra cứu (**`AbpUsers` chỉ dành cho user CRM, không map được cho ứng viên tự ứng tuyển qua app**)"*

Tức: bên CRM, người tạo hồ sơ bình thường là 1 `AbpUsers` (nhân viên). Ứng viên app **không có** `AbpUsers` → phải lưu SĐT để tra ngược.

---

## 4. 🔑 `resolveReferralId()` — thứ tự kiểm tra quyết định ĐÚNG/SAI về tiền

```java
private Long resolveReferralId(ApplyRequest request, Long appUserId) {
    String code = request.getReferralCode();

    // ⚠️ THỨ TỰ QUAN TRỌNG: xét MÃ TRƯỚC, cờ applyYourself SAU
    if (code == null || code.trim().isEmpty()) {
        return Boolean.FALSE.equals(request.getApplyYourself()) ? appUserId : null;
    }

    List<Long> ids = userRepository.findIdsByEmployeeCodeOrPhone(code.trim());
    if (ids.isEmpty()) {
        log.warn("Mã giới thiệu không tồn tại: referralCode={}, appUserId={}", mask(code.trim()), appUserId);
        throw new ValidationException("Mã giới thiệu không đúng, vui lòng kiểm tra lại");        // 🔑 400
    }
    if (ids.size() > 1) {
        // Không tự chọn 1 trong nhiều user: đây là khoá tính hoa hồng, đoán sai là sai tiền.
        log.error("Mã giới thiệu khớp {} user: referralCode={}, appUserId={}", ids.size(), mask(...), appUserId);
        throw new ValidationException("Mã giới thiệu trùng nhiều tài khoản, vui lòng liên hệ hỗ trợ");
    }
    return ids.get(0);
}
```

### ⚠️ Bẫy "thứ tự kiểm tra" — bug tiền tự ăn hoa hồng của chính mình

Comment trong code giải thích rất rõ:
> *"**Không được xét `applyYourself` trước**: `ApplyController` **tự suy ra** cờ này TỪ SỰ CÓ MẶT của `referralCode` (có mã → false), nên xét trước thì NLD tự ứng tuyển có nhập mã sẽ thành người giới thiệu của **chính mình** → **tự ăn hoa hồng**."*

Ở controller:
```java
// Tự suy ra applyYourself: không có referralCode → NLD tự ứng tuyển
if (request.getApplyYourself() == null) {
    request.setApplyYourself(request.getReferralCode() == null || request.getReferralCode().isBlank());
}
```

Nếu `resolveReferralId` xét `applyYourself` trước:
```
NLD tự ứng tuyển + nhập mã "CTV001"
  → controller auto-fill applyYourself = false (vì CÓ mã)
  → resolveReferralId thấy applyYourself=false → referralId = appUserId (chính NLD)
  → NLD tự ăn hoa hồng ❌
```
Xét mã trước thì `referralId` = chủ mã `CTV001` ✅.

Và ở nhánh **không có mã**, `applyYourself` chắc chắn được auto-fill = `true`, nên giá trị `false` ở đó **chắc chắn do client gửi thật** (CTV tạo hộ hồ sơ).

### 🔑 Không tin client về "ai là người giới thiệu"
> *"người giới thiệu = chính người đang gọi API, lấy `appUserId` từ **JWT**. KHÔNG nhận id do client gửi lên — tin client thì ai cũng tự khai mình là người giới thiệu của mọi hồ sơ để nhận hoa hồng."*

### 🔑 Mã sai → CHẶN 400, và chặn TRƯỚC khi gọi hr-backend
> *"Cố tình không cho qua âm thầm: mã sai mà vẫn tạo hồ sơ thì hoa hồng sẽ **mất hẳn người nhận**, và tới lúc phát hiện thì hồ sơ đã sang CRM, **sửa lại phải làm tay**. Người dùng nhập sai 1 ký tự thì báo ngay còn dễ sửa. Vì vậy hàm này phải được gọi **TRƯỚC** khi gọi hr-backend."*

```java
Long referralId = resolveReferralId(request, appUserId);   // ← dòng đầu tiên của apply()
...
ProfileCreateResult result = hrBackendClient.createProfile(...);   // ← sau
```
💡 **Nguyên tắc:** với thao tác **không rollback được qua HTTP**, mọi validate phải xong trước khi gọi.

### 🔑 Khớp `employee_code` HOẶC SĐT
```java
@Query("SELECT u.id FROM UserEntity u WHERE u.employeeCode = :code OR u.phone = :code")
List<Long> findIdsByEmployeeCodeOrPhone(@Param("code") String code);
```
Javadoc repository:
> *"Trả `List` thay vì `Optional` một cách CÓ Ý: `employee_code` hiện unique nhưng **DB không có ràng buộc UNIQUE**, và 1 mã vẫn có thể trùng SĐT của user khác. **Caller phải tự xử lý ca khớp nhiều dòng (bỏ qua, không đoán)** vì đây là khoá dùng để tính hoa hồng — gán sai là sai tiền."*

💡 Đây là **thiết kế API phòng thủ**: kiểu trả về (`List` vs `Optional`) **ép caller** phải xử lý trường hợp nhiều kết quả.

---

## 5. Phân bổ sale phụ trách (SB-4471)

```java
// Hồ sơ được phân bổ về sale phụ trách NGƯỜI GIỚI THIỆU — giữ đúng hành vi app v1
// ("Tự động phân bổ về agent seeding"), chỉ khác nguồn: v1 đọc AbpUsers.AgentSupport của CTV,
// v2 đọc t_user.agent_support vì CTV không có tài khoản CRM.
Long agentSupportUserId = referralId == null
        ? null
        : userRepository.findAgentSupportById(referralId).orElse(null);
...
hr.setAgentSupportUserId(agentSupportUserId);
```

Chuỗi: `referralCode` → `referralId` (t_user.id người giới thiệu) → `agent_support` (AbpUsers.Id sale) → gửi sang hr-backend.
hr-backend có `CheckAgentSupportEligible()` dùng **chung cho v1/v2** (sale active, role Operator/Collaborator_Care, thuộc nhóm chiến dịch) nên điều kiện không thể lệch giữa 2 app.

---

## 6. `ApplyController` — auto-fill từ `t_user`

Trước khi gọi service, controller điền các field client không gửi:
```java
if (request.getPhoneNumber() == null || blank)   request.setPhoneNumber(user.getPhone());
if (request.getFullName()    == null || blank)   request.setFullName(user.getFullName());
if (request.getEmail() == null && user.getEmail() != null)              request.setEmail(...);
if (request.getIdentification() == null && user.getNationalId() != null) request.setIdentification(...);
if (request.getIdentificationDate() == null && user.getIssueDate() != null)
    request.setIdentificationDate(user.getIssueDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli());
if (request.getIdentificationAddress() == null && user.getIssuePlace() != null) ...
if (request.getAddress() == null && user.getAddress() != null) ...
if (request.getGenderId() == null && user.getGender() != null) request.setGenderId(user.getGender());

// Auto-fill campaignId từ recruitment cache
if (request.getCampaignId() == null) {
    hrCacheService.getAllRecruitments().stream()
            .filter(r -> request.getRecruitmentId().equals(r.getId()))
            .findFirst().map(HrRecruitmentItem::getCampaignId).ifPresent(request::setCampaignId);
}

// hr-backend giới hạn cứng 20 ký tự
if (request.getReferralCode() != null && request.getReferralCode().length() > 20)
    return 400 "Mã giới thiệu không được quá 20 ký tự";
```

🔑 Sau SB-4257, `t_user.gender` **lưu trực tiếp id master-data CRM** (7/8/9) → dùng thẳng làm `genderId`, không phải dịch.
💡 Auto-fill giúp app chỉ cần gửi `recruitmentId` + field khác biệt, không phải gửi lại toàn bộ hồ sơ mỗi lần.

⚠️ Auto-fill nằm ở **controller** chứ không phải service — hơi lệch chuẩn phân tầng, nhưng dễ theo dõi vì nó thuần "chuẩn bị input".

---

## 7. `buildHrRequest()` — map sang contract của hr-backend

```java
SimpleDateFormat sdf = new SimpleDateFormat("dd/MM/yyyy");
if (req.getBirthday() != null) hr.setBirthday(sdf.format(new Date(req.getBirthday())));
```
🔑 App gửi **epoch millis** (`Long`), hr-backend nhận **chuỗi `dd/MM/yyyy`**. Chuyển đổi ở đúng 1 chỗ.

```java
// app gửi isMarried (boolean); hr-backend field Married nhận "true"/"false" trong allow-list
hr.setMarried(isMarried == null ? null : isMarried.toString());
```

Nhóm field gửi sang: cơ bản (tên/SĐT/email/gender/birthday), địa chỉ, CCCD, cá nhân (married/ethnic/height/weight/medicalHistory), CV (literacy/experience/language/training/skill), tuyển dụng (recruitmentId/campaignId/referralCode/referrerName/applyYourself/agentSupportUserId).

---

## 8. `listByUser()` — tra theo `app_user_id`

```java
// SB-4863: appUserId (t_user.id) là khoá tra cứu chính thức — luôn có sẵn, không phụ thuộc CDP
List<ApplyEntity> findByAppUserIdOrderByCreatedAtDesc(Long appUserId);
```

## 9. Truy vấn cho hoa hồng CTV

```java
/**
 * SB-4471: id hồ sơ bên CRM (AppProfile.Id) của mọi ứng tuyển do 1 người giới thiệu — chính là
 * "phạm vi hoa hồng" của CTV đó, gửi sang hr-backend để lấy số tiền.
 * Lọc hrProfileId IS NOT NULL vì bản ghi FAILED chưa có hồ sơ bên CRM nên không thể phát sinh hoa hồng.
 * Chỉ SELECT id: không nạp entity, tránh kéo cột payload (TEXT) về chỉ để lấy 1 số.
 */
@Query("SELECT a.hrProfileId FROM ApplyEntity a WHERE a.referralId = :referralId AND a.hrProfileId IS NOT NULL")
List<Long> findHrProfileIdsByReferralId(@Param("referralId") Long referralId);
```
🔑 **`SELECT a.hrProfileId`** (projection) chứ không `SELECT a` — cột `payload` là `TEXT`, kéo về hàng trăm dòng chỉ để lấy 1 số là lãng phí băng thông DB.
→ Dùng ở [14](14-module-reward-incentive.md).

## 10. Đi tiếp

→ [`10-module-timekeeping.md`](10-module-timekeeping.md)
