# customer-service — Quartz Jobs

Package `job/` — **8 job**. Cấu hình lịch: `config/QuartzJobConfig.java` (xem [02](02-khoi-dong-config.md)).

---

## 1. Bảng tổng hợp

| Job | Cron mặc định | Làm gì | Gọi service nào |
|---|---|---|---|
| `MasterDataSyncJob` | 6h | Sync master data | `HrCacheService.syncMasterData()` |
| `RecruitmentSyncJob` | 6h | Sync việc làm | `HrCacheService.syncRecruitments()` |
| `CompanySyncJob` | 6h | Sync công ty | `HrCacheService.syncCompanies()` |
| `NewsSyncJob` | 6h | Sync tin tức (hot/pin/normal) | `HrCacheService.syncNews()` |
| `GiftSyncJob` | 6h | Sync brand + gift Urbox | `GiftCacheService.syncBrands/syncGifts()` |
| `CdpProfileSyncJob` | 1h | Đẩy profile đã sửa sang CDP | `CdpProxy.updateProfile()` |
| **`CdpBackfillJob`** | 30' | 🔑 Vá `customer_id` NULL | `CdpCustomerService.resolveOrCreate()` |
| `KycImageMigrateJob` | 10' | Tải ảnh KYC từ CRM → S3 | `StorageService` |

Tất cả đều `@DisallowConcurrentExecution` — không chạy chồng lên chính nó.

---

## 2. Bốn job sync cache — mẫu giống nhau

```java
@Slf4j @Component @DisallowConcurrentExecution
public class MasterDataSyncJob implements Job {
    @Autowired private HrCacheService hrCacheService;

    @Override
    public void execute(JobExecutionContext context) {
        log.info("MasterDataSyncJob — start");
        hrCacheService.syncMasterData();
        log.info("MasterDataSyncJob — done");
    }
}
```
🔑 **Job cực mỏng** — chỉ log + gọi service. Toàn bộ logic (fetch, hash, version, xử lý lỗi) nằm ở service ⇒ test được bằng unit test, và gọi lại được từ `POST /admin/cache/refresh`.
💡 Job không `try/catch` vì service đã bọc rồi.

---

## 3. 🔑 `CdpBackfillJob` — vá dữ liệu thiếu

```java
/**
 * Backfill customer_id cho user chưa liên kết CDP (customer_id NULL).
 *
 * Bối cảnh: đăng ký qua app gọi CDP đúng 1 lần, nếu CDP lỗi/timeout lúc đó thì customer_id
 * NULL VĨNH VIỄN (SB-4863) — không có job nào vá lại (CdpProfileSyncJob chỉ xử lý user ĐÃ có
 * customer_id). Job này quét định kỳ các user NULL và thử liên kết lại (tra cứu, chưa có thì tạo).
 *
 * Idempotent: mỗi lần chạy chỉ thử lại, thành công thì bản ghi biến mất khỏi tập NULL lần sau.
 * Bó theo cdp.backfill.batch-size mỗi lần để không hammer CDP khi backlog lớn.
 */
@Override
public void execute(JobExecutionContext context) {
    List<UserEntity> pending = userRepository.findUnlinkedWithPhone(PageRequest.of(0, batchSize));
    if (pending.isEmpty()) { log.debug("CdpBackfillJob: no pending records"); return; }

    int linked = 0, skipped = 0, failed = 0;
    for (UserEntity user : pending) {
        try {
            UUID customerId = cdpCustomerService.resolveOrCreate(user.getPhone(), user.getFullName(), user.getNationalId());
            if (customerId == null) { skipped++; continue; }     // 🔑 để lần sau thử lại
            user.setCustomerId(customerId);
            userRepository.save(user);
            linked++;
        } catch (Exception e) {
            log.error("CdpBackfillJob failed: userId={}, debug={}", user.getId(), DebuggingDTO.build(e));
            failed++;
        }
    }
    log.info("CdpBackfillJob done: linked={}, skipped={}, failed={}", linked, skipped, failed);
}
```

### 🔑🔑 Query nguồn — bài học "poison record làm đói job"

```java
/**
 * User chưa liên kết CDP (customer_id NULL) VÀ CÓ PHONE — nguồn cho CdpBackfillJob.
 *
 * LOẠI USER THIẾU PHONE: CDP create BẮT BUỘC phone nên họ KHÔNG BAO GIỜ resolve được;
 * nếu để lẫn, các bản ghi "POISON" này đứng đầu page 0 sẽ CHIẾM CHỖ VĨNH VIỄN và làm ĐÓI (STARVE)
 * các user NULL phía sau (job LUÔN LẤY PAGE 0).
 *
 * Phân trang để bó batch, tránh hammer CDP + run quá dài khi backlog lớn.
 */
@Query("SELECT u FROM UserEntity u WHERE u.customerId IS NULL AND u.phone IS NOT NULL AND u.phone <> ''")
List<UserEntity> findUnlinkedWithPhone(Pageable pageable);
```

💡 **Đây là bài học rất đáng nhớ.** Job luôn lấy `PageRequest.of(0, batchSize)` (page **0**). Nếu tập kết quả chứa bản ghi **không bao giờ xử lý được**, chúng sẽ:
1. Luôn nằm ở đầu (thứ tự ổn định)
2. Luôn được chọn vào batch
3. Luôn thất bại
4. ⇒ Chiếm hết `batchSize` slot ⇒ user hợp lệ **phía sau không bao giờ tới lượt**

Cách chữa: **loại chúng ra khỏi query nguồn** (thay vì tăng batch size hay thêm cột retry_count).

🔑 **`skipped++` chứ không `failed++`** khi `customerId == null` — phân biệt "CDP lỗi tạm thời, thử lại sau" với "có exception". Log 3 con số riêng: `linked / skipped / failed`.

---

## 4. `CdpProfileSyncJob` — đẩy profile đã sửa

```java
List<UserEntity> pending = userRepository.findByCustomerIdIsNotNullAndCdpSyncCountLessThan(2);
for (UserEntity user : pending) {
    try {
        cdpProxy.updateProfile(user.getCustomerId(), CdpUpdateProfileRequest.builder()
                .fullName(user.getFullName()).idCardNumber(user.getNationalId())
                .idCardIssueDateSuggested(user.getIssueDate())
                .idCardPlaceOfIssueSuggested(user.getIssuePlace())
                .requestedBy("customer-service-sync").build());
        user.setCdpSyncCount(user.getCdpSyncCount() + 1);       // 🔑 tăng đếm
        userRepository.save(user);
        synced++;
    } catch (Exception e) { log.warn(...); failed++; }
}
```

🔑 **Cơ chế `cdp_sync_count`** — một cách làm hàng đợi không cần bảng hàng đợi:
| Giá trị | Nghĩa |
|---|---|
| `0` | Vừa sửa profile → cần sync (`ProfileServiceImpl.updateProfile` set về 0) |
| `1` | Đã sync 1 lần |
| `2` (mặc định của entity) | Không cần sync |

Job quét `< 2` → mỗi lần sửa profile sẽ được đẩy sang CDP **2 lần** rồi dừng.
💡 2 lần (không phải 1) để phòng lần đầu CDP nhận nhưng xử lý lỗi phía họ.
⚠️ Đây là "hàng đợi nghèo" (poor man's queue) — đơn giản, nhưng không có thứ tự và không retry vô hạn.

---

## 5. `KycImageMigrateJob` — tải ảnh từ CRM về S3

```java
private static final int BATCH_SIZE = 50;

@Query("SELECT u FROM UserEntity u WHERE u.cccdFrontRaw IS NOT NULL AND u.cccdFrontUrl IS NULL")
List<UserEntity> findWithPendingKycMigration(Pageable pageable);
```
🔑 Cùng pattern "cột staging": `*_raw` = URL từ CRM (chưa xử lý), `*_url` = objectKey S3 (đã migrate).
Điều kiện: có `raw` + chưa có `url`.

```java
for (UserEntity user : pending) {
    if (user.getCccdFrontRaw() != null && user.getCccdFrontUrl() == null) {
        String key = migrateImage(user.getId(), user.getCccdFrontRaw(), false, "cccd_front");
        if (key != null) { user.setCccdFrontUrl(key); user.setCccdFrontRaw(null); updated = true; }
    }
    ... (cccd_back: private) ... (face: publicRead = true) ...
    if (updated) { userRepository.save(user); migrated++; }
}
```
🔑 Xoá `raw` sau khi migrate (`setCccdFrontRaw(null)`) → không bị chọn lại lần sau.
🔑 `face` upload **public-read** (dùng cho chấm công), `cccd` upload **private**.

### 🔑 Chống SSRF khi tải URL từ bên ngoài
```java
private byte[] downloadBytes(String rawUrl) throws Exception {
    URL url = new URL(rawUrl);
    // Chỉ cho phép http/https — ngăn file://, ftp://, jar:// gây SSRF/LFI
    String protocol = url.getProtocol();
    if (!"http".equals(protocol) && !"https".equals(protocol))
        throw new IllegalArgumentException("Unsupported protocol in raw URL: " + protocol);
    try (InputStream in = url.openStream()) { return in.readAllBytes(); }
}
```
⚠️ URL này đến từ **hr-backend** (qua `UserSyncRequest`). Nếu ai đó chèn `file:///etc/passwd` thì `URL.openStream()` sẽ **đọc file trên server** rồi upload lên S3 công khai.
🔑 Đây là **LFI qua SSRF** — lỗ hổng thật. Whitelist protocol là biện pháp tối thiểu.

```java
private String extractFilename(String url) {
    int idx = url.lastIndexOf('/');
    String name = idx >= 0 ? url.substring(idx + 1) : url;
    int q = name.indexOf('?');            // 🔑 bỏ query string
    return q >= 0 ? name.substring(0, q) : name;
}
```

⚠️ **Điểm còn thiếu:** không giới hạn kích thước file (`readAllBytes()` không giới hạn) → URL trỏ tới file khổng lồ có thể gây OOM. Cũng chưa chặn IP nội bộ (`169.254.169.254` metadata endpoint).

---

## 6. Mẫu chung của mọi job

| Đặc điểm | Chi tiết |
|---|---|
| `implements org.quartz.Job` | Không dùng `@Scheduled` — vì cần JDBC store + clustering |
| `@DisallowConcurrentExecution` | Không chạy chồng |
| Đếm 3 con số | `linked/synced/migrated` · `skipped` · `failed` |
| `log.debug` khi rỗng, `log.info` khi có việc | Không spam log |
| `try/catch` **trong** vòng lặp | 1 bản ghi lỗi không dừng cả job |
| Phân trang / `BATCH_SIZE` | Bó công việc, không quét toàn bảng |

💡 So sánh 2 cách khai báo dependency trong job:
- `@Autowired` field (`CdpProfileSyncJob`, các job sync) — kiểu cũ
- `@RequiredArgsConstructor` + `final` (`CdpBackfillJob`, `KycImageMigrateJob`) — kiểu mới, được ưu tiên
⚠️ Với Quartz, constructor injection chỉ hoạt động vì Spring Boot cấu hình `SpringBeanJobFactory` — Quartz thuần sẽ `newInstance()` bằng no-arg constructor.

## 7. Đi tiếp

→ [`20-kafka-consumers.md`](20-kafka-consumers.md)
