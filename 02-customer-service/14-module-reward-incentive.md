# customer-service — Reward (thưởng tiền) & Incentive (hoa hồng CTV)

🔑 **Cả 2 module này customer-service KHÔNG tính con số nào.** Toàn bộ nằm ở CRM (hr-backend).
Vai trò của customer-service: **proxy có hàng rào** — resolve định danh + gác quyền + đo metric.

---

# A. Reward — thưởng (tiền)

## 1. Bảng endpoint (`RewardController`, base `/rewards`)

| Method | Path | Param | Trả về |
|---|---|---|---|
| GET | `/rewards/all` | — (chỉ JWT) | Tổng thưởng mọi hồ sơ |
| GET | `/rewards/mc-bonus` | `profileId` | Thưởng hoàn thành tháng |
| GET | `/rewards/spot-bonus` | `profileId` | Thưởng nóng |
| GET | `/rewards/attendance-bonus` | `profileId` | Thưởng **chấm công** |
| GET | `/rewards/actual-work-bonus` | `profileId` | Thưởng **công thực tế** |
| GET | `/rewards/types` | `profileId` | Tổng theo loại hình |

### ⚠️ Phân biệt 2 loại thưởng tên na ná (SB-4531)

| | `/attendance-bonus` | `/actual-work-bonus` |
|---|---|---|
| Loại hình CRM | `LOAIHINH_CHAM_CONG_APP` | `LOAIHINH_THUONG_CONG_THUC_TE` |
| Bảng nguồn | `ChiPhi_DoiSoatThuong_HoSo` | `ActualWorkBonusReconciliationResults` |
| Quan hệ | **2 loại RIÊNG BIỆT, cộng riêng vào tổng — không loại nào bao loại nào** | |

Javadoc trong `RewardService` cảnh báo rõ: *"**KHÁC** `getAttendanceBonus` … dù tên na ná"*.

---

## 2. 🔑 SB-5043 — đổi khoá map và hệ quả bảo mật

### Trước
```
app → customerId (CDP) → hr-backend CsReward/*ByCustomerId
                          └─ hr-backend TỰ kiểm tra profile ↔ customer (ProfileBelongsToCustomerAsync)
```

### Sau
```
app → userId (JWT) → IWorkerProfileService → profileIds → hr-backend CsReward/*ByProfileId
                                                           └─ hr-backend KHÔNG kiểm tra gì
       └────────── customer-service TỰ GÁC (ownsProfile → 403) ──────────┘
```

Javadoc interface `RewardService`:
> *"**Sở hữu:** hr-backend không kiểm tra profile ↔ customer ở nhóm endpoint `*ByProfileId`, nên mọi hàm nhận `profileId` phải tự gác qua `IWorkerProfileService.ownsProfile` — không thuộc thì **403**."*

### 🔑🔑 `requireOwnedProfile()` — chống IDOR

```java
/**
 * SB-5043: hàng rào sở hữu — profileId do CLIENT truyền nên phải kiểm tra thuộc user.
 *
 * Trước SB-5043 việc này do hr-backend làm (ProfileBelongsToCustomerAsync dựa trên customerId).
 * Bỏ customerId là THÁO HÀNG RÀO ĐÓ, nên customer-service phải tự gác:
 * profileId là SỐ NGUYÊN TUẦN TỰ, DỄ ĐOÁN, và dữ liệu phía sau là THU NHẬP của worker.
 *
 * Trả 403 (không phải 404) cho mọi trường hợp không thuộc — không tiết lộ profileId nào tồn tại.
 */
private void requireOwnedProfile(Long userId, Long profileId, String method) {
    if (!workerProfileService.ownsProfile(userId, profileId)) {
        log.warn("{} rejected: profileId={} không thuộc userId={}", method, profileId, userId);
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Hồ sơ không thuộc tài khoản này");
    }
}
```

💡 **Bài học lớn nhất của module này:** *bỏ một thứ ở hệ thống A có thể làm mất lá chắn bảo mật ở hệ thống B.*
`customerId` trông chỉ là "1 tham số dư thừa", nhưng nó chính là thứ hr-backend dùng để kiểm tra sở hữu. Bỏ nó đi mà không bù lại = mở **IDOR** trên dữ liệu thu nhập.

**IDOR** (Insecure Direct Object Reference): đổi `?profileId=1234` thành `1235` để xem dữ liệu người khác. `profileId` là số **tuần tự** nên đoán rất dễ.

---

## 3. Khuôn chung của 5 endpoint chi tiết

```java
public McBonusResponse getMcBonus(Long userId, Long profileId) {
    // (1) validate cơ bản
    if (profileId == null || profileId < 1)
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "profileId không hợp lệ");

    // (2) 🔑 HÀNG RÀO SỞ HỮU
    requireOwnedProfile(userId, profileId, "getMcBonus");

    // (3) đo metric (BẮT BUỘC — gọi 3rd party)
    Timer.Sample sample = Timer.start(meterRegistry);
    String result = "success";
    try {
        McBonusResponse data = hrBackendClient.fetchMcBonusByProfileId(profileId);
        if (data == null) { result = "fail"; throw new ResponseStatusException(BAD_GATEWAY, "..."); }

        // (4) 🔑 chuẩn hoá null → empty (client không phải check null)
        if (data.getBonusRounds() == null) data.setBonusRounds(Collections.emptyList());

        log.info("getMcBonus ok: userId={}, profileId={}, roundCount={}", ...);
        return data;
    } catch (ResponseStatusException e) {
        result = metricResult(e);                    // 🔑 4xx ≠ fail
        throw e;
    } catch (Exception e) {
        result = "fail";
        log.error("getMcBonus failed: userId={}, profileId={}, debug={}", ...);
        throw new ResponseStatusException(BAD_GATEWAY, "Không lấy được thông tin thưởng hoàn thành tháng, vui lòng thử lại sau");
    } finally {
        sample.stop(Timer.builder("reward.mc_bonus").tag("result", result).register(meterRegistry));
    }
}
```

### 🔑 `metricResult()` — tách lỗi client khỏi lỗi hạ tầng
```java
/** 4xx (ownership / validation) ≠ hạ tầng — alert chỉ trên result=fail. */
static String metricResult(ResponseStatusException e) {
    return e.getStatus().is4xxClientError() ? "client_error" : "fail";
}
```
💡 Không có dòng này thì mỗi lần user gọi sai `profileId` sẽ tăng `result=fail` → alert kêu oan.

### 🔑 `Timer` đủ thay cho `Counter`
```java
// Timer exposes both latency + count (reward_all_seconds_count) — đủ cho Counter convention
```
Micrometer `Timer` xuất cả `_count`, `_sum`, `_max` → không cần thêm `Counter` riêng.

### 🔑 Chuẩn hoá null → empty
```java
if (data.getListProfileTotal() == null) data.setListProfileTotal(Collections.emptyList());
if (data.getTotalAmountBonus()  == null) data.setTotalAmountBonus(0.0);
```
Trả `[]` thay `null`, `0.0` thay `null` → app không phải null-check, giảm crash phía client.

### `getAllRewards()` — không có hồ sơ ≠ lỗi
```java
List<Long> profileIds = workerProfileService.getProfileIds(userId);
if (profileIds.isEmpty()) {
    log.info("getAllRewards: no profile for userId={}, returning zero total", userId);
    return emptyTotal();                  // 🔑 tổng 0 + list rỗng, HTTP 200
}
```
⚠️ **Thay đổi hành vi** so với trước SB-5043: bỏ 400 *"Tài khoản chưa được liên kết"*. `CHANGELOG` ghi: *"chỉ 6/3324 user = 0,2%"* — con số này là căn cứ để đổi.

---

# B. Incentive — hoa hồng CTV (SB-4471)

## 4. Bảng endpoint (`IncentiveController`)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/incentives/chart?year=` | Biểu đồ hoa hồng ĐÃ CHI theo tháng |
| GET | `/incentives/total?year=&month=` | Tổng tách theo trạng thái chi trả |
| GET | `/incentives?year=&month=&paymentIds=&orderBy=&page=&size=` | Danh sách từng khoản |
| GET | `/incentives/statuses` | Danh mục trạng thái (1=Tạm tính, 2=Chờ chi, 3=Đã chi) |

## 5. 🔑 Khác biệt cốt lõi v1 vs v2

Javadoc `IncentiveService`:
> *"Khác app v1 ở chỗ xác định **"hoa hồng của ai"**: v1 coi CTV là user CRM và lọc theo `CollaboratorId = AbpUsers.Id`; v2 thì CTV chỉ là 1 user của customer-service, **không có tài khoản CRM**. Quan hệ "ai giới thiệu ai" nằm hoàn toàn ở `t_apply.referral_id`, nên service này tự resolve `userId` → danh sách `hr_profile_id` rồi hỏi hr-backend số tiền theo danh sách đó."*

```
userId (JWT)
   → t_apply WHERE referral_id = userId AND hr_profile_id IS NOT NULL
   → List<hrProfileId>  ("phạm vi hoa hồng")
   → hr-backend CsCollaboratorIncentive/*ByProfileIds
```

### ⚠️ Hệ quả bảo mật — KHÔNG nhận `profileIds` từ client
```java
/**
 * Lấy từ JWT userId chứ KHÔNG nhận danh sách từ client — hr-backend TIN TUYỆT ĐỐI danh sách này
 * (S2S api-key, không kiểm tra sở hữu), nên nhận từ client là mở đường xem hoa hồng người khác.
 */
private List<Long> referredProfileIds(Long userId) {
    List<Long> profileIds = applyRepository.findHrProfileIdsByReferralId(userId);
    if (profileIds.isEmpty()) log.debug("Chưa có hồ sơ giới thiệu nào: userId={}", userId);
    return profileIds;
}
```
Comment ở `IncentiveController` nhắc lại:
> *"**KHÔNG endpoint nào** nhận danh sách hồ sơ từ client: phạm vi hoa hồng luôn được dựng server-side từ `userId` trong JWT."*

🔑 **Nguyên tắc**: khi hệ thống downstream tin tuyệt đối input của bạn, bạn **trở thành** biên bảo mật. Mọi thứ quyết định phạm vi dữ liệu phải dựng từ danh tính đã xác thực, không bao giờ từ request body.

### Chưa giới thiệu ai → trả rỗng, KHÔNG gọi hr-backend
```java
List<Long> profileIds = referredProfileIds(userId);
if (profileIds.isEmpty()) return Collections.emptyList();
```
🔑 Tiết kiệm 1 lời gọi mạng cho CTV mới (rất nhiều).

---

## 6. `measured()` — gom metric + xử lý null vào 1 chỗ

```java
/**
 * Đo thời gian + kết quả mỗi lời gọi hr-backend (BẮT BUỘC với luồng gọi 3rd party), rồi quy
 * null về 502 tại MỘT CHỖ DUY NHẤT thay vì lặp ở từng method.
 */
private <T> T measured(String metric, Long userId, Supplier<T> call) {
    Timer.Sample sample = Timer.start(meterRegistry);
    String result = "success";
    try {
        T data = call.get();
        if (data == null) {
            result = "fail";
            log.error("Lấy hoa hồng thất bại: metric={}, userId={}", metric, userId);
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, UPSTREAM_ERROR);
        }
        return data;
    } finally {
        sample.stop(Timer.builder(metric).tag("result", result).register(meterRegistry));
    }
}
```
Dùng:
```java
return measured("incentive.chart", userId, () -> hrBackendClient.fetchIncentiveChart(profileIds, year));
```
💡 So sánh với `RewardServiceImpl` (lặp khuôn try/catch/finally 5 lần) — `IncentiveServiceImpl` gọn hơn nhiều nhờ generic + `Supplier`. Cùng ý tưởng, cách viết khác nhau vì `RewardService` còn phải chuẩn hoá null của từng DTO khác nhau.

---

## 7. Bảng metric của 2 module

| Metric | Tag | Ở đâu |
|---|---|---|
| `reward.all` | `result` | `getAllRewards` |
| `reward.mc_bonus` | `result` | |
| `reward.spot_bonus` | `result` | |
| `reward.attendance_bonus` | `result` | |
| `reward.actual_work_bonus` | `result` | |
| `reward.list_type` | `result` | |
| `incentive.chart` / `.total` / `.list` / `.status` | `result` | `measured()` |
| `worker.profile_list` | `result` = `success`\|`not_found`\|`fail` | `WorkerProfileServiceImpl` |
| `cdp.resolve` | `result` | `CdpCustomerServiceImpl` |
| `mission.auto_enroll` | `source`, `result` | `MissionEnrollmentService` |
| `timekeeping.gps_validation` | `result` = `pass`\|`fail`\|`skipped` | `TimekeepServiceImpl` |
| `timekeeping.evident_image_upload` | `result` | |
| `notification.crm_role` | `result` | `CrmRoleNotificationController` |

Tất cả đọc qua `/actuator/prometheus`.

## 8. Đi tiếp

→ [`15-module-notification-fcm.md`](15-module-notification-fcm.md)
