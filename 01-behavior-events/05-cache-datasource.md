# behavior-events — Cache & Datasource

Service này có **2 cache in-memory** và **3 datasource**. Đây là phần "khác thường" nhất so với 1 service Spring Boot thông thường.

---

## 1. Ba datasource

| # | DB | Truy cập qua | Dùng làm gì |
|---|---|---|---|
| 1 | PostgreSQL `cdp` schema `app_event` | **JPA** (datasource chính, `spring.datasource`) | Đọc/ghi `t_app_event`, `t_behavior_mapping` |
| 2 | MariaDB `v3m` (hệ cũ) | `JdbcTemplate("mariadbJdbcTemplate")` | **Chỉ đọc** `base_user` để lấy phone theo userId |
| 3 | PostgreSQL `cdp` schema `public` | `JdbcTemplate("cdpJdbcTemplate")` | **Chỉ đọc** `customer_identity` để lấy customerId theo phone |

### `config/SecondaryDataSourceConfig.java`

```java
@Configuration
public class SecondaryDataSourceConfig {

    @Bean("mariadbJdbcTemplate")
    public JdbcTemplate mariadbJdbcTemplate(
            @Value("${mariadb.datasource.url}") String url,
            @Value("${mariadb.datasource.username}") String username,
            @Value("${mariadb.datasource.password}") String password,
            @Value("${mariadb.datasource.driver-class-name}") String driverClassName) {
        DataSource ds = DataSourceBuilder.create()
                .url(url).username(username).password(password)
                .driverClassName(driverClassName).build();
        return new JdbcTemplate(ds);
    }

    @Bean("cdpJdbcTemplate")
    public JdbcTemplate cdpJdbcTemplate(...) { ... }   // y hệt, prefix cdp.*
}
```

🔑 **Vì sao dùng `JdbcTemplate` chứ không JPA?**
- Chỉ cần **1 câu SELECT 1 cột** ở mỗi DB. Dựng `EntityManagerFactory` + `TransactionManager` riêng cho mỗi datasource là quá nặng.
- 2 DB này thuộc **hệ khác** (v3m cũ, cdp) → không nên map entity vì không sở hữu schema, schema đổi thì mình vỡ.

💡 Nhớ: bean `DataSource` được inject bằng **`@Qualifier`** ở nơi dùng:
```java
public UserResolutionCache(@Qualifier("mariadbJdbcTemplate") JdbcTemplate mariadbJdbc,
                           @Qualifier("cdpJdbcTemplate")     JdbcTemplate cdpJdbc) { ... }
```
Không có `@Qualifier` thì Spring không biết inject cái nào (2 bean cùng type) → `NoUniqueBeanDefinitionException`.

---

## 2. `BehaviorMappingCache` — cache bảng dịch tên

```java
@Component
public class BehaviorMappingCache {
    private final BehaviorMappingRepository mappingRepository;

    // key: "action:matchValue" → behaviorType
    private volatile Map<String, String> cache = Collections.emptyMap();   // 🔑 volatile

    @PostConstruct
    public void init() { reload(); }

    @Scheduled(fixedDelay = 2 * 60 * 60 * 1000)     // mỗi 2 tiếng
    public void reload() {
        try {
            Map<String, String> newCache = new HashMap<>();
            mappingRepository.findByEnabledTrue()
                    .forEach(m -> newCache.put(key(m.getAction(), m.getMatchValue()), m.getBehaviorType()));
            cache = Collections.unmodifiableMap(newCache);          // 🔑 hoán đổi nguyên khối
            log.info("BehaviorMappingCache reloaded: size={}", cache.size());
        } catch (Exception e) {
            log.error("BehaviorMappingCache reload failed: debug={}", DebuggingDTO.build(e));
        }
    }

    public Optional<String> resolve(String action, String matchValue) {
        if (action == null || matchValue == null) return Optional.empty();
        return Optional.ofNullable(cache.get(key(action, matchValue)));
    }

    private String key(String action, String matchValue) { return action + ":" + matchValue; }
}
```

### 🔑 Ba kỹ thuật đáng học ở đây

**(1) `volatile` + hoán đổi tham chiếu (copy-on-write)**
Không sửa map cũ mà **dựng map mới rồi gán đè**. `volatile` đảm bảo mọi thread đọc thấy tham chiếu mới ngay.
→ Đọc **không cần khoá** (lock-free), không có trạng thái nửa vời (không bao giờ thấy map "đang được cập nhật dở").

**(2) `Collections.unmodifiableMap`**
Chặn code khác lỡ tay sửa cache.

**(3) `try/catch` bọc toàn bộ `reload()`**
Reload lỗi (DB down) → **giữ nguyên cache cũ**, service vẫn chạy bằng dữ liệu cũ. Nếu để exception thoát ra thì `@Scheduled` chỉ log stack và lần sau vẫn chạy, nhưng `@PostConstruct` ném exception sẽ **sập cả application context**.

⚠️ **Đánh đổi 2 tiếng:** thêm mapping mới thì tối đa 2h sau mới có hiệu lực (hoặc restart pod). Không có endpoint refresh thủ công — điểm có thể cải thiện.

---

## 3. `UserResolutionCache` — cache 2 chặng + sentinel

```java
@Component
public class UserResolutionCache {

    private final JdbcTemplate mariadbJdbc;
    private final JdbcTemplate cdpJdbc;

    private final ConcurrentHashMap<String, String> userIdToPhone     = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> phoneToCustomerId = new ConcurrentHashMap<>();

    private static final String NOT_FOUND = "__NOT_FOUND__";      // 🔑 sentinel

    public Optional<String> resolveCustomerId(String userId) {
        if (userId == null || userId.isBlank()) return Optional.empty();
        String phone = resolvePhone(userId);
        if (phone == null) return Optional.empty();
        return resolveCustomerIdByPhone(phone);
    }
```

### Chặng 1: `userId → phone` (MariaDB `v3m`)

```java
String cached = userIdToPhone.get(userId);
if (cached != null) return NOT_FOUND.equals(cached) ? null : cached;

List<String> rows = mariadbJdbc.query(
        "SELECT phone_number FROM base_user WHERE id = ? LIMIT 1",
        (rs, i) -> rs.getString("phone_number"), userId);
String phone = rows.isEmpty() ? null : rows.get(0);
userIdToPhone.put(userId, phone != null ? phone : NOT_FOUND);      // 🔑 cache cả khi không thấy
```

### Chặng 2: `phone → customerId` (PostgreSQL `cdp.public`)

```java
List<String> rows = cdpJdbc.query(
        "SELECT customer_id::text FROM customer_identity WHERE identity_type = 'PHONE' AND identity_value = ? LIMIT 1",
        (rs, i) -> rs.getString("customer_id"), phone);
```
💡 `customer_id::text` — cast PostgreSQL `uuid` → `text` để `rs.getString()` đọc được ổn định.

### 🔑 Kỹ thuật "sentinel" — negative caching

Nếu chỉ cache khi tìm thấy, thì mọi userId **không tồn tại** sẽ query DB **mỗi lần** → app v1 bắn nhiều event của user không có trong CDP sẽ hammer DB.
Dùng giá trị đặc biệt `"__NOT_FOUND__"` để nhớ "đã tra rồi, không có".

⚠️ Đánh đổi: user **mới được tạo sau** lần tra đầu tiên sẽ mãi bị coi là không tồn tại **đến khi restart pod**. Cache này **không có TTL, không có giới hạn size**.
→ Là điểm yếu đã biết. Muốn sửa: dùng Caffeine với `expireAfterWrite` + `maximumSize`.

### Xử lý lỗi

Mọi `catch (Exception e)` đều `log.error(... DebuggingDTO.build(e))` rồi trả `null`/`Optional.empty()`.
🔑 **Fail-soft**: DB phụ chết thì chỉ mất khả năng forward event app v1; event vẫn được **lưu** vào `t_app_event`. Không làm sập luồng chính.

---

## 4. `JacksonConfig`

```java
@Bean @Primary
public ObjectMapper objectMapper() {
    return new ObjectMapper()
            .registerModule(new JavaTimeModule())                        // hiểu LocalDateTime
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)     // ghi "2026-06-17T10:00:00" thay vì số epoch
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);  // JSON dư field → bỏ qua
}
```
`@Primary` — Spring Boot đã có sẵn 1 `ObjectMapper`, đánh dấu để bean này được ưu tiên inject ở mọi nơi.

## 5. Đi tiếp

→ [`06-entity-database.md`](06-entity-database.md)
