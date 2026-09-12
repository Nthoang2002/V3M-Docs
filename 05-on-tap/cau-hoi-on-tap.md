# Ôn tập — Bộ câu hỏi tự kiểm tra

Cách dùng: **che phần đáp án, tự trả lời bằng lời trước**, rồi mới đối chiếu. Đáp án có link tới doc chi tiết.

---

# A. Kiến trúc tổng thể

<details><summary><b>A1. Vẽ lại sơ đồ hệ thống V3M — có bao nhiêu service, ai nói chuyện với ai?</b></summary>

2 service Java trong scope: `app-event-service` (behavior-events) và `customer-service`.
Bên ngoài: hr-backend (CRM, C#), cdp-service, v3m-core-service (hệ cũ), sync-data-crm, Gateway Zuul, Eureka, Config Server.
App → Gateway → 2 service. behavior-events → Kafka → cdp-service. customer-service ↔ Feign hr-backend/CDP/Urbox/EKYC/OTP/FCM/S3.
→ [`../00-tong-quan-he-thong.md`](../00-tong-quan-he-thong.md)
</details>

<details><summary><b>A2. Kể tên 6 Kafka topic và nhớ đúng chiều producer/consumer.</b></summary>

| Topic | Producer | Consumer |
|---|---|---|
| `app-event-topic` | app-event-service | app-event-service |
| `cdp-behavior-topic` | app-event-service + customer-service + hr-backend | cdp-service |
| `cdp-behavior-saved` | cdp-service | customer-service |
| `cdp-transaction-topic` | hr-backend | cdp-service |
| `rule-events` | hệ C# | customer-service |
| `hr-timekeeping-sync-topic` | hr-backend | customer-service |

`cdp-behavior-topic` là **cửa duy nhất** vào CDP (3 producer). cdp-service là source of truth.
</details>

<details><summary><b>A3. 🔑 Phân biệt userId / customerId / profileId.</b></summary>

- `userId` (`Long`, `t_user.id`) — **định danh nghiệp vụ chính**, trong JWT, luôn có.
- `customerId` (`UUID`, CDP) — chỉ để tra cứu + làm khoá Kafka bắn event. Có thể null.
- `profileId` (`Long`, `AppProfile.Id` bên CRM) — khoá đọc thưởng/hoa hồng/vị trí chấm công.

SB-5043 đổi khoá map từ `customerId` sang `profileId` ⇒ CDP ra khỏi nghiệp vụ.
→ [`../04-tra-cuu-nhanh/glossary.md`](../04-tra-cuu-nhanh/glossary.md)
</details>

<details><summary><b>A4. Phân biệt "thưởng" và "điểm".</b></summary>

- **Thưởng (reward/incentive)** = TIỀN, do CRM tính, customer-service chỉ **proxy có hàng rào**.
- **Điểm (point)** = gamification, customer-service **tự tính** bằng rule engine, đổi được quà Urbox.
</details>

---

# B. behavior-events

<details><summary><b>B1. Vì sao controller không ghi thẳng DB mà đẩy qua Kafka?</b></summary>

Kafka làm **buffer**: app không phải chờ DB (latency thấp), DB down thì event vẫn nằm trong Kafka.
Đánh đổi: eventually consistent — client nhận 202 "đã nhận", không phải "đã lưu". Chấp nhận vì đây là analytics.
</details>

<details><summary><b>B2. Vì sao `eventId` do server sinh?</b></summary>

Dùng làm (1) Kafka key, (2) khoá dedup ở `saveEvent` + UNIQUE ở DB. Client sinh thì có thể gửi trùng/gửi bậy.
</details>

<details><summary><b>B3. Endpoint `/api/events` nhận cả object lẫn array — hệ quả gì?</b></summary>

Body khai `JsonNode` ⇒ `@Valid` **không chạy** ⇒ phải validate thủ công bằng `javax.validation.Validator`.
Và validate là all-or-nothing (1 event sai → cả mảng 400), nhưng publish thì mỗi event độc lập.
</details>

<details><summary><b>B4. 🔑 `AppEventConsumer` có 3 nhánh xử lý lỗi — kể ra và giải thích.</b></summary>

1. Deserialize fail → **nuốt + return** (commit offset). Lỗi vĩnh viễn, ném ra sẽ lặp vô hạn ⇒ **poison pill chặn cả partition**.
2. Thiếu `eventId`/`action` → **nuốt**. Như trên.
3. `saveEvent` fail → **ném lại**. Lỗi tạm thời (DB down) ⇒ không commit offset ⇒ Kafka giao lại.
</details>

<details><summary><b>B5. `BehaviorForwardService` chọn `matchValue` thế nào?</b></summary>

`action = "event"` → match theo `name`. Khác (thực tế `"view"`) → match theo `page`.
Tra bảng `t_behavior_mapping` bằng khoá ghép `action:matchValue`.
</details>

<details><summary><b>B6. ⚠️ Ba lý do event bị bỏ, không forward lên CDP?</b></summary>

1. Không có `customerId` **và** không có `userId` (warn)
2. Có `userId` nhưng không resolve ra `customerId` (warn)
3. **Không khớp mapping** (chỉ `log.info` — im lặng nhất, khó phát hiện nhất)

Debug: `grep "Behavior forward skipped"`.
</details>

<details><summary><b>B7. `UserResolutionCache` dùng sentinel `__NOT_FOUND__` để làm gì? Nhược điểm?</b></summary>

**Negative caching** — nhớ "đã tra rồi, không có" để không query DB lặp lại cho userId không tồn tại.
Nhược: user tạo **sau** lần tra đầu sẽ mãi bị coi là không tồn tại **đến khi restart pod**. Cache không TTL, không giới hạn size.
</details>

<details><summary><b>B8. `@ColumnTransformer(write = "?::jsonb")` để làm gì?</b></summary>

Cột DB là `jsonb`, Java field là `String`. JDBC gửi String → PostgreSQL báo lỗi kiểu. Annotation này sinh SQL `VALUES (?::jsonb)` — cast ngay trong câu SQL.
</details>

---

# C. Security & Exception

<details><summary><b>C1. ⚠️ `/admin/**` nằm ở đâu trong `SecurityConfig`? Hệ quả?</b></summary>

Nằm trong **`PUBLIC_URLS`** ⇒ permitAll. Vì thế endpoint admin thật phải đặt ở path khác (`/gift-redemptions/**`, `/users/**`, `/earn-transactions/**`, `/gift-price-history/**`) rồi khai `hasRole("ADMIN")`.
Ngoại lệ an toàn duy nhất dưới `/admin/`: `POST /admin/cache/refresh` có `@PreAuthorize` ở tầng method.
</details>

<details><summary><b>C2. `JwtAuthFilter` có chặn request không? Ai chặn?</b></summary>

**Không chặn** — nó chỉ cố set authentication rồi `filterChain.doFilter()`. Việc chặn do `FilterSecurityInterceptor` theo cấu hình `SecurityConfig`.
Filter set `request.setAttribute("userId", userId)` — controller đọc qua `@RequestAttribute("userId")`.
</details>

<details><summary><b>C3. 🔑 Kể lại bug SB-4842 về thứ tự kế thừa exception.</b></summary>

`MissingServletRequestParameterException` **kế thừa** `ServletRequestBindingException`. Handler 401 (thêm ở SB-4902 cho `@RequestAttribute` thiếu) nằm ở lớp cha ⇒ thiếu query param bị trả **401 "Yêu cầu đăng nhập"** dù JWT hợp lệ.
Tác hại: app đi refresh token vô ích rồi lặp lại lỗi cũ; người debug bị dẫn sai hướng.
Cùng họ: `MethodArgumentTypeMismatchException` không handler nào bắt → catch-all → **500**.
Fix: tách handler riêng cho cả 2 → 400.
🔑 Verify phải bằng **service chạy thật** — unit test gọi handler trực tiếp không chứng minh được Spring chọn handler nào.
</details>

<details><summary><b>C4. Vì sao trả 403 chứ không 404 khi `profileId` không thuộc user?</b></summary>

404 tiết lộ "id này tồn tại, chỉ không phải của bạn" ⇒ enumerate được. 403 cho mọi trường hợp thì không phân biệt.
</details>

<details><summary><b>C5. Khi nào dùng 502, khi nào 500?</b></summary>

502 = lỗi **upstream** (hr-backend/Urbox/EKYC lỗi hoặc timeout) — client thử lại được, alert biết là sự cố đối tác.
500 = lỗi của chính mình, chưa lường trước (catch-all).
</details>

<details><summary><b>C6. Vì sao `RedisTokenService` dùng Lua script cho GET+DEL?</b></summary>

**Nguyên tử**. Nếu tách 2 lệnh, 2 request đồng thời đều GET thành công trước khi DEL ⇒ cùng 1 `tokenOtp` đổi được mật khẩu 2 lần. Redis chạy Lua single-threaded.
</details>

<details><summary><b>C7. Vì sao lưu refresh token 2 chiều trong Redis?</b></summary>

`logout(userId)` cần `uid → token`; `refresh(token)` cần `token → uid`. Hai nhu cầu ngược chiều.
</details>

---

# D. Rule engine (quan trọng nhất)

<details><summary><b>D1. 🔑 `processEarnRule` có 3 cổng chặn — kể ra.</b></summary>

1. `existsByUserIdAndEarnRuleId` — user chưa enroll ⇒ **event bị bỏ** (gốc rễ của auto-enroll)
2. `rewarded == true` trong `period_key` này ⇒ bỏ
3. Chỉ gọi `checkAndAwardEarnRule` khi **có** condition được cập nhật
</details>

<details><summary><b>D2. `period_key` sinh thế nào? Vì sao dùng `IsoFields.WEEK_BASED_YEAR`?</b></summary>

`NONE` / `2026-05-15` (DAILY) / `2026-W20` (WEEKLY) / `2026-05` (MONTHLY).
`WEEK_BASED_YEAR` chứ không `getYear()` vì tuần cuối tháng 12 có thể thuộc **tuần 1 của năm sau** theo ISO-8601.
Cơ chế: kỳ mới → key mới → dòng progress mới → làm lại được. **Không cần job reset.**
</details>

<details><summary><b>D3. STREAK xử lý 3 tình huống nào?</b></summary>

- Cùng kỳ → **không tăng**
- Kỳ liền kề → `+1`
- Cách quãng → **reset về 1** (không phải 0, vì hôm nay vẫn tính)
</details>

<details><summary><b>D4. ⚠️ `A AND B OR C` được tính thế nào?</b></summary>

`((A AND B) OR C)` — **tuần tự trái→phải, KHÔNG có độ ưu tiên toán tử**. Đơn giản hoá có chủ ý (admin không phải nhập ngoặc).
</details>

<details><summary><b>D5. 🔑🔑 Kể lại 4 quyết định của `MissionEnrollmentService` và failure tương ứng.</b></summary>

| # | Failure đo được | Fix |
|---|---|---|
| 1 | burst 8 request → **7 cái 500** (`saveAll` ném `DataIntegrityViolationException`, Hibernate mark **rollback-only**) | `ON DUPLICATE KEY UPDATE id = id` |
| 2 | `HikariPool-1 - Connection is not available, timed out after 30000ms` (15 statement × tx riêng = 2 conn × 15 lượt) | **1 statement** cho cả request |
| 3 | `DeadlockLoserDataAccessException` | **sắp xếp** row theo `(conditionId, periodKey)` |
| 4 | cạn pool | **bỏ** `REQUIRES_NEW` (tx riêng luôn cần conn thứ 2) |

Đo lại: 8/16/24/32 request song song đều 200, đúng 21 dòng, 0 exception.
🔑 **Không bắt exception** vì trong cùng transaction, `catch` không cứu được (tx đã rollback-only).
</details>

<details><summary><b>D6. Ba nguồn tạo `t_user_rule_progress` là gì?</b></summary>

`accept` (bấm nút) · `lazy` (`GET /missions` — endpoint GET **ghi DB**) · `unlock` (vừa hoàn thành nhiệm vụ tiền đề).
Metric: `mission.auto_enroll{source, result}`.
</details>

<details><summary><b>D7. Vì sao `acceptMission` nay idempotent?</b></summary>

Sau SB-4815, progress được tạo tự động (lazy + unlock) ⇒ nếu vẫn ném "Đã nhận rồi" thì nút "Nhận" trên app **luôn báo lỗi**.
Nhưng vẫn **gate server-side** điều kiện hiển thị — không tin client đã ẩn mission.
</details>

<details><summary><b>D8. Điều kiện HOÀN THÀNH vs điều kiện HIỂN THỊ khác nhau thế nào?</b></summary>

| | Hoàn thành (`rule_condition_group`) | Hiển thị (`earn_rule_display_group`) |
|---|---|---|
| Câu hỏi | "Làm gì thì XONG?" | "Ai được THẤY?" |
| Dựa trên | Event Kafka (`trigger_event_type`) | Nhiệm vụ tiền đề đã `rewarded` |
| Rỗng nghĩa là | Bị chặn ở validate | **Hiển thị cho tất cả** |
</details>

<details><summary><b>D9. Chống chu trình phụ thuộc điều kiện hiển thị thế nào?</b></summary>

DFS (`reachesTarget`) theo cạnh `requiredEarnRuleId` trong DB, có `visited` chống lặp vô hạn.
Chỉ kiểm tra khi **update** (create thì rule chưa tồn tại nên không ai phụ thuộc).
Nếu có chu trình: cả nhóm nhiệm vụ **không bao giờ hiển thị được cho ai**.
</details>

---

# E. Chấm công

<details><summary><b>E1. 🔑 Vì sao `GeoUtils` port nguyên semantics từ C# thay vì dùng thư viện Java?</b></summary>

Để customer-service và CRM cho **cùng kết quả trên cùng dữ liệu**. Lệch ở biên (điểm trên cạnh, trùng đỉnh, cạnh ngang) ⇒ worker chấm đúng ranh giới được CRM chấp nhận nhưng app từ chối.
Có `GeoUtilsCrossCheckTest` đối chiếu vector chuẩn.
</details>

<details><summary><b>E2. Chưa cấu hình khu vực thì sao? Khác gì hr-backend?</b></summary>

**Fail-open** — vẫn cho chấm công, metric `result=skipped`. Khác hr-backend v2 (fail-closed). Chủ ý: bật validate không được làm hàng loạt vị trí thiếu cấu hình fail đồng loạt.
</details>

<details><summary><b>E3. ⚠️ Kể lại bug SB-5202.</b></summary>

Bản ghi chấm **thất bại** vẫn lưu với `type_check = 1`. Mọi chỗ hỏi "ca đang mở" lấy bản ghi gần nhất ⇒ dòng failed bị hiểu là ca chưa đóng ⇒ worker bị chặn, `getCheckStatus` trả sai.
Fix: query mới bỏ hẳn dòng failed (`IsFailedFalse`), áp dụng ở **cả 5 chỗ**, và **xoá query cũ** khỏi repository.
🔑 Vì sao "bỏ qua" đúng hơn "xem gần nhất có failed không": đang mở ca thật rồi chấm lỗi 1 phát thì bản ghi hợp lệ gần nhất **vẫn là ca đang mở** → vẫn chặn đúng.
</details>

<details><summary><b>E4. ⚠️ Bug Unirest với ảnh nhị phân — kể lại cách debug.</b></summary>

Triệu chứng: AI trả similarity thấp bất thường. Kiểm tra MD5 bytes tải về → **khớp** ảnh gốc. Gửi cùng ảnh qua `curl`/Feign → bình thường.
⇒ Vấn đề ở **tầng vận chuyển** (Unirest encode multipart sai), không phải dữ liệu hay thuật toán AI.
Fix: dùng chung `EkycProxy` (Feign + `SpringFormEncoder`).
</details>

<details><summary><b>E5. Khi nào ATTENDANCE được cộng điểm?</b></summary>

`isRewardable()`: `CHECKOUT + !isFailed` **hoặc** `CHECKIN + timekeepingStatus=VALID` (admin duyệt).
`MISSED`/`AUTO`/`UNKNOWN` → không.
Bản ghi sync từ CRM luôn `timekeepingStatus = "INVALID"` cứng ⇒ phải qua duyệt.
</details>

<details><summary><b>E6. Vì sao objectKey ảnh chấm công đặt NGÀY trước userId?</b></summary>

Vận hành thao tác theo mốc thời gian (lifecycle rule dọn theo prefix ngày, archive 1 khoảng ngày, ước lượng dung lượng/ngày). Để userId trước thì mọi việc đó phải **quét toàn bucket**.
</details>

---

# F. Cache & Redis

<details><summary><b>F1. 🔑 Kể 4 pattern cache và bài toán mỗi cái giải.</b></summary>

1. **MD5-hash + version, không TTL** — dữ liệu lớn ít đổi, app cần biết "có gì mới không"
2. **Cache-aside TTL ngắn** — truy cập lẻ theo id
3. **Spring `@Cacheable`** — chỉ cần "nhớ N giây"
4. **Derived cache** — cắt payload 564KB thành nhiều key nhỏ theo `recruitmentId`
</details>

<details><summary><b>F2. Vì sao hash/version lưu ở DB mà data lưu ở Redis?</b></summary>

Redis là cache **có thể mất**. Hash/version là **trạng thái**, phải bền — restart Redis không làm version nhảy lung tung.
Khi hash giống: `SETNX` khôi phục data **mà không bump version** (app không tải lại vô ích).
</details>

<details><summary><b>F3. Vì sao "không negative-cache"? Ngoại lệ ở đâu?</b></summary>

hr-backend lỗi tạm thời trả `[]`, cache lại thì worker thấy rỗng suốt TTL dù dữ liệu đã đúng.
**Ngoại lệ có lý do**: `RecruitmentAreaCacheServiceImpl` cache cả list rỗng — vì rỗng ở đó là **cấu hình thật** (ổn định), không phải lỗi tạm thời; và không cache thì mỗi lần check-in phải deserialize 564KB.
</details>

<details><summary><b>F4. Dedup rule engine dùng khoá gì? Đánh đổi?</b></summary>

`SETNX rule:event:dedup:{userId}:{eventType}:{phút}` TTL 300s, dùng `occurredAt` (không phải `now()`).
Không dùng eventId vì CDP **không gửi eventId** trong payload behavior.
⚠️ Đánh đổi: 2 hành vi **thật** cùng loại trong 1 phút chỉ tính 1.
⚠️ Tương tác với retry: dedup ghi **trước** khi xử lý ⇒ `processEvent` fail rồi Kafka giao lại thì bị dedup chặn ⇒ event bị bỏ.
</details>

---

# G. Transaction & Spring

<details><summary><b>G1. 🔑 Kể 3 chỗ trong dự án phải tách bean riêng vì proxy AOP.</b></summary>

- `UserSyncItemService` — `@Transactional(REQUIRES_NEW)`, mỗi user 1 tx
- `GiftRedemptionTxService` — `@Transactional(REQUIRES_NEW)`, hoàn điểm không bị cuốn theo rollback
- `FcmDispatchService` — `@Async`

Lý do chung: `this.method()` **không qua proxy** ⇒ annotation vô tác dụng.
</details>

<details><summary><b>G2. Vì sao `MissionEnrollmentService` TỪ CHỐI dùng `REQUIRES_NEW`?</b></summary>

`REQUIRES_NEW` **luôn cần connection thứ 2** ⇒ mỗi request giữ 2 connection ⇒ cạn Hikari pool khi burst.
Chạy trong tx của caller: mỗi request 1 connection, và enroll ở nhánh unlock rollback cùng việc cộng điểm nếu fail.
</details>

<details><summary><b>G3. 🔑 Vì sao "trong cùng transaction, catch không cứu được"?</b></summary>

Khi `RuntimeException` thoát khỏi 1 method `@Transactional`, Spring/Hibernate đã đánh dấu tx `rollback-only`. Bắt exception ở tầng ngoài không xoá được dấu đó — lúc commit sẽ ném `UnexpectedRollbackException`.
Muốn "lỗi ở A không ảnh hưởng B" thì phải **tách transaction**, không phải `try/catch`.
</details>

<details><summary><b>G4. Kể 3 cách chống N+1 dùng trong dự án.</b></summary>

1. `JOIN FETCH` (+ `LEFT JOIN FETCH`, `DISTINCT`)
2. **Batch load + Map** — `findAllById(distinctIds)` rồi tra `Map` (dùng nhiều nhất)
3. `FetchType.EAGER` khi quan hệ many-to-one tới bảng nhỏ và **luôn** được dùng (`earn_rule.router`)
</details>

<details><summary><b>G5. Vì sao `update()` earn_rule dùng `clear()` + `addAll()` chứ không `setGroups()`?</b></summary>

Hibernate theo dõi **chính đối tượng collection**. Gán list mới làm mất tracking ⇒ `A collection with cascade="all-delete-orphan" was no longer referenced`.
⚠️ Hệ quả nghiệp vụ: `rule_condition.id` đổi mỗi lần update ⇒ `t_user_rule_progress.condition_id` mồ côi ⇒ tiến độ user reset.
</details>

<details><summary><b>G6. Khoá pessimistic dùng ở đâu? Vì sao không dùng ở `awardPoints`?</b></summary>

Chỉ 1 chỗ: `findByUserIdForUpdate` trong `GiftRedemptionTxService.reserve()` — chống double-spend điểm.
`awardPoints` không dùng vì: tranh chấp hiếm (2 event cùng user đồng thời), đã có dedup Redis, và không muốn ảnh hưởng luồng rule engine (comment repository ghi rõ).
</details>

---

# H. Tích hợp & vận hành

<details><summary><b>H1. Vì sao hr-backend có tới 3 Feign proxy?</b></summary>

3 cơ chế auth khác nhau: Basic Auth (`HrDataProxy`, header `partner` chữ thường) · api-key S2S (`HrBackendProxy`, header `Partner` chữ HOA, một số endpoint không gửi) · JWT user (`HrAppAuthProxy`).
</details>

<details><summary><b>H2. `MultipartFeignConfig` có 3 bean — mỗi bean giải quyết gì?</b></summary>

1. `SpringFormEncoder` — encoder mặc định không biết encode `MultipartFile`
2. Timeout **30s** — xử lý ảnh chậm hơn API JSON
3. `Decoder` tự viết — AI **trả `Content-Type: application/octet-stream` dù body là JSON**, decoder mặc định từ chối
</details>

<details><summary><b>H3. 🔑 Vì sao đổi từ `lookup + create` sang `ResolveOrCreate` 1 lượt gọi?</b></summary>

Race condition: 2 request đồng thời cùng SĐT đều lookup không thấy → đều create → **customer trùng**.
Fix: đẩy cả 2 bước sang **1 API nguyên tử của bên sở hữu dữ liệu**.
🔑 Nguyên tắc: check-then-act qua mạng **luôn** có race.
</details>

<details><summary><b>H4. ⚠️ `CdpBackfillJob` — vì sao query nguồn phải lọc `phone IS NOT NULL`?</b></summary>

Job luôn lấy `PageRequest.of(0, batchSize)`. User thiếu phone **không bao giờ resolve được** ⇒ đứng đầu page 0 vĩnh viễn ⇒ chiếm hết slot ⇒ **user hợp lệ phía sau bị đói (starve)**.
</details>

<details><summary><b>H5. Cơ chế `cdp_sync_count` hoạt động thế nào?</b></summary>

"Hàng đợi nghèo": `updateProfile` set về `0`; job quét `< 2`; mỗi lần sync `+1` ⇒ mỗi lần sửa profile được đẩy sang CDP **2 lần** rồi dừng. Mặc định entity = `2` (không cần sync).
</details>

<details><summary><b>H6. CI lấy version từ đâu?</b></summary>

Từ **commit message** dạng `#1.2.3# SB-1234: mô tả` (script bash tách theo dấu `#`), **không** từ `pom.xml`.
Deploy = clone repo Helm, `sed` đổi image tag trong `values.yaml`, commit, push (**GitOps**).
</details>

<details><summary><b>H7. Vì sao 3 flag S3 phải tắt?</b></summary>

- `pathStyleAccessEnabled(true)` — FPT (Ceph) không hỗ trợ virtual-host style
- `checksumValidationEnabled(false)` — SDK ký kèm `x-amz-te` vào presigned GET mà browser không gửi → **403 SignatureDoesNotMatch**
- `chunkedEncodingEnabled(false)` — nhiều S3-compat không nhận `aws-chunked` khi PUT
</details>

---

# I. Bảo mật

<details><summary><b>I1. 🔑 Kể 3 chỗ chống IDOR trong dự án.</b></summary>

1. `/rewards/*?profileId=` → `requireOwnedProfile()` → 403
2. `/profile/kyc/confirm` (`frontKey`) → `validateKeyOwnership()` (`startsWith("kyc/{userId}/")`) → 403
3. `/incentives/*` → **không nhận `profileIds` từ client**, dựng server-side từ JWT
</details>

<details><summary><b>I2. Bài học "bỏ một thứ ở A làm mất lá chắn ở B" là gì?</b></summary>

SB-5043 bỏ `customerId` khỏi lời gọi hr-backend. `customerId` trông chỉ là tham số dư — nhưng đó chính là thứ hr-backend dùng để kiểm tra sở hữu (`ProfileBelongsToCustomerAsync`). Bỏ mà không bù = mở IDOR trên dữ liệu **thu nhập**.
🔑 Khi refactor bỏ tham số: **hỏi xem tham số đó có đang dùng để kiểm tra quyền ở đâu không**.
</details>

<details><summary><b>I3. Vì sao `login()` check mật khẩu TRƯỚC, check trạng thái SAU?</b></summary>

Ngược lại thì attacker biết "SĐT này tồn tại nhưng bị khoá" mà không cần biết mật khẩu.
Cùng lý do: message "Số điện thoại hoặc mật khẩu không đúng" **giống hệt** cho cả 2 trường hợp.
</details>

<details><summary><b>I4. ⚠️ Vì sao `ApplyServiceImpl` xét mã giới thiệu TRƯỚC cờ `applyYourself`?</b></summary>

Controller **tự suy** `applyYourself` TỪ SỰ CÓ MẶT của `referralCode` (có mã → false). Xét cờ trước ⇒ NLD tự ứng tuyển có nhập mã sẽ thành người giới thiệu của **chính mình** ⇒ **tự ăn hoa hồng**.
</details>

<details><summary><b>I5. Quy tắc log PII là gì? Kể 1 ngoại lệ thú vị.</b></summary>

Không log tên/CCCD/ngày sinh/địa chỉ; SĐT phải mask; query param thô không log.
🔑 Ngoại lệ: `KycServiceImpl.applyOcrDataToProfile` **không dùng `DebuggingDTO`** vì Jackson `MismatchedInputException` có thể nhúng **nguyên giá trị OCR (PII)** vào message — chỉ log tên class exception.
🔑 Và `phone` đi qua **header `X-App-Phone`** thay vì query param để không lộ vào access log / `FeignException` message.
</details>

<details><summary><b>I6. `KycImageMigrateJob` chống SSRF thế nào? Còn thiếu gì?</b></summary>

Whitelist protocol `http`/`https` — chặn `file://`, `ftp://`, `jar://` (LFI: đọc file server rồi upload lên S3).
Còn thiếu: giới hạn kích thước file (OOM), chặn IP nội bộ (`169.254.169.254` metadata endpoint).
</details>

---

# J. Câu hỏi mở (không có đáp án cố định)

1. Nếu làm lại, bạn sẽ thiết kế cơ chế đồng bộ từ vựng `behavior_type` ↔ `event_type` thế nào?
2. Rule engine hiện dùng `existsByUserIdAndEarnRuleId` làm cổng chặn. Có cách nào không cần enroll trước mà vẫn không phình bảng?
3. `MissionEnrollmentService` đã tối ưu tới mức nào? Còn nút thắt nào khi lượng user ×10?
4. Chưa có DLQ cho Kafka consumer — bạn sẽ thêm thế nào mà không phá dedup hiện tại?
5. Migration chạy tay là rủi ro lớn. Đưa Flyway vào thì phải xử lý 2 version trùng (`V011`, `V027`) ra sao?
6. `t_apply.user_id` là VARCHAR chứa cả customerId lẫn userId; `timekeep_record.user_id` cũng vậy. Có nên dọn không, và dọn thế nào mà không downtime?
7. HS256 (secret chia sẻ với hr-backend) vs RS256 — có nên đổi không?
8. Bản ghi `t_gift_redemption` kẹt `PENDING` chưa có job đối soát. Thiết kế job đó thế nào cho an toàn?
