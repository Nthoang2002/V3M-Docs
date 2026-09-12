# customer-service — Khởi động & các lớp Config

## 1. `bootstrap.yml`

```yaml
spring:
  application:
    id: 32
    name: APP-CUSTOMER-SERVICE
  cloud:
    config:
      uri: ${CONFIG_SERVER_URI:http://config-server:8888}
```
Toàn bộ cấu hình thật nằm ở **Spring Cloud Config Server** (repo git, branch theo môi trường: `uat`, `production`).
Trong repo chỉ có `bootstrap.yml` + `2026_05_13_0001_create_rule_engine_tables.sql` + `fonts/` + `templates/` + `firebase-service-account.json` (local dev, đã gitignore).

## 2. Bảng các `@Configuration`

| Class | Tạo bean gì | Vì sao |
|---|---|---|
| `JacksonConfig` | `ObjectMapper` `@Primary` | Case-insensitive + `JavaTimeModule` + không fail khi JSON dư field |
| `CacheConfig` | `RedisCacheManager` | Cho `@Cacheable` (Spring Cache abstraction) |
| `AsyncConfig` | (chỉ `@EnableAsync`) | Cho `FcmDispatchService.dispatchAsync` |
| `QuartzJobConfig` | 8 `JobDetail` + 8 `Trigger` | Lịch chạy job |
| `S3Config` | `S3Client`, `S3Presigner` | FPT Object Storage |
| `FcmConfig` | `FirebaseMessaging` | Push notification |
| `SecurityConfig` | Security filter chain, `PasswordEncoder` | JWT + phân quyền |
| `Swagger2Config` | `Docket` | API doc |
| `*Properties` | `@ConfigurationProperties` | Bind cấu hình theo prefix |

---

## 3. `JacksonConfig`

```java
@Bean @Primary
public ObjectMapper objectMapper() {
    return new ObjectMapper()
            .configure(MapperFeature.ACCEPT_CASE_INSENSITIVE_PROPERTIES, true)   // 🔑
            .configure(MapperFeature.ACCEPT_CASE_INSENSITIVE_ENUMS, true)        // 🔑
            .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false)
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .registerModule(new JavaTimeModule());
}
```
🔑 **Case-insensitive** — vì hr-backend là **C#/.NET**, trả JSON `PascalCase` (`FullName`, `ProfileId`) trong khi Java field là `camelCase`. Bật cờ này thì không phải rải `@JsonProperty` khắp nơi.
💡 Đánh đổi: mất tính nghiêm ngặt, 2 field khác nhau chỉ bởi hoa/thường sẽ nhập nhằng. Nhưng thực tế không có case đó.

---

## 4. `CacheConfig` — Redis cho `@Cacheable`

```java
@Configuration
@EnableCaching
public class CacheConfig {
    @Value("${spring.cache.event-types.ttl-seconds:300}") private long eventTypesTtl;

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory cf) {
        var jsonSerializer = RedisSerializationContext.SerializationPair
                .fromSerializer(new GenericJackson2JsonRedisSerializer());

        RedisCacheConfiguration defaultCfg = RedisCacheConfiguration.defaultCacheConfig()
                .serializeValuesWith(jsonSerializer)
                .disableCachingNullValues();                   // 🔑 không cache null

        RedisCacheConfiguration eventTypesCfg = defaultCfg.entryTtl(Duration.ofSeconds(eventTypesTtl));

        return RedisCacheManager.builder(cf)
                .cacheDefaults(defaultCfg)
                .withInitialCacheConfigurations(Map.of("event-types", eventTypesCfg))
                .build();
    }
}
```
- Chỉ **1 cache name** dùng abstraction này: `"event-types"` (TTL 5 phút) — xem `EventTypeCacheServiceImpl`.
- ⚠️ Mọi cache khác trong service **không dùng `@Cacheable`** mà thao tác `StringRedisTemplate` thủ công (xem [08](08-module-cache-masterdata.md)) — vì cần kiểm soát version/hash chứ không chỉ TTL.
- `disableCachingNullValues()` — tránh cache "không tìm thấy" gây kẹt dữ liệu cũ.

---

## 5. `S3Config` + `S3Properties` — FPT Object Storage

```java
private S3Configuration pathStyle() {
    return S3Configuration.builder()
            .pathStyleAccessEnabled(true)          // 🔑 FPT (Ceph) không hỗ trợ virtual-host style
            .checksumValidationEnabled(false)      // 🔑 xem giải thích dưới
            .chunkedEncodingEnabled(false)         // 🔑
            .build();
}
```

### 🔑 Ba flag này đều đến từ sự cố thật (comment trong code ghi rõ)

| Flag | Nếu KHÔNG tắt thì sao |
|---|---|
| `pathStyleAccessEnabled(true)` | AWS mặc định dùng `bucket.endpoint/key` (virtual-host). FPT dùng Ceph, chỉ hiểu `endpoint/bucket/key`. |
| `checksumValidationEnabled(false)` | SDK ký kèm header `x-amz-te` vào presigned GET URL, nhưng **browser/curl không gửi header đó** → chữ ký không khớp → **403 SignatureDoesNotMatch**. |
| `chunkedEncodingEnabled(false)` | SDK dùng `aws-chunked` transfer-encoding khi PUT — nhiều S3-compatible (Ceph/FPT) **không nhận**. |

`S3Properties` (prefix `s3`): `endpoint`, `region`, `bucket`, `accessKey`, `secretKey`.
> **1 bucket dùng chung**, phân tách bằng prefix objectKey: `kyc/`, `avatars/`, `ctv/`, `timekeeping/`.
> Public/private quyết bằng **per-object ACL** lúc upload.

---

## 6. `FcmConfig` — bài học "bean trả null"

```java
@Bean
public FirebaseMessaging firebaseMessaging() {
    initializeFirebaseApp();
    if (FirebaseApp.getApps().isEmpty()) {
        return null;                       // 🔑 KHÔNG throw
    }
    return FirebaseMessaging.getInstance();
}
```

Javadoc trong code giải thích:
> *"Trả về null nếu Firebase chưa init được — **không được throw ở đây**, vì bean này được `@Component` khác constructor-inject (eager singleton), throw sẽ **sập toàn bộ application context** (mọi API khác của customer-service, không chỉ notification)."*

🔑 Và ở nơi dùng (`FcmSender`) phải inject **`Optional`**:
```java
private final Optional<FirebaseMessaging> firebaseMessaging;
```
> *"Optional vì `FcmConfig.firebaseMessaging()` trả null — Spring **không đăng ký bean** cho `@Bean` method trả null, nên dependency thường sẽ throw `NoSuchBeanDefinitionException` lúc startup."*

💡 **Bài học tổng quát:** tính năng phụ (push notification) không được có quyền làm sập tính năng chính. Đây là nguyên tắc *graceful degradation*.

### 2 nguồn credential — ưu tiên config server
```java
String json = fcmProperties.getCredentialsJson();     // ưu tiên 1: nội dung JSON qua Config Server
if (json != null && !json.isEmpty()) { initializeFromJson(json); return; }
initializeFromPath(fcmProperties.getCredentialsPath());   // ưu tiên 2: file trên đĩa (local dev)
```
🔑 Ưu tiên `credentials-json` để **không cần đặt file secret lên server** — giống mọi secret khác (đi qua Config Server).

---

## 7. `HrBackendProperties` / `UrboxProperties`

```java
@Data @Configuration @ConfigurationProperties(prefix = "hr-backend")
public class HrBackendProperties {
    private String baseUrl, username, password, partner, applyApiKey, mediaBaseUrl;
    private Integer tenantId;
}
```
🔑 hr-backend có **2 cơ chế auth khác nhau** → 2 nhóm endpoint (xem [18](18-tich-hop-3rd-party.md)):
- `username`/`password` → Basic Auth (nhóm `HrDataProxy`)
- `applyApiKey` → header `api-key` (nhóm `HrBackendProxy`, server-to-server)

```java
@Data @Configuration @ConfigurationProperties(prefix = "urbox")
public class UrboxProperties {
    private String baseUrl, appId, appSecret;
    private String privateKey;                 // RSA PKCS8 PEM — ký request đổi quà
    private String campaignCode;
    private boolean redeemSendSms = true;
    private List<String> excludedGiftTypes = List.of();   // loại quà cấm bán
    private int maxOfficePerGift = 50;                    // cắt bớt địa điểm áp dụng
}
```
💡 `maxOfficePerGift` — comment giải thích: Urbox trả có quà **hàng nghìn địa điểm**, làm phình cache Redis + response API mà app không có ngữ cảnh vị trí để chọn "gần nhất". Cắt **ngay lúc sync**, không phải lúc trả response (nếu cắt lúc trả thì cache vẫn phình).

---

## 8. `QuartzJobConfig` — 8 job

Mỗi job có 2 bean: `JobDetail` (định nghĩa) + `Trigger` (lịch chạy).

```java
@Bean
public JobDetail masterDataSyncJobDetail() {
    return JobBuilder.newJob(MasterDataSyncJob.class)
            .withIdentity("masterDataSyncJob")
            .storeDurably()                                  // 🔑 giữ job dù chưa có trigger
            .build();
}

@Bean
public Trigger masterDataSyncTrigger(JobDetail masterDataSyncJobDetail) {
    return TriggerBuilder.newTrigger()
            .forJob(masterDataSyncJobDetail)
            .withIdentity("masterDataSyncTrigger")
            .withSchedule(CronScheduleBuilder.cronSchedule(masterDataCron)
                    .withMisfireHandlingInstructionDoNothing())   // 🔑
            .build();
}
```

🔑 **`withMisfireHandlingInstructionDoNothing()`** — nếu pod chết/đang deploy đúng lúc đến giờ chạy, Quartz sẽ **không** chạy bù. Với job đồng bộ cache thì bỏ 1 lần là được (lần sau vẫn đúng); chạy bù dồn nhiều lần cùng lúc mới nguy hiểm.

Bảng cron (config key + mặc định):
| Job | Key | Mặc định |
|---|---|---|
| `MasterDataSyncJob` | `cache.sync-cron.master-data` | `0 0 */6 * * ?` (6h) |
| `RecruitmentSyncJob` | `cache.sync-cron.recruitment` | `0 0 */6 * * ?` |
| `CompanySyncJob` | `cache.sync-cron.company` | `0 0 */6 * * ?` |
| `NewsSyncJob` | `cache.sync-cron.news` | `0 0 */6 * * ?` |
| `GiftSyncJob` | `cache.sync-cron.gift` | `0 0 */6 * * ?` |
| `CdpProfileSyncJob` | `cdp.profile-sync.cron` | `0 0 * * * ?` (1h) |
| `CdpBackfillJob` | `cdp.backfill.cron` | `0 */30 * * * ?` (30 phút) |
| `KycImageMigrateJob` | `kyc.image-migrate.cron` | `0 */10 * * * ?` (10 phút) |

Quartz dùng **JDBC store** → lịch + trạng thái lưu trong DB → nhiều pod chỉ 1 pod chạy mỗi lần (clustering).
Mọi job đều `@DisallowConcurrentExecution` → không chạy chồng lên chính nó.

Chi tiết từng job: [19](19-jobs-quartz.md).

## 9. Đi tiếp

→ [`03-security-jwt.md`](03-security-jwt.md)
