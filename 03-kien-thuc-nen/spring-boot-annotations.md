# Kiến thức nền — Annotation Spring Boot dùng trong dự án

Chỉ liệt kê những annotation **thực sự xuất hiện** trong 2 repo, kèm ví dụ từ chính code.

---

## 1. Khởi động ứng dụng

| Annotation | Ý nghĩa | Ở đâu trong dự án |
|---|---|---|
| `@SpringBootApplication` | Gộp `@Configuration` + `@EnableAutoConfiguration` + `@ComponentScan` | Cả 2 Application class |
| `@EnableTransactionManagement` | Bật `@Transactional` | Cả 2 |
| `@EnableJpaAuditing` | Bật `@CreatedDate`/`@LastModifiedDate` | Cả 2 |
| `@EntityScan(basePackages=…)` | Khai báo tường minh nơi quét `@Entity` | Cả 2 (vì có datasource phụ / nhiều package) |
| `@EnableJpaRepositories(basePackages=…)` | Nơi quét repository | Cả 2 |
| `@EnableScheduling` | Bật `@Scheduled` | Cả 2 |
| `@ConfigurationPropertiesScan` | Quét `@ConfigurationProperties` không cần `@Component` | Cả 2 |
| `@EnableFeignClients` | Bật Feign | customer-service |
| `@EnableAsync` | Bật `@Async` | `AsyncConfig` |
| `@EnableCaching` | Bật `@Cacheable` | `CacheConfig` |
| `@EnableWebSecurity` | Bật Spring Security | `SecurityConfig` |
| `@EnableGlobalMethodSecurity(prePostEnabled=true)` | Bật `@PreAuthorize` | `SecurityConfig` |

### 💡 Meta-annotation
```java
@Retention(RUNTIME) @Target(TYPE)
@EnableFeignClients(basePackages = "com.ttt.v3m.app.customer.config.proxy")
@Import({DefaultFeignConfig.class})
public @interface EnableServiceProxy {}
```
Gom nhiều annotation thành 1. Spring đọc annotation lồng nhau (meta-annotation) như thể chúng được khai trực tiếp.

---

## 2. 🔑🔑 Proxy AOP — bài học quan trọng nhất

`@Transactional`, `@Async`, `@Cacheable` đều hoạt động qua **proxy** mà Spring bọc quanh bean.

```java
// ❌ SAI — self-invocation, annotation VÔ TÁC DỤNG
@Service
class MyService {
    public void outer() { this.inner(); }              // gọi thẳng, không qua proxy
    @Transactional(REQUIRES_NEW) public void inner() { ... }
}

// ✅ ĐÚNG — tách bean riêng
@Service class MyService     { private final MyTxService tx; public void outer() { tx.inner(); } }
@Service class MyTxService   { @Transactional(REQUIRES_NEW) public void inner() { ... } }
```

### 🔑 Pattern này xuất hiện **3 lần** trong customer-service

| Bean tách ra | Vì sao |
|---|---|
| `UserSyncItemService` | `@Transactional(REQUIRES_NEW)` — mỗi user 1 transaction, 1 lỗi không hỏng batch 1000 |
| `GiftRedemptionTxService` | `@Transactional(REQUIRES_NEW)` — hoàn điểm không bị cuốn theo rollback của lượt trừ điểm |
| `FcmDispatchService` | `@Async` — *"@Async chỉ hoạt động qua proxy — gọi trong cùng class sẽ bị bỏ qua"* |

💡 Quy tắc nhớ: **annotation hành vi chỉ có tác dụng khi bean được gọi TỪ BÊN NGOÀI.**

---

## 3. Dependency Injection

```java
@Service
@RequiredArgsConstructor           // 🔑 Lombok sinh constructor cho mọi field final
public class RewardServiceImpl implements RewardService {
    private final IWorkerProfileService workerProfileService;
    private final HrBackendClient hrBackendClient;
    private final MeterRegistry meterRegistry;
}
```
🔑 **Constructor injection** (không phải `@Autowired` field) — kiểu được ưu tiên trong dự án:
- Field `final` → bất biến
- Test dễ (new object với mock)
- Phát hiện vòng phụ thuộc ngay lúc khởi động

⚠️ Vẫn còn `@Autowired` field ở một số job cũ (`CdpProfileSyncJob`, `MasterDataSyncJob`).

### `@Qualifier` — khi có nhiều bean cùng type
```java
public UserResolutionCache(@Qualifier("mariadbJdbcTemplate") JdbcTemplate mariadbJdbc,
                           @Qualifier("cdpJdbcTemplate")     JdbcTemplate cdpJdbc) { ... }
```

### `@Lazy` — phá vòng phụ thuộc
```java
@Lazy
private final BehaviorForwardService behaviorForwardService;
```
Spring inject **proxy**, chỉ khởi tạo bean thật khi gọi method đầu tiên.

### `Optional<T>` — bean có thể không tồn tại
```java
/** Optional vì FcmConfig.firebaseMessaging() trả null — Spring KHÔNG đăng ký bean cho @Bean method
 *  trả null, nên dependency thường sẽ throw NoSuchBeanDefinitionException lúc startup. */
private final Optional<FirebaseMessaging> firebaseMessaging;
```

---

## 4. Cấu hình

### `@Value` — 1 giá trị
```java
@Value("${timekeeping.forgot-checkout-window-hours:16}")   // 16 = default
private long forgotCheckoutWindowHours;
```
⚠️ **`@Value` không hoạt động trong constructor** (inject sau khi object được tạo). Cần giá trị lúc khởi tạo thì dùng `@ConfigurationProperties` hoặc constructor param.

### `@ConfigurationProperties` — nhóm giá trị
```java
@Data @Configuration @ConfigurationProperties(prefix = "urbox")
public class UrboxProperties {
    private String baseUrl, appId, appSecret, privateKey, campaignCode;
    private boolean redeemSendSms = true;
    private List<String> excludedGiftTypes = List.of();
    private int maxOfficePerGift = 50;
}
```
🔑 Ưu điểm: type-safe, có default trong Java, bind được `List`/`Map`, IDE gợi ý được.
💡 `@ConfigurationPropertiesScan` trên Application class → không cần `@Component` trên từng class.

---

## 5. Web layer

| Annotation | Ví dụ trong dự án |
|---|---|
| `@RestController` | `@RestController @RequestMapping("/auth")` |
| `@GetMapping` / `@PostMapping` / `@PutMapping` / `@PatchMapping` / `@DeleteMapping` | |
| `@RequestBody` | `@Valid @RequestBody LoginRequest request` |
| `@RequestParam` | `@RequestParam Integer recruitmentId` |
| `@PathVariable` | `@PathVariable UUID earnRuleId` |
| `@RequestHeader` | (chủ yếu trong Feign proxy) |
| **`@RequestAttribute("userId")`** | 🔑 `@RequestAttribute("userId") Long userId` — đọc attribute do `JwtAuthFilter` set |
| `@RequestPart` | `@RequestPart("image") MultipartFile image` (multipart) |
| `@PageableDefault` | `@PageableDefault(size = 20, sort = "createdAt", direction = DESC) Pageable pageable` |
| `@DateTimeFormat` | `@DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from` |
| `@RestControllerAdvice` | `GlobalExceptionHandler` |
| `@ExceptionHandler` | |
| `@PreAuthorize` | `@PreAuthorize("hasRole('ADMIN')")` trên `CacheController.refreshAll()` |

### 🔑 `@RequestAttribute` vs `@RequestParam`
```java
@RequestAttribute("userId") Long userId    // do FILTER set (server-side, tin được)
@RequestParam("profileId") Long profileId  // do CLIENT gửi (phải validate + gác quyền!)
```
Đây là ranh giới tin cậy. Mọi `@RequestParam` là **input không tin được**.

⚠️ Thiếu `@RequestAttribute` → `ServletRequestBindingException` → cần handler riêng (xem [`../02-customer-service/04-exception-response.md`](../02-customer-service/04-exception-response.md)).

---

## 6. Persistence (JPA)

| Annotation | Ví dụ |
|---|---|
| `@Entity` `@Table(name=…, schema=…, indexes=…, uniqueConstraints=…)` | |
| `@Id` `@GeneratedValue(strategy = IDENTITY)` | auto-increment |
| `@Id` `@GeneratedValue` + `@Column(columnDefinition="BINARY(16)")` | UUID |
| `@Column(name, nullable, length, unique, updatable, columnDefinition)` | |
| `@Enumerated(EnumType.STRING)` | 🔑 **luôn STRING**, không ORDINAL (thêm enum giữa chừng sẽ lệch) |
| `@ManyToOne(fetch = LAZY/EAGER)` `@JoinColumn` | |
| `@OneToMany(mappedBy, cascade = ALL, orphanRemoval = true)` `@OrderBy` | |
| `@Lob` | `urbox_response`, `voucher_codes` |
| `@CreatedDate` `@LastModifiedDate` + `@EntityListeners(AuditingEntityListener.class)` | |
| `@PrePersist` `@PreUpdate` | `TimekeepRecordEntity`, `ApplyEntity` (tự set id/timestamp) |
| `@Type(type="uuid-char")` (Hibernate) | `t_user.customer_id` |
| `@ColumnTransformer(write="?::jsonb")` (Hibernate) | 🔑 `t_app_event.metadata` (PostgreSQL) |
| `@Query` / `@Modifying` / `@Param` | |
| `@Lock(LockModeType.PESSIMISTIC_WRITE)` | 🔑 `findByUserIdForUpdate` |

Chi tiết: [`jpa-transaction.md`](jpa-transaction.md)

---

## 7. Lombok

| Annotation | Sinh ra gì |
|---|---|
| `@Data` | getter + setter + `equals`/`hashCode`/`toString` |
| `@Getter` | chỉ getter |
| `@Builder` + `@Builder.Default` | builder pattern; `@Builder.Default` giữ giá trị mặc định của field |
| `@NoArgsConstructor` `@AllArgsConstructor` | 🔑 JPA **bắt buộc** có no-arg constructor |
| `@RequiredArgsConstructor` | constructor cho field `final` |
| `@Slf4j` | `private static final Logger log` |
| `@ToString` | |

⚠️ **`@Builder.Default` bắt buộc** khi field có giá trị khởi tạo:
```java
@Builder.Default private Integer currentCount = 0;
```
Không có nó, `builder().build()` sẽ cho `null` (builder bỏ qua giá trị khởi tạo của field).

⚠️ `@Data` trên `@Entity` sinh `equals`/`hashCode` dựa trên **mọi field** — có thể gây vấn đề với lazy loading và `Set`. Ở đây chấp nhận vì entity ít khi cho vào `Set`.

---

## 8. Kafka

```java
@KafkaListener(topics = "${kafka.topic.cdp-behavior-consume}", groupId = "${spring.kafka.consumer.group-id}")
public void consume(String raw) { ... }
```
- Nhận `String` hoặc `ConsumerRecord<String,String>` (để đọc `offset`/`partition`)
- `groupId` từ config → nhiều pod cùng group chia nhau partition
- Ném exception = **không commit offset** → Kafka giao lại

Chi tiết: [`kafka-co-ban.md`](kafka-co-ban.md)

---

## 9. Quartz

```java
@Component @DisallowConcurrentExecution
public class CdpBackfillJob implements Job {
    @Override public void execute(JobExecutionContext context) { ... }
}
```
Khác `@Scheduled` ở chỗ: có **JDBC store** (lịch lưu DB) → clustering (nhiều pod chỉ 1 chạy).

---

## 10. Micrometer (metric)

```java
private final MeterRegistry meterRegistry;

// Counter
Counter.builder("mission.auto_enroll").tag("source", source).tag("result", result)
       .register(meterRegistry).increment();

// Timer
Timer.Sample sample = Timer.start(meterRegistry);
String result = "success";
try { ... } catch (...) { result = "fail"; throw ...; }
finally { sample.stop(Timer.builder("reward.all").tag("result", result).register(meterRegistry)); }
```
🔑 `Timer` xuất cả `_count`, `_sum`, `_max` → **đủ thay Counter**.
🔑 `finally` để metric luôn được ghi kể cả khi ném exception.
⚠️ **Tag không được có cardinality cao** — không bao giờ `tag("userId", ...)`. Chỉ dùng giá trị hữu hạn (`success`/`fail`/`skipped`).

---

## 11. Swagger 2 (springfox)

```java
@Api(tags = "Reward — thông tin thưởng")                    // trên class
@ApiOperation("Tổng thưởng của user hiện tại")              // trên method
@ApiParam(value = "AppProfileId", required = true)          // trên param
```
Bắt buộc theo `CLAUDE.md`.

---

## 12. Validation

```java
@NotBlank(message = "action không được để trống")
@Valid @RequestBody LoginRequest request
```
⚠️ `@Valid` **không chạy** khi body là `JsonNode` → phải validate thủ công (xem `AppEventController`).
