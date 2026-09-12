# Tra cứu nhanh — Thuật ngữ & định danh

---

## A. 🔑🔑 Ba định danh — bảng quan trọng nhất

| Định danh | Kiểu | Nguồn | Dùng cho | Có thể null? |
|---|---|---|---|---|
| **`userId`** | `Long` | `t_user.id` — customer-service sinh | 🔑 **Định danh nghiệp vụ chính**. Trong JWT (`sub`), controller lấy qua `@RequestAttribute("userId")` | ❌ luôn có |
| **`customerId`** | `UUID` | CDP (`customer_identity`) | Tra cứu + **khoá Kafka** bắn event sang CDP | ✅ (chưa liên kết CDP) |
| **`profileId`** | `Long` | `AppProfile.Id` bên hr-backend | Khoá đọc **thưởng / hoa hồng / vị trí chấm công** từ CRM | ✅ (chưa có hồ sơ) |

### Lịch sử tiến hoá
```
Ban đầu:  app → customerId → hr-backend            (CDP tham gia nghiệp vụ)
SB-5043:  app → userId → profileId → hr-backend    (CDP RA KHỎI nghiệp vụ)
```
🔑 Sau SB-5043: **CDP chỉ còn để tra cứu + bắn event**, không tham gia nghiệp vụ.

### Các định danh khác
| Tên | Kiểu | Ý nghĩa |
|---|---|---|
| `appUserId` | `Long` | = `userId`. Tên dùng ở `t_apply.app_user_id` và header gửi hr-backend |
| `referralId` | `Long` | 🔑 `t_user.id` của **người giới thiệu** (`t_apply.referral_id`) |
| `agentSupport` | `Long` | 🔑 **`AbpUsers.Id` bên CRM** — sale phụ trách. **Ngoại lệ duy nhất** tham chiếu id CRM trong `t_user` |
| `recruitmentId` | `Integer` | `AppRecruitment.Id` — vị trí tuyển dụng |
| `hrTimekeepId` | `Long` | Id bản ghi chấm công bên CRM (dedup) |
| `eventId` | `String` UUID | Id event behavior (server sinh) |
| `earnRuleId` | `UUID` BINARY(16) | Id nhiệm vụ |
| `conditionId` | `UUID` BINARY(16) | Id điều kiện hoàn thành |
| `giftId` | `String` | ⚠️ Là **Urbox item id**, không phải nhóm sản phẩm |
| `transactionId` | `String` | Mã giao dịch gửi Urbox = `String.format("%011d", redemption.id)` |

---

## B. Thuật ngữ nghiệp vụ

| Thuật ngữ | Nghĩa |
|---|---|
| **NLĐ** | Người lao động — người tìm việc, đi làm, chấm công |
| **CTV** | Cộng tác viên — giới thiệu hồ sơ, nhận hoa hồng. "Là CTV" = có `t_user.ctv_contract_url` |
| **Sale / agent** | Nhân viên CRM phụ trách. `t_user.agent_support` = `AbpUsers.Id` |
| **Hồ sơ (profile)** | `AppProfile` bên CRM — 1 lần ứng tuyển vào 1 vị trí |
| **Vị trí tuyển dụng (recruitment)** | `AppRecruitment` — 1 công việc đang tuyển |
| **Thưởng (reward)** | 💰 **TIỀN** — CRM tính, customer-service chỉ proxy đọc |
| **Điểm (point)** | 🎮 Gamification — customer-service tự tính bằng rule engine |
| **Hoa hồng (incentive)** | 💰 TIỀN cho CTV — CRM tính, lọc theo `hr_profile_id` của hồ sơ đã giới thiệu |
| **Nhiệm vụ (mission / earn rule)** | Cấu hình "làm gì được bao nhiêu điểm" |
| **Enroll** | Tạo bản ghi `t_user_rule_progress` — 🔑 chưa enroll thì event **bị bỏ** |
| **Kỳ (period)** | Chu kỳ lặp nhiệm vụ — `period_key` (`NONE`/`2026-05-15`/`2026-W20`/`2026-05`) |
| **Điều kiện hoàn thành** | `rule_condition_group` → "làm gì thì XONG nhiệm vụ" |
| **Điều kiện hiển thị** | `earn_rule_display_group` → "ai được THẤY nhiệm vụ" (nhiệm vụ tiền đề) |
| **Router** | 1 màn hình app (`t_app_router`) — nơi thực hiện nhiệm vụ |
| **Behavior** | Hành vi người dùng, chuẩn CDP |
| **JobStatus** | Trạng thái làm việc: 1=Working 2=Resigned 3=Available 4=EndWorking |
| **Ca chấm công** | Cặp check-in ↔ check-out. Ca "mở" = có check-in chưa có check-out |
| **Missed checkout** | Quên check-out (`type_check=4`) |
| **Auto checkout** | Hệ thống tự đóng ca (`type_check=5`) |

---

## C. Bảng mã số

### `type_check` (timekeep_record)
| Mã | Nghĩa |
|---|---|
| 1 | Check-in |
| 2 | Check-out |
| 4 | Missed (quên check-out) |
| 5 | Auto (hệ thống tự đóng) |

### `timekeeping_status`
| Mã | Nghĩa |
|---|---|
| 1 | Invalid (chưa/không hợp lệ) |
| 2 | Valid (admin đã duyệt) |

### `job_status` (khớp `GlobalConst.JobStatus` bên hr-backend)
| Mã | Nghĩa |
|---|---|
| 1 | Working — Đang làm |
| 2 | Resigned — Đã nghỉ việc |
| 3 | Available — Khả dụng (mặc định khi chưa có bản ghi) |
| 4 | EndWorking — Đã kết thúc |

### `gender` — 🔑 id master-data CRM (SB-4257)
| Mã | Nghĩa |
|---|---|
| 7 | Nam (M) |
| 8 | Nữ (F) |
| 9 | Khác (O) |
⚠️ hr-backend gửi qua `BaseUserInfo.Gender` theo quy ước **app v1**: `F`→1, `M`→2, khác→0. Phải map (`mapHrGenderToMasterDataId`).

### `attendanceType` (metadata event ATTENDANCE)
`CHECKIN` · `CHECKOUT` · `MISSED` · `AUTO` · `UNKNOWN`

### `channel` (event CDP)
`APP` (từ app / customer-service) · `HR_SYNC` (từ CRM)

### Trạng thái chi trả hoa hồng
1 = Tạm tính · 2 = Chờ chi · 3 = Đã chi

---

## D. Enum trong code

| Enum | Giá trị |
|---|---|
| `UserRole` | `USER`, `ADMIN` |
| `UserStatus` | `ACTIVE`, `INACTIVE`, `BLOCKED` |
| `UserSource` | `APP`, `CRM_SYNC` |
| `SyncStatus` (apply) | `PENDING`, `SYNCED`, `FAILED` |
| `CtvContractStatus` | `PENDING`, `SIGNED` |
| `GiftRedemptionStatus` | `PENDING`, `SUCCESS`, `FAILED` |
| `TransactionType` | `EARN`, `REDEEM`, `REFUND` |
| `RuleStatus` | `ACTIVE`, `INACTIVE` |
| `ResetPeriod` | `NONE`, `DAILY`, `WEEKLY`, `MONTHLY` |
| `MissionCategory` | `DAILY`, `WEEKLY`, `MONTHLY`, `EVENT`, `SPECIAL` |
| `RuleType` | `COUNT`, `SUM`, `STREAK` |
| `StreakUnit` | `DAY`, `WEEK`, `MONTH` |
| `OperatorCode` | `EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN` |
| `LogicalOperator` | `AND`, `OR` |
| `DataType` | `NUMBER BOOLEAN STRING DATE CHECKLIST` |
| `EventTypeCategory` | `EVENT`, `CUSTOMER_INFO` |
| `EventResponseStatus` (behavior-events) | `ACCEPTED`, `FAILED` |
| `FcmSendResult` | `SUCCESS`, `TOKEN_UNREGISTERED`, `FAILED` |
| `PointHistoryDirection` | `ALL`, `EARNED`, `SPENT` |

---

## E. `behavior_type` / `event_type.code` — 🔑 từ vựng dùng chung

⚠️ **Cùng một từ vựng, ở 2 DB khác nhau, 2 repo khác nhau, KHÔNG có ràng buộc kỹ thuật.**
Lệch 1 ký tự = nhiệm vụ không bao giờ chạy, **không có log lỗi**.

### Từ app (seed `V003` bên behavior-events)
| `behavior_type` | Nguồn |
|---|---|
| `APP_APPLIED` | `nguoi_dung_ung_tuyen_thanh_cong` |
| `APP_CLICK_APPLY` | `nguoi_dung_bam_ung_tuyen` |
| `APP_VIEW_JOB` | `nguoi_dung_vao_xem_chi_tiet_cong_viec` / page `DetailJobPage` |
| `APP_VIEW_APPLY` | page `CreateLeadPage` |
| `APP_VIEW_CHECKIN` | page `CheckInPage`, `CheckInTabPage` |
| `APP_VIEW_HOUSING` | page `AshHousePage`, `AshHouseDetailPage` |
| `APP_VIEW_REWARD` | page `AllRewardScreen` |
| `APP_BROWSE_JOBS` | page `JobPage` |

### Bộ nhiệm vụ (seed `V004` bên behavior-events)
| `behavior_type` | Nguồn |
|---|---|
| `REGISTER` | `nguoi_dung_tao_tai_khoan_thanh_cong` |
| `PROFILE_COMPLETE` | `nguoi_dung_hoan_tat_thong_tin_bo_sung` |
| `KYC_VERIFIED` | `nguoi_dung_xac_thuc_cccd_thanh_cong` |
| `BANK_ACCOUNT_ADDED` | `nguoi_dung_them_tai_khoan_ngan_hang` |
| `CTV_CONTRACT_SIGNED` | `nguoi_dung_ky_hop_dong_ctv` |
| `NLD_REGISTERED` | `nguoi_dung_dang_ky_nld` |
| `REFERRAL_CREATED` | `nguoi_dung_gioi_thieu_ho_so_thanh_cong` |
| `REFERRAL_INTERVIEW_PASSED` | `ho_so_gioi_thieu_phong_van_dat` (từ CRM) |
| `REFERRAL_WORKING` | `ho_so_gioi_thieu_di_lam` (từ CRM) |
| `DAILY_LOGIN` | điểm danh trên app |

### Từ customer-service (producer trực tiếp)
| `behavior_type` | Nguồn |
|---|---|
| `ATTENDANCE` | `TimekeepServiceImpl.publishAttendanceEvent()` + `HrTimekeepingSyncConsumer.publishToCdp()` |

⚠️ Theo `CHANGELOG` (SB-4815): còn **10 code** trong `event_type` **chưa có producer** (nhiệm vụ sẽ đứng ở 0), và 2 code `LOGIN`/`PURCHASE` **đang được rule trỏ tới nhưng không tồn tại** trong `event_type` → rule chết.

---

## F. Tên hệ thống ngoài

| Tên | Là gì |
|---|---|
| **hr-backend** | CRM (C#/.NET, ABP framework). SQL Server. Sở hữu `AppProfile`, `AppRecruitment`, `AbpUsers` |
| **CDP** (`cdp-service`) | Customer Data Platform. PostgreSQL. `customer_behavior`, `customer_identity` |
| **v3m-core-service** | Hệ Java **cũ** (app v1), đang được customer-service thay thế |
| **sync-data-crm** | Job đồng bộ CRM → app |
| **Urbox** | Đối tác voucher/quà tặng |
| **EKYC AI Mobifi** | Dịch vụ OCR CCCD + đối chiếu khuôn mặt |
| **Mobifi OTP** | Dịch vụ gửi OTP SMS |
| **FPT Object Storage** | S3-compatible (nền Ceph) |
| **Zuul** | API Gateway |
| **Eureka** | Service discovery |
| **Config Server** | Spring Cloud Config — cấu hình tập trung |

---

## G. Từ viết tắt kỹ thuật

| Viết tắt | Nghĩa |
|---|---|
| **IDOR** | Insecure Direct Object Reference — đổi id để xem dữ liệu người khác |
| **SSRF / LFI** | Server-Side Request Forgery / Local File Inclusion |
| **PII** | Personally Identifiable Information — dữ liệu định danh cá nhân |
| **S2S** | Server-to-server (auth bằng api-key, không có user) |
| **MRZ** | Machine Readable Zone — dải mã máy đọc mặt sau CCCD |
| **DLQ** | Dead Letter Queue — hàng đợi chứa message xử lý thất bại |
| **N+1** | Vấn đề 1 query danh sách + N query chi tiết |
| **GitOps** | Deploy bằng cách commit vào repo Helm, không `kubectl apply` |
| **Strangler Fig** | Pattern thay hệ cũ dần bằng cách giữ contract, thay ruột |
