# Docs source code V3M — tài liệu học & ôn tập

Bộ tài liệu **đọc hiểu source code** của 2 service Java trong dự án Viec3Mien (V3M):

| Repo | Tên service | Vai trò |
|---|---|---|
| `behavior-events/` | `app-event-service` | Thu thập hành vi người dùng trên app (event tracking), đẩy sang CDP |
| `customer-service/` | `app-customer-service` | Backend chính của app: auth, KYC, chấm công, nhiệm vụ/điểm, đổi quà, thưởng, thông báo |

> **Khác gì với `docs/` trong từng repo?**
> `docs/` trong mỗi repo là **doc theo feature/flow nghiệp vụ** (viết khi làm ticket).
> Thư mục này là **doc theo SOURCE CODE** — đọc từ package → class → method, giải thích *tại sao code viết như vậy*.
> Dành cho: (1) bạn ôn lại toàn bộ dự án, (2) người mới vào đọc để hiểu codebase.

---

## Đọc theo thứ tự nào?

### Nếu bạn là người mới (chưa biết gì về dự án) — lộ trình 5 buổi

| Buổi | Đọc | Mục tiêu |
|---|---|---|
| 1 | [`00-tong-quan-he-thong.md`](00-tong-quan-he-thong.md) | Vẽ lại được sơ đồ hệ thống + kể được luồng xương sống |
| 2 | [`01-behavior-events/`](01-behavior-events/) (toàn bộ, service nhỏ ~1.700 dòng) | Hiểu trọn 1 microservice từ A→Z |
| 3 | `02-customer-service/00` → `04` | Hiểu khung sườn: package, config, security, exception |
| 4 | `02-customer-service/05` → `12` | Các module nghiệp vụ chính: auth, KYC, chấm công, rule engine |
| 5 | `02-customer-service/13` → `23` + [`04-tra-cuu-nhanh/`](04-tra-cuu-nhanh/) | Phần còn lại + tra cứu |

### Nếu bạn đã làm dự án, muốn ôn nhanh

1. [`05-on-tap/luong-end-to-end.md`](05-on-tap/luong-end-to-end.md) — kể lại luồng
2. [`05-on-tap/cau-hoi-on-tap.md`](05-on-tap/cau-hoi-on-tap.md) — tự kiểm tra
3. [`04-tra-cuu-nhanh/`](04-tra-cuu-nhanh/) — nhớ lại tên bảng/endpoint/config

### Nếu bạn cần tra 1 thứ cụ thể

→ [`04-tra-cuu-nhanh/api-index.md`](04-tra-cuu-nhanh/api-index.md) (mọi endpoint)
→ [`04-tra-cuu-nhanh/database-schema.md`](04-tra-cuu-nhanh/database-schema.md) (mọi bảng)
→ [`04-tra-cuu-nhanh/config-keys.md`](04-tra-cuu-nhanh/config-keys.md) (mọi config key)
→ [`04-tra-cuu-nhanh/glossary.md`](04-tra-cuu-nhanh/glossary.md) (thuật ngữ: customerId vs profileId vs userId...)

---

## Mục lục đầy đủ

### 0. Tổng quan
- [`00-tong-quan-he-thong.md`](00-tong-quan-he-thong.md) — kiến trúc, Kafka topic, datastore, luồng xương sống, tech stack

### 1. `behavior-events` (app-event-service)
| File | Nội dung |
|---|---|
| [`00-tong-quan.md`](01-behavior-events/00-tong-quan.md) | Service này làm gì, 5 quyết định thiết kế |
| [`01-cau-truc-package.md`](01-behavior-events/01-cau-truc-package.md) | Bản đồ 25 class |
| [`02-api-controller.md`](01-behavior-events/02-api-controller.md) | `AppEventController`, validate thủ công, `/Reprocess` |
| [`03-kafka.md`](01-behavior-events/03-kafka.md) | 2 producer + 1 consumer, xử lý lỗi/offset |
| [`04-service-layer.md`](01-behavior-events/04-service-layer.md) | `AppEventServiceImpl`, `BehaviorForwardService`, `BehaviorReprocessService` |
| [`05-cache-datasource.md`](01-behavior-events/05-cache-datasource.md) | 2 cache + 3 datasource (PG + MariaDB + CDP) |
| [`06-entity-database.md`](01-behavior-events/06-entity-database.md) | `t_app_event`, `t_behavior_mapping`, 4 migration |
| [`07-config-deploy-test.md`](01-behavior-events/07-config-deploy-test.md) | yml, pom, Dockerfile, CI/CD, unit test |

### 2. `customer-service` (app-customer-service)
| File | Nội dung |
|---|---|
| [`00-tong-quan.md`](02-customer-service/00-tong-quan.md) | Service này làm gì, 12 module nghiệp vụ |
| [`01-cau-truc-package.md`](02-customer-service/01-cau-truc-package.md) | Convention thư mục, bản đồ 380 class |
| [`02-khoi-dong-config.md`](02-customer-service/02-khoi-dong-config.md) | `@SpringBootApplication`, bootstrap, các `@Configuration` |
| [`03-security-jwt.md`](02-customer-service/03-security-jwt.md) | `SecurityConfig`, `JwtAuthFilter`, `JwtUtil`, `RedisTokenService` |
| [`04-exception-response.md`](02-customer-service/04-exception-response.md) | `GlobalExceptionHandler`, `ApiResponse`, bài học map status |
| [`05-module-auth.md`](02-customer-service/05-module-auth.md) | Login, đăng ký OTP, refresh token, quên/đổi mật khẩu |
| [`06-module-kyc.md`](02-customer-service/06-module-kyc.md) | OCR CCCD + đối chiếu khuôn mặt (EKYC AI) |
| [`07-module-profile-bank-agreement.md`](02-customer-service/07-module-profile-bank-agreement.md) | Hồ sơ, tài khoản ngân hàng, điều khoản |
| [`08-module-cache-masterdata.md`](02-customer-service/08-module-cache-masterdata.md) | 4 pattern cache, MD5-version, news, favorites |
| [`09-module-apply.md`](02-customer-service/09-module-apply.md) | Ứng tuyển đồng bộ, người giới thiệu, phân bổ sale |
| [`10-module-timekeeping.md`](02-customer-service/10-module-timekeeping.md) | Chấm công: GPS polygon, face, missed-checkout, JobStatus |
| [`11-module-rule-config.md`](02-customer-service/11-module-rule-config.md) | Admin CRUD earn rule, validate, điều kiện hiển thị |
| [`12-module-rule-engine.md`](02-customer-service/12-module-rule-engine.md) | `processEvent`, COUNT/SUM/STREAK, auto-enroll, cộng điểm |
| [`13-module-gift-urbox.md`](02-customer-service/13-module-gift-urbox.md) | Catalog quà, đổi điểm lấy voucher, 3 transaction |
| [`14-module-reward-incentive.md`](02-customer-service/14-module-reward-incentive.md) | Thưởng (tiền) + hoa hồng CTV — proxy có hàng rào |
| [`15-module-notification-fcm.md`](02-customer-service/15-module-notification-fcm.md) | Inbox + FCM push, broadcast, dedup |
| [`16-module-ctv.md`](02-customer-service/16-module-ctv.md) | Trở thành CTV, render PDF hợp đồng |
| [`17-module-admin.md`](02-customer-service/17-module-admin.md) | Tra cứu giao dịch điểm/quà (Specification API) |
| [`18-tich-hop-3rd-party.md`](02-customer-service/18-tich-hop-3rd-party.md) | 7 Feign proxy: hr-backend, CDP, EKYC, Urbox, OTP |
| [`19-jobs-quartz.md`](02-customer-service/19-jobs-quartz.md) | 8 Quartz job |
| [`20-kafka-consumers.md`](02-customer-service/20-kafka-consumers.md) | 3 consumer + dedup Redis |
| [`21-storage-s3.md`](02-customer-service/21-storage-s3.md) | FPT Object Storage, public vs presigned |
| [`22-utils-crypto.md`](02-customer-service/22-utils-crypto.md) | RSA, RC2, GeoUtils, DebuggingDTO |
| [`23-database-migration.md`](02-customer-service/23-database-migration.md) | 60 migration, convention áp dụng tay |

### 3. Kiến thức nền (cần biết để đọc code)
- [`spring-boot-annotations.md`](03-kien-thuc-nen/spring-boot-annotations.md)
- [`jpa-transaction.md`](03-kien-thuc-nen/jpa-transaction.md)
- [`kafka-co-ban.md`](03-kien-thuc-nen/kafka-co-ban.md)
- [`redis-cache-patterns.md`](03-kien-thuc-nen/redis-cache-patterns.md)
- [`bao-mat-va-loi-thuong-gap.md`](03-kien-thuc-nen/bao-mat-va-loi-thuong-gap.md)

### 4. Tra cứu nhanh
- [`api-index.md`](04-tra-cuu-nhanh/api-index.md)
- [`database-schema.md`](04-tra-cuu-nhanh/database-schema.md)
- [`config-keys.md`](04-tra-cuu-nhanh/config-keys.md)
- [`glossary.md`](04-tra-cuu-nhanh/glossary.md)

### 5. Ôn tập
- [`luong-end-to-end.md`](05-on-tap/luong-end-to-end.md)
- [`cau-hoi-on-tap.md`](05-on-tap/cau-hoi-on-tap.md)

---

## Quy ước trong tài liệu

- `file.java:123` — đường dẫn có số dòng, click được trong IDE/terminal.
- 🔑 = điểm cốt lõi phải nhớ.
- ⚠️ = bẫy / lỗi đã từng xảy ra thật trên production/UAT.
- 💡 = mẹo hoặc kiến thức nền mở rộng.
- Mã ticket dạng `SB-xxxx` là Jira ticket — tra được lịch sử quyết định trong `CHANGELOG.md` của repo.

---

## Lưu ý khi đọc

1. **Code có comment giải thích "tại sao"** — dự án này bắt buộc comment phải nói lý do, không nói "làm gì". Khi đọc code, comment chính là tài liệu thiết kế.
2. **Rất nhiều quyết định đến từ sự cố thật.** Ví dụ `MissionEnrollmentService` có 4 gạch đầu dòng, mỗi gạch là 1 failure đã reproduce được. Đọc kỹ những chỗ đó — đó là phần "học được nhiều nhất".
3. **Đừng học thuộc, hãy kể lại được luồng.** Xem [`05-on-tap/luong-end-to-end.md`](05-on-tap/luong-end-to-end.md).
