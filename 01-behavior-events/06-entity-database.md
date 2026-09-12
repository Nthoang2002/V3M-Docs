# behavior-events — Entity & Database

DB: **PostgreSQL**, database `cdp`, schema `app_event`.
`ddl-auto: none` → **JPA không tự tạo bảng**, phải chạy migration bằng tay.

---

## 1. `t_app_event` — bảng chính (raw event)

### Entity `entities/AppEventEntity.java`

```java
@Entity
@Table(name = "t_app_event", schema = "app_event",
       indexes = {
           @Index(name = "idx_app_event_action",      columnList = "action"),
           @Index(name = "idx_app_event_customer_id", columnList = "customer_id"),
           @Index(name = "idx_app_event_user_id",     columnList = "user_id"),
           @Index(name = "idx_app_event_timestamp",   columnList = "timestamp")
       })
@EntityListeners(AuditingEntityListener.class)          // cho @CreatedDate
public class AppEventEntity {

    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, unique = true, length = 36)
    private String eventId;                              // 🔑 UUID, khoá dedup

    @Column(name = "action",     nullable = false, length = 100) private String action;
    @Column(name = "page",       nullable = false, length = 100) private String page;
    @Column(name = "name",       nullable = false, length = 100) private String name;
    @Column(name = "customer_id", length = 36)                    private String customerId;
    @Column(name = "session_id", nullable = false, length = 100)  private String sessionId;
    @Column(name = "user_id",    length = 50)                     private String userId;

    @Column(name = "metadata", columnDefinition = "jsonb")        // 🔑 kiểu JSONB của PostgreSQL
    @ColumnTransformer(write = "?::jsonb")                        // 🔑 ép kiểu lúc INSERT
    private String metadata;

    @Column(name = "timestamp", nullable = false)  private LocalDateTime timestamp;

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
```

### 🔑 Điểm kỹ thuật quan trọng nhất: `@ColumnTransformer(write = "?::jsonb")`

Cột DB là `jsonb`. Java field là `String`. JDBC gửi `String` → PostgreSQL báo lỗi
`column "metadata" is of type jsonb but expression is of type character varying`.

`@ColumnTransformer(write = "?::jsonb")` bảo Hibernate viết SQL thành `INSERT ... VALUES (?::jsonb)` — tức **cast ngay trong câu SQL**.

💡 Vì sao lưu JSONB mà không parse thành cột riêng? Vì `metadata` là **schema-less** — app thêm field bất cứ lúc nào. JSONB cho phép truy vấn được (`metadata->>'device'`) mà không cần migration mỗi lần app đổi.

### Các quyết định schema khác

| Quyết định | Vì sao |
|---|---|
| `event_id` UNIQUE | Lớp bảo vệ cuối cho dedup (ngoài `existsByEventId` ở code) |
| 4 index (`action`, `customer_id`, `user_id`, `timestamp`) | 4 chiều truy vấn phân tích chính |
| `user_id` **nullable** (từ `V002`) | App v2 không gửi `user_id`. Migration `V001` để `NOT NULL`, phải sửa lại. |
| `customer_id` nullable | App v1 không có |
| `@CreatedDate` + `AuditingEntityListener` | Spring Data tự set lúc persist. Cần `@EnableJpaAuditing` ở Application class. |

---

## 2. `t_behavior_mapping` — bảng dịch tên hành vi

```java
@Entity
@Table(name = "t_behavior_mapping", schema = "app_event")
public class BehaviorMappingEntity {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;
    @Column(name = "action",        nullable = false, length = 50)  private String action;       // 'event' | 'view'
    @Column(name = "match_value",   nullable = false, length = 100) private String matchValue;   // name hoặc page
    @Column(name = "behavior_type", nullable = false, length = 100) private String behaviorType; // mã CDP
    @Column(name = "enabled",       nullable = false)               private boolean enabled;
    @Column(name = "description",   length = 255)                   private String description;
}
```
UNIQUE `(action, match_value)`.

🔑 **Bảng này là "cấu hình dưới dạng dữ liệu"** — thêm hành vi mới = INSERT, không deploy.

---

## 3. Repository

```java
public interface AppEventRepository extends JpaRepository<AppEventEntity, Long> {
    Optional<AppEventEntity> findByEventId(String eventId);
    boolean existsByEventId(String eventId);                                   // ← dedup

    Page<AppEventEntity> findByAction(String action, Pageable pageable);
    Page<AppEventEntity> findByCustomerId(String customerId, Pageable pageable);
    Page<AppEventEntity> findByTimestampBetween(LocalDateTime from, LocalDateTime to, Pageable p);
    Page<AppEventEntity> findByCreatedAtBetween(LocalDateTime from, LocalDateTime to, Pageable p);  // ← reprocess
}

public interface BehaviorMappingRepository extends JpaRepository<BehaviorMappingEntity, Long> {
    List<BehaviorMappingEntity> findByEnabledTrue();                           // ← cache load
}
```
💡 Tất cả đều là **derived query** (Spring Data tự sinh SQL từ tên method) — không có `@Query` nào. Đủ dùng vì truy vấn đơn giản.

---

## 4. Migration (`db/migration/`)

### `V001__create_app_event_schema.sql`
```sql
CREATE SCHEMA IF NOT EXISTS app_event;

CREATE TABLE IF NOT EXISTS app_event.t_app_event (
    id          BIGSERIAL    PRIMARY KEY,
    event_id    VARCHAR(36)  NOT NULL UNIQUE,
    action      VARCHAR(100) NOT NULL,
    page        VARCHAR(100) NOT NULL,
    name        VARCHAR(100) NOT NULL,
    customer_id VARCHAR(36),
    session_id  VARCHAR(100) NOT NULL,
    user_id     VARCHAR(50)  NOT NULL,        -- ⚠️ sau bị sửa thành nullable ở V002
    metadata    JSONB,
    timestamp   TIMESTAMP    NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_event_action      ON app_event.t_app_event (action);
CREATE INDEX IF NOT EXISTS idx_app_event_customer_id ON app_event.t_app_event (customer_id);
CREATE INDEX IF NOT EXISTS idx_app_event_user_id     ON app_event.t_app_event (user_id);
CREATE INDEX IF NOT EXISTS idx_app_event_timestamp   ON app_event.t_app_event (timestamp);
```

### `V002__alter_t_app_event_user_id_nullable.sql`
```sql
ALTER TABLE app_event.t_app_event ALTER COLUMN user_id DROP NOT NULL;
```
> Bài học: app v2 chuyển sang gửi `customer_id` thay `user_id` → constraint cũ chặn.

### `V003__create_behavior_mapping.sql` — tạo bảng + seed 11 mapping

```sql
CREATE TABLE IF NOT EXISTS app_event.t_behavior_mapping (
    id            BIGSERIAL    PRIMARY KEY,
    action        VARCHAR(50)  NOT NULL,      -- 'event' hoặc 'view'
    match_value   VARCHAR(100) NOT NULL,      -- name (nếu action=event), page (nếu action=view)
    behavior_type VARCHAR(100) NOT NULL,      -- CDP behavior type
    enabled       BOOLEAN      NOT NULL DEFAULT true,
    description   VARCHAR(255),
    CONSTRAINT uk_behavior_mapping UNIQUE (action, match_value)
);
```

Seed `action='event'` (sự kiện nghiệp vụ):
| match_value | behavior_type |
|---|---|
| `nguoi_dung_ung_tuyen_thanh_cong` | `APP_APPLIED` |
| `nguoi_dung_bam_ung_tuyen` | `APP_CLICK_APPLY` |
| `nguoi_dung_vao_xem_chi_tiet_cong_viec` | `APP_VIEW_JOB` |

Seed `action='view'` (mở màn hình):
| match_value (page) | behavior_type |
|---|---|
| `DetailJobPage` | `APP_VIEW_JOB` |
| `CreateLeadPage` | `APP_VIEW_APPLY` |
| `CheckInPage`, `CheckInTabPage` | `APP_VIEW_CHECKIN` |
| `AshHousePage`, `AshHouseDetailPage` | `APP_VIEW_HOUSING` |
| `AllRewardScreen` | `APP_VIEW_REWARD` |
| `JobPage` | `APP_BROWSE_JOBS` |

### `V004__seed_behavior_mapping_mission_events.sql` — 🔑 mapping cho bộ nhiệm vụ (SB-4815)

Đây là migration **quan trọng nhất để hiểu chuỗi phụ thuộc**. Comment trong file nói rõ:

```
Chuỗi phụ thuộc: app/hr-backend gửi (action, match_value) → bảng này dịch ra behavior_type →
cdp-behavior-topic → cdp-service → cdp-behavior-saved → customer-service
CdpBehaviorSavedConsumer đặt CustomerEvent.eventType = behavior_type (PASSTHROUGH 1:1).
⇒ behavior_type ở đây PHẢI trùng đúng chuỗi code trong customer-service `event_type`
  (đã seed ở migration V054/V055 bên repo customer-service). Lệch 1 ký tự là nhiệm vụ không bao giờ chạy.
```

Nguồn **APP**:
| match_value | behavior_type |
|---|---|
| `nguoi_dung_tao_tai_khoan_thanh_cong` | `REGISTER` |
| `nguoi_dung_hoan_tat_thong_tin_bo_sung` | `PROFILE_COMPLETE` |
| `nguoi_dung_xac_thuc_cccd_thanh_cong` | `KYC_VERIFIED` |
| `nguoi_dung_them_tai_khoan_ngan_hang` | `BANK_ACCOUNT_ADDED` |
| `nguoi_dung_ky_hop_dong_ctv` | `CTV_CONTRACT_SIGNED` |
| `nguoi_dung_dang_ky_nld` | `NLD_REGISTERED` |
| `nguoi_dung_gioi_thieu_ho_so_thanh_cong` | `REFERRAL_CREATED` |

Nguồn **HR-BACKEND** (trạng thái hồ sơ do CRM đổi):
| match_value | behavior_type |
|---|---|
| `ho_so_gioi_thieu_phong_van_dat` | `REFERRAL_INTERVIEW_PASSED` |
| `ho_so_gioi_thieu_di_lam` | `REFERRAL_WORKING` |

### 🔑 Bài học từ comment của `V004` — tách 2 code thay vì 1 code + filter

> *"Tách 2 code riêng thay vì 1 code + filter metadata.status: `EarnRuleServiceImpl.buildConditions` bên customer-service **KHÔNG lưu** `filterField`/`filterValue` nên cấu hình filter bị bỏ qua âm thầm."*

Tức: bên customer-service có cột `filter_field`/`filter_value` trong `rule_condition`, **nhưng code tạo rule không map chúng** → nếu thiết kế "1 behaviorType `REFERRAL_STATUS` + filter theo `metadata.status`" thì filter sẽ **bị bỏ qua** và mọi thay đổi trạng thái đều tính điểm.
→ Chọn cách an toàn: **2 behaviorType riêng biệt**.
💡 Đây là ví dụ điển hình của "thiết kế theo khả năng thật của hệ thống, không theo lý thuyết".

### Convention naming `match_value`
> snake_case tiếng Việt không dấu, tiền tố là **CHỦ THỂ** của hành động:
> `nguoi_dung_*` = người dùng app · `ho_so_gioi_thieu_*` = hồ sơ được giới thiệu (chủ thể là hồ sơ, không phải user).

## 5. Đi tiếp

→ [`07-config-deploy-test.md`](07-config-deploy-test.md)
