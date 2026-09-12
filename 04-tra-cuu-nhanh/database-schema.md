# Tra cứu nhanh — Database Schema

---

# A. behavior-events — PostgreSQL `cdp`, schema `app_event`

## `t_app_event`
| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `event_id` | VARCHAR(36) **UNIQUE** NOT NULL | 🔑 UUID server sinh, khoá dedup |
| `action` | VARCHAR(100) NOT NULL | `"event"` \| `"view"` |
| `page` | VARCHAR(100) NOT NULL | tên màn hình |
| `name` | VARCHAR(100) NOT NULL | tên hành vi |
| `customer_id` | VARCHAR(36) | app v2 gửi sẵn |
| `session_id` | VARCHAR(100) NOT NULL | |
| `user_id` | VARCHAR(50) | app v1 (nullable từ `V002`) |
| `metadata` | **JSONB** | `@ColumnTransformer(write="?::jsonb")` |
| `timestamp` | TIMESTAMP NOT NULL | lúc hành vi xảy ra (client) |
| `created_at` | TIMESTAMP NOT NULL DEFAULT NOW() | lúc server ghi |

Index: `action`, `customer_id`, `user_id`, `timestamp`

## `t_behavior_mapping`
| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `action` | VARCHAR(50) NOT NULL | `event` \| `view` |
| `match_value` | VARCHAR(100) NOT NULL | `name` (nếu event) / `page` (nếu view) |
| `behavior_type` | VARCHAR(100) NOT NULL | 🔑 mã CDP — **phải khớp `event_type.code` bên customer-service** |
| `enabled` | BOOLEAN NOT NULL DEFAULT true | |
| `description` | VARCHAR(255) | |

UNIQUE `(action, match_value)`

## Đọc từ DB khác (chỉ SELECT)
| DB | Bảng | Cột dùng |
|---|---|---|
| MariaDB `v3m` | `base_user` | `id` → `phone_number` |
| PostgreSQL `cdp.public` | `customer_identity` | `identity_value` (phone) → `customer_id` |

---

# B. customer-service — MariaDB `app-customer`

## Nhóm auth / user

### `t_user` — bảng trung tâm
| Nhóm | Cột |
|---|---|
| Định danh | `id` PK · `username` U · `email` U · `phone` U NOT NULL · `customer_id` U (`uuid-char` VARCHAR(36)) |
| Bảo mật | `password` (BCrypt) · `role` (USER/ADMIN) · `status` (ACTIVE/INACTIVE/BLOCKED) |
| Hồ sơ | `full_name` `dob` `gender`(id master-data 7/8/9) `national_id` `issue_date` `issue_place` `address` `address_birth` |
| Hồ sơ mở rộng | `is_married` `literacy_id` `language_ids`(CSV) `ethnic` `address_temporary` `experience` `experience_note` `introduction` |
| KYC | `is_verified` `cccd_front_url` `cccd_back_url` `kyc_face_url` (objectKey S3) |
| KYC staging | `cccd_front_raw` `cccd_back_raw` `kyc_face_raw` (URL từ CRM) |
| CTV/CRM | `employee_code` · **`agent_support`** (AbpUsers.Id) · `ctv_contract_url` |
| Khác | `avatar_path` `favorite_recruitment_ids`(CSV) `cdp_sync_count` `source`(APP/CRM_SYNC) |
| Audit | `created_at` `updated_at` |

### `t_user_bank_account`
`id` PK · `user_id` · `bank_id` `bank_name` `bank_short_name` · `account_number` `account_holder_name` `national_id` · `is_default` · `source`(APP/CRM_SYNC) · `created_at` `updated_at`

## Nhóm agreement
### `t_agreement_version`
`id` PK · `version`(MAJOR.MINOR) · `title` `content`(TEXT) `url` · `effective_date` · **`is_current`** · **`requires_reconsent`** · `created_at` `updated_at`
### `t_user_agreement` (append-only)
`id` PK · `user_id` · `agreement_version_id` · `accepted_version` · `accepted_at` · `ip_address`
UNIQUE `(user_id, agreement_version_id)`

## Nhóm apply / CTV
### `t_apply`
`id` PK · `user_id`(VARCHAR36, legacy customerId) · **`app_user_id`**(t_user.id) · **`referral_id`**(t_user.id người giới thiệu) · `creator_phone` · `recruitment_id` · `hr_profile_id`(AppProfile.Id) · `sync_status`(PENDING/SYNCED/FAILED) · `retry_count` · `payload`(TEXT) · `failure_reason`(TEXT) · `created_at` `updated_at`
### `t_ctv_contract`
`id` PK · `user_id` **UNIQUE** · `registered_at` · `signed_at` · `contract_url` · `status`(PENDING/SIGNED)

## Nhóm timekeeping
### `timekeep_record`
`id`(VARCHAR36 UUID) PK · **`user_id`**(VARCHAR — t_user.id hoặc customerId fallback) · `customer_id` · `profile_id` `recruitment_id` `recruitment_name` · **`type_check`**(1=In 2=Out 4=Missed 5=Auto) · `time_check`(datetime) `time_date`(date) · `is_failed` `failure_reason_code` · `location`(JSON) · `evident_image`(objectKey) · **`timekeeping_status`**(1=Invalid 2=Valid) · `related_checkin_id` · **`hr_timekeep_id`** UNIQUE · `created_at` `updated_at`
### `t_worker_recruitment_status`
`id` PK · `user_id` · `recruitment_id` · `profile_id` · **`job_status`**(1=Working 2=Resigned 3=Available 4=EndWorking) · `changed_at` · `created_at` `updated_at`

## Nhóm rule config
### `earn_rule`
`id` **BINARY(16)** PK · `name` `description` · **`point`** · `reset_period`(NONE/DAILY/WEEKLY/MONTHLY) · `category`(DAILY/WEEKLY/MONTHLY/EVENT/SPECIAL) · `router_id` → `t_app_router` · `start_date` `end_date` · `status`(ACTIVE/INACTIVE) · `created_at` `updated_at`
### `rule_condition_group`
`id` BINARY(16) PK · `earn_rule_id` · `next_operator`(AND/OR) · `sort_order`
### `rule_condition`
`id` BINARY(16) PK · `group_id` · **`trigger_event_type`** · **`rule_type`**(COUNT/SUM/STREAK) · `target_count` · `streak_unit` · `sum_field` · `filter_field` `filter_operator` `filter_value` `filter_value_to` ⚠️(**không được map khi tạo rule**) · `event_type_code` `logic_operator_id`(legacy) · `value` `value_to` · `next_operator` · `sort_order`
### `earn_rule_display_group` / `earn_rule_display_condition`
`id` BINARY(16) · `earn_rule_id`/`group_id` · **`required_earn_rule_id`** · `next_operator` · `sort_order`
### `event_type`
`id` BINARY(16) PK · **`code`** UNIQUE 🔑 · `name` · `type`(EVENT/CUSTOMER_INFO) · `data_type` · `is_active` · `sort_order`
### `logic_operator`
`id` BINARY(16) PK · `event_type_code` · `operator_code` · `operator_label` · `is_active`
### `t_app_router`
`id` INT PK · `code` UNIQUE · `name` `path` `description` · `sort_order` · `is_active` · `created_at`

## Nhóm rule engine
### `t_user_rule_progress`
`id` PK · `user_id` · `earn_rule_id` BINARY(16) · `condition_id` BINARY(16) · **`period_key`** · `current_count` · `completed` `completed_at` · **`rewarded`** · `last_event_date`
🔑 UNIQUE **`uq_user_condition_period` (user_id, condition_id, period_key)**
### `t_user_point`
`id` PK · `user_id` **UNIQUE** · `total_points` · `last_updated_at`
### `t_point_transaction`
`id` PK · `user_id` · **`points`**(dương=cộng, âm=trừ) · `type`(EARN/REDEEM/REFUND) · `earn_rule_id` BINARY(16) · `gift_id` · `note` · `created_at`
Index: `idx_pt_user_id`, `idx_pt_user_created`

## Nhóm gift
### `t_gift_price`
`id` PK · `gift_id` VARCHAR(50) **UNIQUE** (⚠️ chứa **Urbox item id**) · `points` · `created_at` `updated_at`
### `t_gift_price_history` (append-only)
`id` PK · `gift_id` · `old_points`(null=lần đầu) · `new_points` · `changed_by_user_id` · `changed_at`
### `t_gift_redemption`
`id` PK · `user_id` · `gift_id` · `quantity` · `points_cost` · `points_before` `points_after` · `urbox_amount` · `transaction_id` · `campaign_code` · `status`(PENDING/SUCCESS/FAILED) · `urbox_response`(LOB) · `voucher_codes`(LOB JSON) · `failure_reason`(500) · `created_at` `updated_at`
Index: `idx_gift_redemption_user_id`

## Nhóm notification
### `t_notification`
`id` PK · `user_id` · `code` `type` · `title` `content`(TEXT) `url` · `object_id` · `count` · `is_read` · `created_at`
### `t_user_device`
`id` PK · `user_id` · `fcm_token` VARCHAR(500) **UNIQUE** · `platform` · `is_active` · `created_at` `updated_at`

## Nhóm cache
### `system_config`
`config_key` PK VARCHAR(100) · `config_value` TEXT · `updated_at`
Key đang dùng: `master_data.hash/.version` · `recruitment.*` · `company.*` · `news.*` · `gift_brand.*` · `gift.*`

---

# C. 🔑 Ba cách lưu UUID trong cùng 1 DB

| Cách | Ở đâu |
|---|---|
| `BINARY(16)` + `@GeneratedValue` | `earn_rule`, `rule_condition`, `event_type`, `display_*`, `logic_operator` |
| `VARCHAR(36)` + `@Type("uuid-char")` | `t_user.customer_id` |
| `VARCHAR(36)` String thuần | `timekeep_record.id` |

---

# D. Các UNIQUE constraint quan trọng

| Bảng | Constraint | Vai trò |
|---|---|---|
| `t_user_rule_progress` | `(user_id, condition_id, period_key)` | 🔑 `ON DUPLICATE KEY` của auto-enroll |
| `timekeep_record` | `hr_timekeep_id` | 🔑 Dedup sync từ CRM |
| `t_app_event` | `event_id` | 🔑 Dedup Kafka |
| `t_behavior_mapping` | `(action, match_value)` | |
| `t_user_agreement` | `(user_id, agreement_version_id)` | Idempotent accept |
| `t_user_point` | `user_id` | 1 dòng / user |
| `t_gift_price` | `gift_id` | Chỉ giữ giá hiện tại |
| `t_user_device` | `fcm_token` | 1 token = 1 thiết bị |
| `t_user` | `phone`, `customer_id`, `username`, `email` | |
| `t_ctv_contract` | `user_id` | 1 record / user |

---

# E. ⚠️ Quan hệ KHÔNG có FK (ràng buộc do code giữ)

| Quan hệ | Ai giữ |
|---|---|
| `t_user_rule_progress.earn_rule_id`/`condition_id` | Code (vì `MissionEnrollmentService` ghi SQL thô) |
| `earn_rule_display_condition.required_earn_rule_id` | `EarnRuleServiceImpl.delete()` chặn xoá |
| `t_gift_price.gift_id` | Không có bảng gift nội bộ (catalog ở Urbox) |
| `timekeep_record.user_id` | VARCHAR, chứa 2 loại giá trị |
| `t_agreement_version.is_current` chỉ 1 dòng | `versionRepository.clearCurrent()` trong transaction |
| `t_user_bank_account.is_default` chỉ 1 dòng | `setDefault()` |
