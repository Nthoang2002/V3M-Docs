# customer-service — Database & Migration

DB: **MariaDB** `app-customer` · `ddl-auto: none` · **KHÔNG dùng Flyway**

---

## 1. ⚠️ Migration áp dụng THỦ CÔNG

Từ `CLAUDE.md`:
> *"Migration script đặt tại `db/migration/` ở root project. **Áp dụng THỦ CÔNG** — customer-service **KHÔNG dùng Flyway**, JPA `ddl-auto: none`. File `db/migration/*.sql` chỉ là **bản ghi/nguồn**; phải chạy trực tiếp trên DB (`app-customer`, MariaDB) **bằng tay** khi deploy (đặc biệt index, đổi column type). **KHÔNG có cơ chế tự apply — quên chạy = app lỗi khi query cột/bảng chưa có.**"*

🔑 Đây là rủi ro vận hành lớn nhất của dự án. Mỗi lần deploy có migration mới phải nhớ chạy tay **trước** khi rollout pod mới.

### Quy tắc
```
V{version}__{action}_{table}.sql
```
- ❌ **Không sửa file migration cũ** — mỗi thay đổi entity là 1 file mới (`ALTER TABLE`)
- ✅ Mỗi bảng phải có đầy đủ: PK, UNIQUE constraints, indexes

---

## 2. Bảng 60 migration theo nhóm

### Nhóm auth / user
| File | Nội dung |
|---|---|
| `V001__create_t_user.sql` | Bảng `t_user` |
| `V003__alter_t_user_add_customer_id.sql` | Liên kết CDP |
| `V009__alter_t_user_unique_phone.sql` | UNIQUE phone |
| `V010__alter_t_user_phone_required.sql` | phone NOT NULL |
| `V020__alter_t_user_add_profile.sql` | Field hồ sơ |
| `V021__create_t_user_bank_account.sql` | Tài khoản ngân hàng |
| `V022__alter_t_user_add_face_image_url.sql` | |
| `V027__alter_t_user_add_kyc_fields.sql` | `cccd_*_url`, `kyc_face_url`, `is_verified` |
| `V030__alter_t_user_add_ctv_contract_url.sql` | |
| `V031__alter_t_user_add_cdp_sync_count.sql` | Cờ hàng đợi sync CDP |
| `V032__alter_t_user_add_favorite_recruitment_ids.sql` | CSV yêu thích |
| `V033__alter_add_source_to_user_and_bank_account.sql` | 🔑 `source` = APP/CRM_SYNC |
| `V035__alter_t_user_add_kyc_raw_fields.sql` | Cột staging `*_raw` |
| `V045__backfill_t_user_gender_to_master_data_id.sql` | 🔑 Backfill gender sang id master-data |
| `V047__alter_t_user_add_profile_fields.sql` | Hồ sơ mở rộng SB-4257 |
| `V059__alter_t_user_add_agent_support.sql` + `V059b` (.md) | Sale phụ trách; **backfill cross-DB nên tách file hướng dẫn** |

### Nhóm rule engine / config
| File | Nội dung |
|---|---|
| `V002__create_rule_engine_tables.sql` | `t_user_rule_progress`, `t_user_point` |
| `V004`–`V007` | Thêm `rule_type`, `reset_period`, `streak_unit`, `sum_field`, link earn_rule |
| `V008__create_t_point_transaction.sql` | Sổ cái điểm |
| `V011__alter_rule_config_add_category.sql` · `V012__..._reset_period` | |
| `V013__alter_user_rule_progress_add_period_key.sql` | 🔑 Cơ chế kỳ |
| `V015__alter_rule_condition_add_tracking.sql` | |
| `V016__alter_user_rule_progress_to_condition.sql` | 🔑 Đổi khoá progress từ rule → condition |
| `V017`, `V018` | Bỏ `t_rule_config` (bảng cũ) |
| `V019__seed_event_type_data.sql` | Seed event type |
| `V051__create_earn_rule_display_condition_tables.sql` | Điều kiện hiển thị (SB-4386) |
| `V053__create_t_app_router_and_earn_rule_router.sql` | Router (SB-4815) |
| `V054__seed_event_type_mission_events.sql` | |
| **`V055__align_event_type_with_app_behavior_types.sql`** | 🔑 Đồng bộ từ vựng với behavior-events |

### Nhóm timekeeping
| File | Nội dung |
|---|---|
| `V023__create_recruitment_location_cache.sql` | |
| `V024__create_timekeep_record.sql` | |
| `V026__alter_timekeep_record_add_hr_timekeep_id.sql` | 🔑 Dedup sync từ CRM |
| `V048__create_worker_recruitment_status.sql` | JobStatus |
| `V049__alter_timekeep_record_add_customer_id.sql` | |
| `V050__seed_worker_recruitment_status_resigned.sql` | |

### Nhóm apply / CTV / incentive
| File | Nội dung |
|---|---|
| `V027__create_t_apply.sql` | ⚠️ **Trùng số V027** với `alter_t_user_add_kyc_fields` |
| `V028__alter_t_apply_add_failure_reason.sql` | |
| `V029__alter_t_apply_add_app_user_id.sql` + `V041__backfill_...` | 🔑 Đổi khoá tra cứu |
| `V042__alter_t_apply_add_creator_phone.sql` | |
| `V052__create_t_ctv_contract.sql` | |
| `V058__alter_t_apply_add_referral_id.sql` | 🔑 Người giới thiệu (SB-4471) |

### Nhóm gift / notification / agreement / cache
| File | Nội dung |
|---|---|
| `V011__create_system_config.sql` | ⚠️ **Trùng số V011** |
| `V036__create_t_user_device.sql` · `V037__create_t_notification.sql` · `V038__..._is_active` | |
| `V039__create_t_gift_price.sql` · `V040__create_t_gift_redemption.sql` | |
| `V043__alter_t_point_transaction_add_gift_id.sql` | Enrich tên quà |
| `V044__alter_t_gift_redemption_add_voucher_codes.sql` | |
| `V046__create_agreement_tables.sql` | |
| `V056__create_t_gift_price_history.sql` | 🔑 Audit set giá (SB-4842) |
| `V057__alter_t_gift_redemption_add_point_balance.sql` | `points_before/after` |

### ⚠️ Trùng số version
`V011` (×2: `alter_rule_config_add_category` + `create_system_config`) và `V027` (×2: `alter_t_user_add_kyc_fields` + `create_t_apply`).
🔑 Không gây lỗi vì **không dùng Flyway** (Flyway sẽ báo `Found more than one migration with version 11`). Nhưng là dấu hiệu của 2 nhánh phát triển song song không đồng bộ số.

### `V059b__backfill_t_user_agent_support.md` — file `.md` chứ không `.sql`
Backfill này cần đọc dữ liệu **cross-DB** (MariaDB `app-customer` ↔ SQL Server `HR`) nên không viết được thành 1 script SQL — phải là **hướng dẫn 2 bước** cho người vận hành.

---

## 3. Bảng — sơ đồ quan hệ chính

```
t_user (1) ──< t_user_bank_account
   │       ──< t_user_device
   │       ──< t_notification
   │       ──< t_user_agreement        >── t_agreement_version
   │       ──< t_apply                 (app_user_id, referral_id → t_user.id)
   │       ──< t_ctv_contract          (1-1, UNIQUE user_id)
   │       ──< t_worker_recruitment_status
   │       ──< timekeep_record         (user_id là VARCHAR!)
   │       ──< t_user_point            (1-1, UNIQUE user_id)
   │       ──< t_point_transaction
   │       ──< t_user_rule_progress
   │       ──< t_gift_redemption
   │
earn_rule (1) ──< rule_condition_group (1) ──< rule_condition
          (1) ──< earn_rule_display_group (1) ──< earn_rule_display_condition
          (n) ──> t_app_router

event_type · logic_operator · system_config · t_gift_price · t_gift_price_history
```

⚠️ **Rất ít FK constraint thật.** Phần lớn quan hệ chỉ là "cột chứa id", ràng buộc do code giữ:
- `t_user_rule_progress.earn_rule_id` / `condition_id` — không FK (vì `MissionEnrollmentService` ghi SQL thô)
- `earn_rule_display_condition.required_earn_rule_id` — không FK (nên phải chặn xoá ở code)
- `t_gift_price.gift_id` — không FK (catalog ở Urbox, không phải bảng nội bộ)
- `timekeep_record.user_id` — `VARCHAR`, chứa cả `t_user.id` lẫn UUID

---

## 4. 🔑 Ba cách lưu UUID trong cùng 1 DB

| Cách | Ở đâu | Ghi chú |
|---|---|---|
| `BINARY(16)` + `@GeneratedValue` | `earn_rule.id`, `rule_condition.id`, `event_type.id`, `display_*` | Gọn, index nhanh; query tay phải `HEX()` |
| `VARCHAR(36)` + `@Type("uuid-char")` | `t_user.customer_id` | Đọc được bằng mắt |
| `VARCHAR(36)` String thuần | `timekeep_record.id` | Sinh bằng `UUID.randomUUID().toString()` ở `@PrePersist` |

🔑 Hệ quả: `MissionEnrollmentService` viết SQL thô phải tự convert:
```java
ps.setBytes(idx++, toBytes(row.getEarnRuleId()));    // UUID → byte[16], MSB trước
```

---

## 5. Các index quan trọng

| Bảng | Index | Vì sao |
|---|---|---|
| `t_user_rule_progress` | UNIQUE `(user_id, condition_id, period_key)` | 🔑 Chống trùng progress + là khoá `ON DUPLICATE KEY` |
| `t_user_point` | UNIQUE `user_id` | 1 dòng / user |
| `t_point_transaction` | `idx_pt_user_id`, `idx_pt_user_created` | Lịch sử điểm phân trang theo user + thời gian |
| `t_gift_redemption` | `idx_gift_redemption_user_id` | Lịch sử đổi quà |
| `timekeep_record` | UNIQUE `hr_timekeep_id` | 🔑 Dedup sync từ CRM |
| `t_user` | UNIQUE `phone`, `customer_id`, `username`, `email` | |
| `t_agreement_version` | (code giữ bất biến `is_current` chỉ 1 dòng) | ⚠️ Không có constraint DB |
| `t_user_agreement` | UNIQUE `(user_id, agreement_version_id)` | Idempotent accept |
| `t_user_device` | UNIQUE `fcm_token` | 1 token = 1 thiết bị |
| `t_gift_price` | UNIQUE `gift_id` | Chỉ giữ giá hiện tại |

---

## 6. `resources/2026_05_13_0001_create_rule_engine_tables.sql`

File SQL **trong `src/main/resources`** (không phải `db/migration/`) — di sản, trùng nội dung với `V002`. Không được load tự động.

---

## 7. Checklist khi thêm bảng/cột mới

Theo `CLAUDE.md`:
1. Tạo file `db/migration/V{n+1}__{action}_{table}.sql` (⚠️ kiểm tra số chưa bị dùng)
2. Sửa/tạo `@Entity` tương ứng
3. Tạo/sửa repository
4. `mvn compile` + `mvn test-compile`
5. `/log-standard` — chuẩn hoá log
6. Metric nếu là luồng quan trọng / gọi 3rd party
7. `/doc-flow` — cập nhật `docs/{module}/`
8. `/versioning` — thêm dòng đầu bảng `CHANGELOG.md`
9. Gộp tất cả vào **1 commit**
10. ⚠️ **Nhớ chạy migration bằng tay khi deploy**

## 8. Hết phần customer-service

→ Kiến thức nền: [`../03-kien-thuc-nen/spring-boot-annotations.md`](../03-kien-thuc-nen/spring-boot-annotations.md)
→ Tra cứu: [`../04-tra-cuu-nhanh/api-index.md`](../04-tra-cuu-nhanh/api-index.md)
→ Ôn tập: [`../05-on-tap/luong-end-to-end.md`](../05-on-tap/luong-end-to-end.md)
