# customer-service (app-customer-service) — Tổng quan

| | |
|---|---|
| **Repo** | `customer-service/` |
| **Base package** | `com.ttt.v3m.app.customer` |
| **Tên đăng ký Eureka** | `APP-CUSTOMER-SERVICE` (application.id = 32) |
| **DB** | MariaDB `app-customer` (~35 bảng) + Redis |
| **Quy mô** | 380 class main / ~21.000 dòng · ~600 unit test · 60 migration |

Đây là **backend chính của app Viec3Mien v2**. Mọi thứ người dùng thấy trên app đều đi qua service này.

---

## 1. Mười hai module nghiệp vụ

| Module | Package | Nội dung | Doc |
|---|---|---|---|
| **auth** | `service/auth` | Đăng nhập (bằng **phone**), đăng ký OTP, refresh token, quên/đổi mật khẩu | [05](05-module-auth.md) |
| **kyc** | `service/auth` (KycServiceImpl) | OCR CCCD + đối chiếu khuôn mặt (EKYC AI Mobifi) | [06](06-module-kyc.md) |
| **profile / bank / agreement** | `service/auth`, `service/agreement` | Hồ sơ cá nhân, tài khoản ngân hàng, điều khoản & chính sách | [07](07-module-profile-bank-agreement.md) |
| **cache** | `service/cache`, `service/news`, `service/recruitment` | Master data + việc làm + công ty + tin tức (mirror từ CRM) | [08](08-module-cache-masterdata.md) |
| **apply** | `service/apply` | Ứng tuyển việc làm (đồng bộ sang CRM), người giới thiệu | [09](09-module-apply.md) |
| **timekeeping** | `service/timekeeping`, `service/worker` | Chấm công: GPS đa giác, nhận diện khuôn mặt, JobStatus | [10](10-module-timekeeping.md) |
| **rule/config** | `service/rule/config` | Admin CRUD nhiệm vụ (earn rule) với biểu thức AND/OR | [11](11-module-rule-config.md) |
| **rule/engine** | `service/rule/engine` | Tính điểm: nhận event → cộng tiến độ → thưởng điểm | [12](12-module-rule-engine.md) |
| **gift** | `service/gift` | Catalog quà Urbox, đổi điểm lấy voucher | [13](13-module-gift-urbox.md) |
| **reward / incentive** | `service/reward`, `service/incentive` | Thưởng (tiền) & hoa hồng CTV — **proxy có hàng rào** | [14](14-module-reward-incentive.md) |
| **notification** | `service/notification` | Inbox trong app + FCM push | [15](15-module-notification-fcm.md) |
| **ctv** | `service/ctv` | Trở thành cộng tác viên, ký hợp đồng PDF | [16](16-module-ctv.md) |
| *(+ admin)* | `service/admin` | Tra cứu giao dịch điểm/quà cho CRM | [17](17-module-admin.md) |

---

## 2. 🔑 Ba định danh — bảng phân biệt QUAN TRỌNG NHẤT

Nhầm 3 cái này là hiểu sai cả hệ thống.

| Định danh | Kiểu | Nguồn | Dùng cho |
|---|---|---|---|
| **`userId`** | `Long` | `t_user.id` — customer-service tự sinh | 🔑 **Định danh nghiệp vụ chính**. Trong JWT, mọi controller lấy qua `@RequestAttribute("userId")` |
| **`customerId`** | `UUID` | CDP (`customer_identity`) | **Chỉ để tra cứu + bắn Kafka event sang CDP**. Có thể `null` (chưa liên kết) |
| **`profileId`** | `Long` | `AppProfile.Id` bên hr-backend (CRM) | Khoá đọc **thưởng/hoa hồng/vị trí chấm công** từ CRM |

### Lịch sử tiến hoá (rất hay bị hỏi)

```
Ban đầu:  app  →  customerId  →  hr-backend      (CDP tham gia nghiệp vụ)
SB-5043:  app  →  userId → profileId → hr-backend (CDP RA KHỎI nghiệp vụ)
```
**SB-5043** đổi khoá map thưởng/chấm công từ `customerId` sang `profileId`, resolve qua `IWorkerProfileService` (cache dùng chung).
Hệ quả bảo mật: hr-backend **bỏ kiểm tra** `profile ↔ customer` ở nhóm endpoint `*ByProfileId`
⇒ **customer-service phải tự gác sở hữu** (`ownsProfile` → 403). Xem [14](14-module-reward-incentive.md).

---

## 3. Bốn "hình thái" của service này

Đọc code sẽ thấy customer-service đóng cùng lúc 4 vai:

| Vai | Ví dụ |
|---|---|
| **REST API server** cho app | `/auth/login`, `/missions`, `/timekeeping/check` |
| **Proxy có kiểm soát** sang CRM | `/rewards/*`, `/incentives/*` — không tự tính, chỉ gọi hr-backend rồi gác quyền |
| **Kafka producer + consumer** | publish `ATTENDANCE` lên `cdp-behavior-topic`; consume `cdp-behavior-saved`, `rule-events`, `hr-timekeeping-sync` |
| **Batch/Job runner** | 8 Quartz job đồng bộ cache & backfill |

---

## 4. Convention bắt buộc của repo (từ `CLAUDE.md`)

| Chủ đề | Quy tắc |
|---|---|
| **Cấu hình** | ❌ Không hardcode URL/key/timeout. Tất cả qua `@Value` hoặc `@ConfigurationProperties`, key kebab-case |
| **Logging** | `log.error` phải kèm `DebuggingDTO.build(e)`. **Không log PII thô** (SĐT/CCCD/tên) — phải mask |
| **Metric** | 🔑 **Mọi lời gọi 3rd party** + mọi luồng ảnh hưởng tiền/điểm **bắt buộc** có `Counter` (tag `result=success\|fail`) + `Timer` qua Micrometer |
| **Test** | Mỗi class production → 1 class test, `{ClassName}Test`, method `{method}_{scenario}_{expected}` |
| **Swagger** | Mọi controller `@Api(tags=...)`, mọi endpoint `@ApiOperation`, mọi param `@ApiParam`. Không trả `Object`/`Map` thô |
| **Comment** | Giải thích **tại sao**, không phải **làm gì**. Không để comment cũ sai. Không comment-out code |
| **Folder** | Mỗi sub-domain phải đủ 4 chỗ: `entities/`, `repositories/`, `service/{d}/iface/`, `service/{d}/impl/` |
| **Migration** | `db/migration/V{n}__{action}_{table}.sql`, **chạy TAY** (không Flyway), không sửa file cũ |
| **Git** | Mỗi ticket = 1 nhánh = **1 commit duy nhất** (code + doc + test). Không commit thẳng `master` |

---

## 5. Sơ đồ tầng (layer) chuẩn của 1 request

```
HTTP request
   │
   ▼
[JwtAuthFilter]  ── validate JWT → set SecurityContext + request.setAttribute("userId", ...)
   │
   ▼
[SecurityConfig] ── permitAll / hasRole(ADMIN) / authenticated
   │
   ▼
Controller ──── @RequestAttribute("userId") Long userId
   │            (chỉ: nhận request, gọi service, bọc ApiResponse)
   ▼
Service (iface → impl) ──── nghiệp vụ, @Transactional, metric, log
   │
   ├─→ Repository (Spring Data JPA) ──→ MariaDB
   ├─→ Feign Proxy ─────────────────→ hr-backend / CDP / Urbox / EKYC
   ├─→ StringRedisTemplate ─────────→ Redis
   ├─→ KafkaTemplate ───────────────→ Kafka
   └─→ StorageService ──────────────→ S3
   │
   ▼
GlobalExceptionHandler (nếu ném exception) → ApiResponse.error + HTTP status đúng
```

---

## 6. Điểm yếu đã biết (nói được là điểm cộng)

| Vấn đề | Chi tiết |
|---|---|
| `/admin/**` nằm trong `PUBLIC_URLS` | ⚠️ Prefix này **permitAll**. Nên các endpoint admin thật phải đặt ở path khác (`/gift-redemptions/**`, `/users/**`) rồi `hasRole("ADMIN")`. Đọc kỹ [03](03-security-jwt.md). |
| `/actuator/**` public | Prometheus scrape nội bộ được, nhưng phải chắc gateway không route ra ngoài |
| Migration chạy tay | Quên chạy = app lỗi khi query cột chưa có |
| `testFailureIgnore=true` | CI build image kể cả khi test đỏ |
| Không có DLQ cho Kafka consumer | Lỗi vĩnh viễn ở `processEvent` sẽ retry mãi |
| Rule engine dùng `existsByUserIdAndEarnRuleId` để gate | Chưa enroll = event bị bỏ, không có dấu vết |

---

## 7. Đi tiếp

→ [`01-cau-truc-package.md`](01-cau-truc-package.md)
