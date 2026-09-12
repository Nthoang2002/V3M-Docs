# Ôn tập — Kể lại các luồng end-to-end

Mục tiêu: **kể lại được bằng lời**, không cần mở code. Mỗi luồng có phần "3 câu tóm tắt" để nhớ nhanh.

---

# LUỒNG 1 — 🔑 Xương sống: hành vi trên app → cộng điểm

## 3 câu tóm tắt
> App bắn event → app-event-service lưu raw rồi dịch tên qua bảng mapping → đẩy lên CDP.
> CDP lưu xong bắn ngược `cdp-behavior-saved`.
> customer-service nhận, dedup, chạy rule engine, cộng điểm + bắn thông báo.

## Chi tiết

```
[1] App: POST /api/events
      { action:"event", name:"nguoi_dung_ung_tuyen_thanh_cong", page, session_id, customer_id }

[2] AppEventController.trackEvent()
      • nhận JsonNode → chấp nhận cả object lẫn array
      • validate THỦ CÔNG (@Valid không chạy trên JsonNode)
      • eventId = UUID do SERVER sinh
      • publish Kafka app-event-topic (key = eventId) → trả 202 Accepted NGAY

[3] AppEventConsumer.consume()
      • deserialize lỗi → NUỐT (tránh poison pill chặn partition)
      • saveEvent lỗi → NÉM LẠI (Kafka giao lại)

[4] AppEventServiceImpl.saveEvent()   @Transactional
      • dedup: existsByEventId
      • lưu PostgreSQL t_app_event (metadata = JSONB)
      • gọi BehaviorForwardService.tryForward()

[5] BehaviorForwardService.tryForward()
      • customerId rỗng? → UserResolutionCache:
            userId --(MariaDB v3m.base_user)--> phone --(PG customer_identity)--> customerId
            (cache 2 chặng, có sentinel __NOT_FOUND__)
      • tra t_behavior_mapping:
            action="event" → match theo `name`
            action="view"  → match theo `page`
        ⇒ behaviorType = "APP_APPLIED"
      ⚠️ KHÔNG khớp = BỎ QUA IM LẶNG (log.info "no mapping")
      • publish Kafka cdp-behavior-topic (key = customerId)
            payload: { customerId, behaviorType, channel:"APP", device, behaviorTime,
                       metadata: "<STRING JSON>" }

[6] cdp-service — lưu customer_behavior → bắn Kafka cdp-behavior-saved

[7] CdpBehaviorSavedConsumer.consume()
      • xử lý JSON có thể BỌC trong String (raw.startsWith("\""))
      • customerId (UUID) → t_user → userId (Long); không có user → skip
      • 🔑 PASSTHROUGH: CustomerEvent.eventType = behavior.behaviorType (KHÔNG dịch)
      • isRewardable(): lọc riêng ATTENDANCE
      • dedup Redis SETNX rule:event:dedup:{userId}:{type}:{phút} TTL 300s

[8] RuleEngineServiceImpl.processEvent()   @Transactional
      • findActiveByTriggerEventType (JOIN FETCH group + earnRule)
      • gom theo earn_rule, xử lý từng rule (try/catch riêng)
      • 3 cổng chặn:
          (a) user đã enroll chưa? (t_user_rule_progress) → chưa thì BỎ
          (b) đã rewarded trong period_key này chưa? → rồi thì BỎ
          (c) chỉ đánh giá hoàn thành khi CÓ condition được cập nhật
      • cập nhật tiến độ theo ruleType: COUNT +1 / SUM +delta / STREAK chuỗi
      • evaluate biểu thức: group1 AND/OR group2 … (TUẦN TỰ, không ưu tiên toán tử)

[9] awardPoints()
      • t_user_point.total_points += earn_rule.point
      • INSERT t_point_transaction (type=EARN)
      • đánh dấu progress kỳ này rewarded = true
      • notifyMissionCompleted()   → try/catch + REQUIRES_NEW (best-effort)
      • enrollUnlockedMissions()   → try/catch (best-effort)
```

## ⚠️ Chuỗi phụ thuộc tên — bẫy lớn nhất
```
app gửi (action, match_value)
   → t_behavior_mapping.behavior_type          [PostgreSQL, repo behavior-events]
   → cdp-behavior-topic → cdp-service → cdp-behavior-saved
   → CustomerEvent.eventType                    [PASSTHROUGH — KHÔNG dịch]
   → rule_condition.trigger_event_type          [MariaDB, repo customer-service]
```
**Một từ vựng, 2 DB, 2 repo, không FK.** Lệch 1 ký tự = nhiệm vụ không bao giờ chạy, không có log lỗi.

---

# LUỒNG 2 — Chấm công

## 3 câu tóm tắt
> App gửi GPS + selfie; server validate đa giác (ray-casting, fail-open nếu chưa cấu hình khu vực) rồi đối chiếu khuôn mặt với ảnh KYC.
> Lưu `timekeep_record` + upload ảnh bằng chứng lên S3 (lỗi upload không chặn chấm công).
> Bắn `ATTENDANCE` lên `cdp-behavior-topic` → vòng lại rule engine để cộng điểm.

```
POST /timekeeping/check { recruitmentId, typeCheck, latitude, longitude, selfieBase64 }
   │
   ├─ (0) resolveCustomerId(userId) — chỉ để bắn CDP; null vẫn chấm được
   │
   ├─ (1) CHECK-IN: kiểm tra ca đang mở (BỎ QUA dòng is_failed — SB-5202)
   │        mở ≥ 16h → tự ghi MISS_CHECKOUT đóng ca cũ
   │        mở < 16h → chặn "Bạn có ca chấm công chưa kết thúc"
   │
   ├─ (2) GPS: areaCacheService.findByRecruitmentId() → GeoUtils.isPointInsidePolygon()
   │        rỗng → FAIL-OPEN (metric result=skipped)
   │        Timer: timekeeping.gps_validation{result=pass|fail|skipped}
   │
   ├─ (3) FACE (chỉ CHECK-IN, bỏ nếu GPS đã fail)
   │        reference = t_user.kyc_face_url (public URL)
   │        EkycProxy.matchingFace() — KHÔNG dùng Unirest (làm hỏng multipart nhị phân)
   │        similarity < 0.6 → isFailed + FACE_MISMATCH
   │
   ├─ (4) CHECK-OUT: tìm relatedCheckinId
   ├─ (5) uploadEvidentImage → S3 public-read, key theo NGÀY trước userId sau
   ├─ (6) save (timekeepingStatus = isFailed ? INVALID : VALID)
   └─ (7) publishAttendanceEvent → Kafka cdp-behavior-topic
```

**Nhánh cộng điểm:** `isRewardable()` chỉ cho qua `CHECKOUT + !isFailed` hoặc `CHECKIN + status=VALID` (admin duyệt). `approve()` bắn lại event khi duyệt.

**Nhánh từ CRM:** `hr-timekeeping-sync-topic` → `HrTimekeepingSyncConsumer` → upsert theo `hr_timekeep_id` (dedup) → chỉ bắn CDP khi **là bản ghi mới**, và `timekeepingStatus = "INVALID"` cứng.

---

# LUỒNG 3 — Đăng ký tài khoản

## 3 câu tóm tắt
> Bước 1: validate + hash mật khẩu + lưu pending vào Redis 15' + gửi OTP.
> Bước 2: verify OTP + GET&DEL pending (Lua nguyên tử) + re-check phone + resolveOrCreate CDP + tạo user + ghi consent.
> CDP lỗi không chặn đăng ký — `CdpBackfillJob` vá sau.

```
[1] POST /auth/send-otp { phone, password(RSA), fullName, referralCode }
      existsByPhone? → 400
      tryAcquireRegisterOtpLock(phone) 5s
      password = BCrypt(RSA.decrypt(password))     🔑 hash NGAY bước 1
      Redis SET auth:register:pending:{uuid} TTL 900s
      otpService.sendRegisterOtp(phone, uuid) → Mobifi

[2] POST /auth/register { uuid, otp, verifyKey }    @Transactional
      verifyRegisterOtp()
      pending = Redis GET+DEL (Lua)                → null: "Phiên đăng ký đã hết hạn"
      RE-CHECK existsByPhone                       🔑 chống race 15 phút
      customerId = cdpCustomerService.resolveOrCreate(phone, fullName, null)
            null (CDP lỗi) → VẪN TẠO USER
      agentSupport = resolveAgentSupport(referralCode, phone)
            (1) tra t_user theo employee_code/phone → kế thừa agent_support
            (2) không ra → hỏi CRM CsUserLookup/AgentSupportByPhone
            mã sai → null, KHÔNG chặn
      save user (source = APP)
      agreementService.accept(userId, null, ipAddress)   🔑 ghi consent luôn
      → AuthResponse { accessToken, refreshToken, ... }
```

---

# LUỒNG 4 — Ứng tuyển (apply)

## 3 câu tóm tắt
> Controller auto-fill hồ sơ từ `t_user`; service resolve người giới thiệu **trước** khi gọi CRM (mã sai = 400 ngay).
> Gọi hr-backend **đồng bộ** trong request, không bọc `@Transactional` quanh HTTP.
> Lưu `t_apply` với `SYNCED` hoặc `FAILED` (FAILED vẫn lưu làm audit, trả message cho user).

```
POST /applies { recruitmentId, ..., referralCode }
   │
   ├─ Controller: auto-fill phone/fullName/email/CCCD/address/genderId/campaignId
   │              validate referralCode ≤ 20 ký tự
   │              auto-fill applyYourself = (referralCode rỗng)
   │
   ├─ Service: resolveReferralId()      🔑 XÉT MÃ TRƯỚC CỜ applyYourself
   │              có mã   → chủ mã (employee_code HOẶC phone); 0 kết quả → 400; >1 → 400
   │              không mã + applyYourself=false (client gửi thật) → appUserId
   │              không mã + applyYourself=true → null
   │
   ├─ agentSupportUserId = t_user.agent_support của người giới thiệu
   ├─ hrBackendClient.createProfile(hrReq, appUserId, creatorPhone)   ← HTTP
   └─ save t_apply: SYNCED + hrProfileId  |  FAILED + failureReason
```

⚠️ **Nếu xét `applyYourself` trước mã**: NLD tự ứng tuyển có nhập mã → thành người giới thiệu của chính mình → **tự ăn hoa hồng**.

---

# LUỒNG 5 — Đổi quà (3 transaction)

## 3 câu tóm tắt
> TX1 (`REQUIRES_NEW`): khoá row `t_user_point` (`FOR UPDATE`), trừ điểm, ghi `REDEEM`, tạo bản ghi PENDING.
> Gọi Urbox **NGOÀI** transaction.
> TX2: thành công → `markSuccess` + lưu voucher; thất bại → `markFailedAndRefund` (hoàn điểm, ghi `REFUND`).

```
POST /gifts/{giftId}/redeem { quantity }
   │
   ├─ gift = giftService.getGifts()  🔑 (đã lọc excluded-gift-types, KHÔNG dùng cache raw)
   ├─ TX1  txService.reserve()   @Transactional(REQUIRES_NEW)
   │     unitPointCost = t_gift_price (chưa cấu hình → 400)
   │     findByUserIdForUpdate(userId)      🔑 PESSIMISTIC_WRITE
   │     đủ điểm? → không → 400
   │     trừ điểm, ghi points_before/after (miễn phí — đang trong biến)
   │     INSERT t_point_transaction (REDEEM, points ÂM)
   │     INSERT t_gift_redemption (PENDING) → transactionId = "%011d" của chính id
   │
   ├─ urboxClient.redeemGift(...)   ← HTTP, ký RSA (ksort → json → SHA256withRSA → base64)
   │
   ├─ thất bại → TX2a markFailedAndRefund()  @REQUIRES_NEW
   │              hoàn điểm + ghi REFUND (points DƯƠNG) + status=FAILED
   │              → ném ValidationException("Đổi quà thất bại: ...")
   │
   └─ thành công → TX2b markSuccess()  @REQUIRES_NEW
                    status=SUCCESS + lưu voucher_codes (serialize lỗi chỉ warn)
```

🔑 **Vì sao tách bean `GiftRedemptionTxService`?** `@Transactional` chạy qua proxy — `this.reserve()` sẽ bỏ qua annotation.
⚠️ Còn thiếu: job đối soát bản ghi kẹt `PENDING` (crash giữa reserve và markSuccess).

---

# LUỒNG 6 — KYC (OCR + face)

## 3 câu tóm tắt
> Bước 1: upload 2 ảnh CCCD lên S3 private, OCR bằng bytes sẵn có, validate bộ ảnh (5 kiểm tra), auto-fill hồ sơ (best-effort).
> Bước 2: kiểm tra sở hữu key (`startsWith("kyc/{userId}/")`), upload selfie public-read, tải ảnh CCCD từ S3, đối chiếu khuôn mặt.
> Khớp → `is_verified = true` + lưu 3 objectKey.

```
[1] POST /profile/kyc/ocr (front, back)
      validateImageFile ×2 (≤10MB, jpg/jpeg/png/heic/webp)
      upload S3 PRIVATE: kyc/{userId}/front_{ts}.jpg, back_{ts}.jpg
      callOcr ×2 (AI code != 0 → 422 với message của AI; FeignException → 502)
      validateCccdSet:  cùng mặt / số CCCD lệch / dob lệch / expire lệch / hết hạn → 400
                        (tolerant: chỉ so khi CẢ 2 mặt có giá trị)
      applyOcrDataToProfile (best-effort, KHÔNG dùng DebuggingDTO vì PII)
      → { frontKey, backKey, ocrFront, ocrBack }

[2] POST /profile/kyc/confirm (frontKey, backKey, face)
      validateKeyOwnership   🔑 chống IDOR bằng prefix
      upload S3 PUBLIC-READ: avatars/{userId}/face_{ts}.jpg
      downloadToBytes(frontKey) → callMatchingFace
      không khớp → 400 "Khuôn mặt không khớp với ảnh trên CCCD"
      khớp → lưu cccdFrontUrl/cccdBackUrl/kycFaceUrl + isVerified = true
```

---

# LUỒNG 7 — Đọc thưởng (proxy có hàng rào)

## 3 câu tóm tắt
> `userId` (JWT) → `IWorkerProfileService.getProfileIds()` (cache Redis 180s, gọi hr-backend bằng **phone** qua header).
> Mọi endpoint nhận `profileId` phải `requireOwnedProfile()` → không thuộc = **403**.
> Gọi hr-backend `CsReward/*ByProfileId`, chuẩn hoá null → empty, đo Timer, lỗi upstream → 502.

```
GET /rewards/mc-bonus?profileId=123
   ├─ profileId null hoặc < 1 → 400
   ├─ requireOwnedProfile(userId, profileId)     🔑 403 nếu không thuộc
   ├─ Timer.start
   ├─ hrBackendClient.fetchMcBonusByProfileId()
   │     HR 400/404 → propagate cùng status
   │     khác       → null → 502
   ├─ chuẩn hoá: bonusRounds null → []
   └─ finally: Timer.stop tag result=success|client_error|fail
```

🔑 **Vì sao phải tự gác?** SB-5043 bỏ `customerId` ⇒ hr-backend **bỏ luôn** kiểm tra `profile ↔ customer`. `profileId` là số tuần tự, dễ đoán, dữ liệu là thu nhập ⇒ IDOR.

---

# LUỒNG 8 — Auto-enroll nhiệm vụ (SB-4815)

## 3 câu tóm tắt
> `processEarnRule` chỉ tính event nếu user đã có bản ghi `t_user_rule_progress` — trước đây chỉ tạo khi bấm "Nhận".
> Nay có 3 nguồn tạo: `accept` (bấm nút), `lazy` (mở app — GET /missions **ghi DB**), `unlock` (vừa hoàn thành nhiệm vụ tiền đề).
> `MissionEnrollmentService` gộp **1 statement** cho cả request, `ON DUPLICATE KEY UPDATE id = id`, sắp thứ tự row, **không** `REQUIRES_NEW`.

```
GET /missions   @Transactional (KHÔNG readOnly)
   ├─ findAllEligible(today) → lọc theo routerCode (mission chưa gắn router LUÔN trả về)
   ├─ allProgress = findAllByUserId → subscribedIds + rewardedIds
   ├─ displayGroups = batch load (LEFT JOIN FETCH)
   ├─ visible = đã subscribe HOẶC isMissionVisible(displayGroups, rewardedIds)
   ├─ lazyRows = mọi visible CHƯA có progress (mọi kỳ)
   └─ enrollmentService.enrollAll(userId, lazyRows, "lazy")   ← 1 STATEMENT
```

**Bốn quyết định của `MissionEnrollmentService` (mỗi cái 1 failure đã reproduce):**
| # | Failure | Fix |
|---|---|---|
| 1 | burst 8 request → 7 cái **500** (`DataIntegrityViolationException` → tx rollback-only) | `ON DUPLICATE KEY UPDATE id = id` |
| 2 | `HikariPool-1 - Connection is not available` | gộp **1 statement** cho cả request |
| 3 | `DeadlockLoserDataAccessException` | **sắp xếp** row theo `(conditionId, periodKey)` |
| 4 | cạn pool | **bỏ** `REQUIRES_NEW` |

Đo lại: 8/16/24/32 request song song đều 200, đúng 21 dòng, 0 exception.

---

# LUỒNG 9 — Cache MD5-version

## 3 câu tóm tắt
> Job 6h fetch từ hr-backend → MD5 JSON → so với hash lưu trong `system_config` (DB).
> Khác → bump version (timestamp ms), ghi Redis data + version, ghi DB hash + version.
> Giống → `SETNX` khôi phục data nếu Redis mất key, **không** bump version. App gọi `/cache/version` để biết có cần tải lại.

---

# 🔑 Bảng: "Best-effort" ở đâu, "fail-closed" ở đâu

| Luồng | Chiến lược | Vì sao |
|---|---|---|
| CDP fetch khi login | fail-soft (log.warn, đi tiếp) | CDP chết không được chặn đăng nhập |
| CDP resolveOrCreate khi đăng ký | fail-soft (`customerId = null`) | Job backfill vá sau |
| GPS chưa cấu hình khu vực | **fail-open** (cho chấm) | Bật validate không được làm hàng loạt vị trí fail |
| Face chưa có ảnh KYC | **fail-open** (cho chấm, admin review) | Worker chưa KYC vẫn phải đi làm |
| Face có ảnh nhưng AI trả null | **fail-closed** (từ chối) | Xác thực danh tính: "không biết" = từ chối |
| Upload ảnh chấm công lỗi | fail-soft (null) | Mất ảnh còn hơn chặn worker |
| Notification lỗi | fail-soft + `REQUIRES_NEW` | Không được rollback việc cộng điểm |
| Auto-enroll unlock lỗi | fail-soft | Như trên |
| Metadata serialize lỗi | fail-soft (warn) | Mất metadata còn hơn mất event |
| `ownsProfile` fail | **fail-closed** (403) | Dữ liệu thu nhập |
| Mã giới thiệu sai lúc **apply** | **fail-closed** (400) | Liên quan tiền hoa hồng, không rollback được |
| Mã giới thiệu sai lúc **đăng ký** | fail-soft (null) | Chỉ là sale phụ trách, admin gán sau được |
| `resolveBank` cache rỗng | **fail-closed** (502) | Lưu bản ghi thiếu tên = hỏng dữ liệu |
| `validateMasterDataId` cache rỗng | fail-open | Chặn hết thì user không sửa được profile |
