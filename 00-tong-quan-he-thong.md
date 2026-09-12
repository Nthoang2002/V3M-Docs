# 00 — Tổng quan hệ thống V3M

> Đọc file này TRƯỚC. Mọi file khác giả định bạn đã có bản đồ trong đầu.

---

## 1. V3M là gì

**Viec3Mien (V3M)** — nền tảng tuyển dụng lao động phổ thông. Có 3 nhóm người dùng:

| Vai trò | Làm gì trên app |
|---|---|
| **NLĐ** (người lao động) | Tìm việc → ứng tuyển → đi làm → **chấm công** → xem **thưởng** (tiền) |
| **CTV** (cộng tác viên) | Giới thiệu hồ sơ người khác → nhận **hoa hồng** |
| **Admin / CRM** | Cấu hình nhiệm vụ, giá quà, duyệt chấm công, tra cứu giao dịch |

Xen ngang tất cả: hệ **gamification** — làm nhiệm vụ (mission) → tích **điểm** → **đổi quà** (voucher Urbox).

🔑 **Phân biệt 2 loại "thưởng" — hỏi rất nhiều:**
- **Thưởng (tiền)** — do CRM tính, customer-service chỉ **proxy** đọc. Module `reward`, `incentive`.
- **Điểm (point)** — do chính customer-service tính bằng **rule engine**. Module `rule/engine`, `gift`.

---

## 2. Bản đồ hệ thống

```
   ┌───────────┐   ┌───────────┐   ┌──────────────────┐
   │ App mobile│   │  Web / FE │   │ Portal CRM (hr-  │
   │  (v1/v2)  │   │           │   │ backend, C#/.NET)│
   └─────┬─────┘   └─────┬─────┘   └────────┬─────────┘
         │               │                  │
         │  Gateway Zuul: /app/** = JWT user · /api/** = admin · /crm/** = proxy hr-backend
         └───────────────┼──────────────────┘
                 ┌───────┴────────┐
                 ▼                ▼
   ╔══════════════════════╗   ╔════════════════════════════════╗
   ║ app-event-service    ║   ║ customer-service               ║
   ║ (repo behavior-events)║  ║ backend chính của app          ║
   ║ port 9093 · 25 class ║   ║ 380 class · 60 migration       ║
   ╚═══════╤══════════╤═══╝   ╚═══╤═══════════════════╤════════╝
           │          │           │                   │
   app-event-topic    │      rule-events        Feign / HTTP
           │          │      cdp-behavior-saved       │
           ▼          │      hr-timekeeping-sync      ▼
   PostgreSQL         │           ▲           hr-backend (CRM, C#)
   app_event.         │           │           Urbox (quà/voucher)
   t_app_event        │           │           EKYC AI Mobifi (OCR + face)
   (raw, JSONB)       │           │           Mobifi OTP (SMS)
                      ▼           │           FCM (push)
              cdp-behavior-topic  │           FPT Object Storage (S3)
                      │           │
                      ▼           │
              ╔═══════════════╗   │
              ║  cdp-service  ║───┘  lưu customer_behavior
              ║  (CDP / PG)   ║      rồi bắn cdp-behavior-saved
              ╚═══════════════╝
```

### Các service KHÔNG nằm trong 2 repo này (biết để không nhầm)

| Service | Ngôn ngữ | Vai trò |
|---|---|---|
| `hr-backend` | C# / .NET (ABP) | CRM: hồ sơ tuyển dụng, tính thưởng/hoa hồng, master data |
| `cdp-service` | — | Customer Data Platform: `customer_behavior`, `customer_identity` |
| `v3m-core-service` | Java (hệ cũ) | App v1 legacy, đang được thay bởi customer-service |
| `sync-data-crm` | — | Job đồng bộ dữ liệu CRM → app |
| Gateway (Zuul) | Java | Định tuyến + auth biên |
| Eureka + Config Server | Java | Service discovery + cấu hình tập trung |

---

## 3. Kafka topic — nhớ đúng chiều

| Topic | Producer | Consumer | Chở gì |
|---|---|---|---|
| `app-event-topic` | app-event-service (từ REST) | app-event-service (`AppEventConsumer`) | raw behavior event |
| `cdp-behavior-topic` | app-event-service **+** customer-service **+** hr-backend | cdp-service | behavior đã lọc, chuẩn CDP |
| `cdp-behavior-saved` | cdp-service | customer-service `CdpBehaviorSavedConsumer` | behavior ĐÃ LƯU → chạy rule engine |
| `cdp-transaction-topic` | hr-backend | cdp-service | hồ sơ tuyển dụng (AppProfile) |
| `rule-events` | hệ thống C# | customer-service `RuleEventConsumer` | event nghiệp vụ bắn trực tiếp |
| `hr-timekeeping-sync-topic` | hr-backend | customer-service `HrTimekeepingSyncConsumer` | lịch sử chấm công từ CRM |

🔑 **Ý nghĩa của chiều đi:**
- `cdp-behavior-topic` là **cửa duy nhất** vào CDP, có **3 producer**.
- `cdp-service` là **source of truth**: chỉ bắn `cdp-behavior-saved` **sau khi lưu thành công**.
  ⇒ customer-service **không bao giờ cộng điểm** cho behavior mà CDP chưa ghi nhận.

---

## 4. Datastore — ai sở hữu cái gì

| Store | Ai sở hữu | Dùng làm gì |
|---|---|---|
| PostgreSQL `cdp`, schema `app_event` | app-event-service | `t_app_event`, `t_behavior_mapping` |
| PostgreSQL `cdp`, schema `public` | cdp-service | `customer_behavior`, `customer_identity` |
| **MariaDB `app-customer`** | **customer-service** | ~35 bảng `t_*`, `earn_rule`, `t_user_point`, `event_type`… |
| MariaDB `v3m` | v3m-core-service (hệ cũ) | `base_user` — app-event-service **chỉ đọc** |
| SQL Server `HR` | hr-backend (C#) | `AppProfile`, `AppRecruitment`, `AbpUsers`, bảng đối soát |
| **Redis** | customer-service | JWT refresh token, cache hr-data, **dedup rule engine**, OTP session |
| FPT Object Storage (S3) | customer-service | ảnh CCCD, ảnh mặt, ảnh chấm công, hợp đồng CTV |

---

## 5. 🔑 Luồng xương sống — kể được luồng này là kể được cả dự án

**Bối cảnh:** user ứng tuyển thành công trên app → được cộng điểm nhiệm vụ.

```
[1] App bấm "Ứng tuyển thành công"
      │  POST /api/events
      │  { action:"event", name:"nguoi_dung_ung_tuyen_thanh_cong", page, session_id, customer_id }
      ▼
[2] app-event-service · AppEventController.trackEvent()
      │  • nhận JsonNode → chấp nhận cả OBJECT lẫn ARRAY
      │  • validate THỦ CÔNG bằng javax Validator (vì body là JsonNode, @Valid không chạy)
      │  • sinh eventId = UUID (SERVER sinh, không tin client)
      │  • publish Kafka app-event-topic (key = eventId) → trả 202 Accepted NGAY
      ▼
[3] app-event-service · AppEventConsumer.consume()
      │  • deserialize → nếu lỗi: log + RETURN (commit offset, không chặn partition)
      │  • gọi saveEvent()
      ▼
[4] AppEventServiceImpl.saveEvent()  @Transactional
      │  • dedup: existsByEventId → trùng thì skip
      │  • lưu PostgreSQL app_event.t_app_event (metadata = JSONB)
      │  • gọi BehaviorForwardService.tryForward()
      ▼
[5] BehaviorForwardService.tryForward()
      │  • customerId rỗng? → resolve từ userId qua UserResolutionCache
      │       userId → (MariaDB v3m.base_user) → phone → (PG customer_identity) → customerId
      │  • tra bảng dịch t_behavior_mapping:
      │       action="event" → match theo `name`
      │       action="view"  → match theo `page`
      │    ⇒ behaviorType = "APP_APPLIED"
      │  ⚠️ KHÔNG khớp mapping = BỎ QUA IM LẶNG (log info "no mapping")
      │  • publish Kafka cdp-behavior-topic (key = customerId)
      ▼
[6] cdp-service — lưu customer_behavior → bắn Kafka cdp-behavior-saved
      ▼
[7] customer-service · CdpBehaviorSavedConsumer.consume()
      │  • customerId (UUID) → tra t_user → userId (Long)   [không có user → skip]
      │  • CustomerEvent.eventType = behavior.behaviorType   ← PASSTHROUGH 1:1, không có bảng dịch
      │  • isRewardable(): lọc riêng ATTENDANCE (chỉ CHECKOUT hợp lệ / CHECKIN đã duyệt)
      │  • dedup Redis: SETNX rule:event:dedup:{userId}:{type}:{phút}  TTL 300s
      ▼
[8] RuleEngineServiceImpl.processEvent()  @Transactional
      │  • tìm rule_condition ACTIVE có trigger_event_type = eventType, còn hạn
      │  • gom theo earn_rule → mỗi rule:
      │      – user đã enroll chưa? (t_user_rule_progress) → chưa thì BỎ
      │      – đã thưởng trong kỳ này chưa? (period_key) → rồi thì BỎ
      │      – tăng tiến độ theo ruleType: COUNT +1 / SUM +delta / STREAK chuỗi
      │      – đủ điều kiện → completed = true
      │  • evaluate biểu thức nhóm: group1 AND (cond1 OR cond2) …
      │  • đủ → awardPoints()
      ▼
[9] awardPoints()
      • t_user_point.total_points += earn_rule.point
      • INSERT t_point_transaction (type=EARN)
      • đánh dấu progress kỳ này rewarded = true
      • notifyMissionCompleted()  → best-effort, REQUIRES_NEW  (lỗi KHÔNG rollback điểm)
      • enrollUnlockedMissions() → nhiệm vụ lấy nhiệm vụ vừa xong làm tiền đề → enroll ngay
```

### ⚠️ Chuỗi phụ thuộc tên (bẫy lớn nhất của hệ thống)

```
app gửi (action, match_value)
   → t_behavior_mapping.behavior_type          [PostgreSQL, repo behavior-events]
   → cdp-behavior-topic → cdp-service → cdp-behavior-saved
   → CustomerEvent.eventType                    [PASSTHROUGH — không dịch]
   → rule_condition.trigger_event_type          [MariaDB, repo customer-service]
```
**`behavior_type` và `trigger_event_type` là MỘT TỪ VỰNG DÙNG CHUNG, ở 2 DB khác nhau, 2 repo khác nhau, không có FK.**
Lệch 1 ký tự = nhiệm vụ không bao giờ chạy, **và không có log lỗi nào** (chỉ có dòng `Behavior forward skipped — no mapping` ở INFO).
→ Đây là lý do migration `V004` bên behavior-events và `V054/V055` bên customer-service phải seed **khớp nhau**.

### Luồng thứ hai vào rule engine — đừng quên

```
App chấm công → POST /timekeeping/check
   → TimekeepServiceImpl.checkIn()
   → lưu timekeep_record + publish THẲNG cdp-behavior-topic (behaviorType = "ATTENDANCE")
   → cdp-service → cdp-behavior-saved → CdpBehaviorSavedConsumer → rule engine
```
Tức customer-service vừa là **producer** vừa là **consumer** của chuỗi CDP.
Ngoài ra `hr-timekeeping-sync-topic` (chấm công nhập từ CRM) cũng đi vào cùng chuỗi.

---

## 6. Tech stack (giống nhau ở cả 2 service)

| Hạng mục | Công nghệ |
|---|---|
| Ngôn ngữ | **Java 11** |
| Framework | Spring Boot (parent nội bộ `com.ttt:core:0.0.5`) |
| ORM | Spring Data JPA + Hibernate |
| DB | customer-service: **MariaDB** · behavior-events: **PostgreSQL** (+ đọc MariaDB & PG-CDP) |
| Message | Apache Kafka (`spring-kafka`) |
| Cache | Redis (chỉ customer-service) |
| HTTP client | **Spring Cloud OpenFeign** |
| Scheduler | **Quartz** (JDBC store) — chỉ customer-service |
| API doc | **Swagger 2** (springfox 2.8.0) |
| Boilerplate | Lombok + MapStruct |
| Discovery/Config | Eureka client + Spring Cloud Config Server |
| Tracing | `spring-cloud-starter-sleuth` |
| Metric | Micrometer + Prometheus (`/actuator/prometheus`) |
| Test | JUnit 5 + Mockito (+ `@WebMvcTest`) |
| CI/CD | GitLab CI → Docker image `registry.3tit.vn` → Helm repo (GitOps) |

---

## 7. Các con số cần nhớ

| Con số | Ý nghĩa |
|---|---|
| **2** service Java trong scope | behavior-events + customer-service |
| **~1.776** dòng / **25** class | behavior-events (main) |
| **~21.000** dòng / **380** class | customer-service (main) |
| **~600** unit test | customer-service (`mvn test`) |
| **60** migration SQL | customer-service (`db/migration/V001` → `V059`) |
| **4** migration SQL | behavior-events |
| **6** Kafka topic | xem bảng mục 3 |
| **8** Quartz job | customer-service |
| **3** Kafka consumer | customer-service |
| **7** Feign proxy | hr-backend×3, CDP, EKYC, Urbox, OTP |

---

## 8. Deploy & CI/CD (chung 1 pipeline template)

```
push nhánh  →  workflow rules chọn CI_EVENT theo tên nhánh
   feature/*   → dev_commit       (tag image = commit sha)
   develop*    → sit_commit
   release*    → release_package  (tag image = version trong commit message)  → deploy uat
   hotfix*     → hotfix_package                                              → deploy uat
   master      → production_package                                          → deploy production

Stage:  verify → build (mvn install) → set_version → package (docker build/push) → deploy
Deploy = clone repo Helm `v3m-core-helm-repo`, sed values.yaml đổi image tag, commit, push (GitOps)
```

🔑 **Version KHÔNG nằm trong `pom.xml`.** CI parse version từ **commit message** dạng `#1.2.3# SB-1234: mô tả`.

---

## 9. Đi tiếp

→ Service nhỏ trước: [`01-behavior-events/00-tong-quan.md`](01-behavior-events/00-tong-quan.md)
→ Hoặc vào thẳng service lớn: [`02-customer-service/00-tong-quan.md`](02-customer-service/00-tong-quan.md)
