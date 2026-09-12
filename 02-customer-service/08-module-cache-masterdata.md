# customer-service — Cache & Master data

Đây là **module đáng học nhất về pattern**: có **4 pattern cache khác nhau**, mỗi cái giải một bài toán riêng.

---

## 1. 🔑 Bảng so sánh 4 pattern cache

| # | Pattern | Class | Dữ liệu | TTL | Vì sao chọn |
|---|---|---|---|---|---|
| 1 | **MD5-hash + version, không TTL** | `HrCacheServiceImpl`, `GiftCacheServiceImpl` | master-data, việc làm, công ty, tin tức, quà Urbox | ❌ không hết hạn | Dữ liệu **lớn & ít đổi**; app cần biết "có gì mới không" mà không phải tải lại |
| 2 | **Cache-aside TTL ngắn** | `NewsServiceImpl` (detail), `WorkerProfileServiceImpl` | chi tiết tin (180–300s), danh sách hồ sơ worker | ✅ ngắn | Truy cập **lẻ theo id**, không hợp để sync toàn bộ |
| 3 | **Spring `@Cacheable`** | `EventTypeCacheServiceImpl` | danh sách event type | 300s | Dữ liệu nhỏ, chỉ cần TTL đơn giản |
| 4 | **Derived cache (đọc từ cache khác)** | `RecruitmentAreaCacheServiceImpl` | khu vực chấm công theo `recruitmentId` | 900s | Cắt nhỏ 1 payload lớn thành nhiều key nhỏ |

---

## 2. Pattern 1 — MD5-hash + version (🔑 quan trọng nhất)

### Bài toán
App muốn cache **cục bộ** danh sách 113 vị trí việc làm (~564KB) để lọc offline. Nhưng làm sao biết khi nào cần tải lại?

### Giải pháp
```
Quartz job (6h/lần)
   ├─ fetch từ hr-backend
   ├─ serialize JSON → md5(json) = newHash
   ├─ so với storedHash trong system_config (DB)
   │
   ├─ KHÁC  → version = System.currentTimeMillis()
   │           Redis SET cache:data:recruitment    = json
   │           Redis SET cache:version:recruitment = version
   │           DB   SET recruitment.hash / recruitment.version
   │
   └─ GIỐNG → Redis SETNX cache:data:recruitment = json   (chỉ khôi phục nếu Redis mất key)
              KHÔNG đổi version

App:  GET /cache/version  →  { masterData, recruitment, company, news }
      so với version đang lưu trên máy → khác thì mới GET /recruitments/all
```

### Code (`HrCacheServiceImpl.syncRecruitments()`)
```java
String json = objectMapper.writeValueAsString(data.getList());
String newHash = md5(json);
String storedHash = configService.get(CFG_HASH_RECRUITMENT).orElse(null);

if (!newHash.equals(storedHash)) {
    String version = String.valueOf(System.currentTimeMillis());
    redis.opsForValue().set(REDIS_DATA_RECRUITMENT, json);
    redis.opsForValue().set(REDIS_VERSION_RECRUITMENT, version);
    configService.set(CFG_HASH_RECRUITMENT, newHash);
    configService.set(CFG_VERSION_RECRUITMENT, version);
    log.info("syncRecruitments — data changed, new version={} count={}", version, data.getList().size());
} else {
    redis.opsForValue().setIfAbsent(REDIS_DATA_RECRUITMENT, json);   // 🔑 SETNX
    log.debug("syncRecruitments — no change, count={}", ...);
}
```

### 🔑 Bốn chi tiết quan trọng

| Chi tiết | Vì sao |
|---|---|
| **Hash + version lưu ở DB** (`system_config`), data ở Redis | Redis là cache **có thể mất**. Hash/version là **trạng thái**, phải bền. Restart Redis không làm version nhảy lung tung. |
| **`setIfAbsent` khi hash giống** | Redis mất key → khôi phục data mà **không bump version** (app không phải tải lại vô ích). |
| **Version = timestamp ms** | Đơn điệu tăng, dễ so sánh, không cần counter. |
| **`try/catch` bọc toàn bộ sync** | hr-backend lỗi → **giữ nguyên cache cũ**, app vẫn dùng được dữ liệu cũ. |

### `warmUp()` — khôi phục lúc khởi động
```java
@PostConstruct
public void warmUp() {
    restoreVersionToRedis(CFG_VERSION_MASTER, REDIS_VERSION_MASTER);      // DB → Redis
    ...
    if (redis.opsForValue().get(REDIS_DATA_MASTER) == null) syncMasterData();   // data mất → fetch ngay
    ...
}
```
🔑 Pod mới khởi động với Redis trống → tự fetch, không chờ Quartz job 6h sau.

### Read-through khi cache miss
```java
public MasterDataResponse getMasterData() {
    String json = redis.opsForValue().get(REDIS_DATA_MASTER);
    if (json != null) return deserialize(json, ...);
    syncMasterData();                                          // 🔑 tự fetch
    json = redis.opsForValue().get(REDIS_DATA_MASTER);
    return json != null ? deserialize(json, ...) : MasterDataResponse.builder().build();
}
```
⚠️ Nếu hr-backend cũng lỗi → trả object rỗng (**không ném exception**). Xem hệ quả ở `resolveBank()` — chỗ đó phân biệt rỗng thành 502.

### Bảng Redis key
| Key | Nội dung |
|---|---|
| `cache:version:master-data` / `cache:data:master-data` | province, district, career, careerArea, gender, literacy, language, workingForm, salary, age, **bank** |
| `cache:version:recruitment` / `cache:data:recruitment` | danh sách việc làm (+ `areas` = khu vực chấm công) |
| `cache:version:company` / `cache:data:company` | danh sách công ty |
| `cache:version:news` / `cache:data:news-hot` `-pin` `-normal` | 3 loại tin, **1 hash/version chung** |
| `cache:version:gift-brand` / `cache:data:gift-brand` | thương hiệu Urbox |
| `cache:version:gift` / `cache:data:gift` | quà Urbox |

💡 News dùng **1 hash chung cho 3 danh sách** vì luôn sync cùng 1 lần gọi `syncNews()` → bump cùng nhau.

### `system_config` — key-value store trong DB
```java
@Entity @Table(name = "system_config")
public class SystemConfigEntity {
    @Id @Column(name = "config_key", length = 100) private String configKey;
    @Column(name = "config_value", columnDefinition = "TEXT") private String configValue;
    @Column(name = "updated_at") private LocalDateTime updatedAt;
}
```
Key đang dùng: `master_data.hash/.version`, `recruitment.*`, `company.*`, `news.*`, `gift_brand.*`, `gift.*`.

---

## 3. Pattern 2 — Cache-aside TTL ngắn

### `NewsServiceImpl` — chi tiết tin
```java
private static final String REDIS_NEWS_DETAIL_BY_ID_PREFIX   = "cache:news-detail:id:";
private static final String REDIS_NEWS_DETAIL_BY_SLUG_PREFIX = "cache:news-detail:slug:";

@Value("${redis.cache.news-detail.ttl-seconds:300}") private long newsDetailCacheTtlSeconds;

public HrNewsItem getDetailById(long id) {
    String cacheKey = REDIS_NEWS_DETAIL_BY_ID_PREFIX + id;
    HrNewsItem cached = readDetailCache(cacheKey);
    if (cached != null) return cached;
    HrNewsItem item = hrBackendClient.fetchNewsDetailById(id);
    writeDetailCache(cacheKey, item);        // 🔑 item == null → KHÔNG ghi
    return item;
}
```
Javadoc giải thích: *"Cache-aside TTL ngắn (không dùng MD5-version như list) vì nội dung được truy cập **lẻ theo id**, không phù hợp để đồng bộ toàn bộ vào 1 dataset."*
🔑 `writeDetailCache` bỏ qua khi `item == null` → **không negative-cache** lỗi tạm thời.
🔑 Mọi thao tác Redis đều bọc `try/catch` + `log.warn` → Redis chết thì vẫn gọi được hr-backend.

### `WorkerProfileServiceImpl` — danh sách hồ sơ worker (chi tiết ở [10](10-module-timekeeping.md))
```java
// KHÔNG cache list rỗng (negative caching): hr-backend lỗi tạm thời trả [] mà cache lại thì
// worker thấy rỗng suốt TTL dù dữ liệu đã đúng. Chỉ cache khi có kết quả để lần sau tự hồi.
if (!result.isEmpty()) { redis.opsForValue().set(cacheKey, json, ttl, SECONDS); }
```
🔑 **Không negative-cache** là nguyên tắc lặp lại. ⚠️ Ngoại lệ: `RecruitmentAreaCacheServiceImpl` **cố ý** cache list rỗng — xem mục 5.

---

## 4. Pattern 3 — Spring `@Cacheable`

```java
@Service @Transactional(readOnly = true)
public class EventTypeCacheServiceImpl implements IEventTypeCacheService {

    @Cacheable(value = "event-types", key = "'codes'")
    public Set<String> getActiveEventCodes() { ... }

    @Cacheable(value = "event-types", key = "'options'")
    public List<EventTypeOptionResponse> getEventTypeOptions() { ... }
}
```
Cache name `"event-types"` được cấu hình TTL 300s trong `CacheConfig`.
💡 Dùng abstraction vì ở đây chỉ cần "nhớ kết quả trong 5 phút" — không cần version, không cần hash.
⚠️ `@Cacheable` cũng bị **self-invocation** như `@Transactional`: gọi `this.getActiveEventCodes()` trong cùng class sẽ **không** qua cache.

---

## 5. Pattern 4 — Derived cache (`RecruitmentAreaCacheServiceImpl`)

### Bài toán (ghi rõ trong Javadoc)
> *"Lý do không đọc thẳng cache chung mỗi lần check-in: payload đó **~564KB cho 113 vị trí**, deserialize mỗi lần chấm công là quá đắt trong khi mỗi lần chỉ cần khu vực của 1 vị trí."*

### Giải pháp
```java
public List<WorkAreaDto> findByRecruitmentId(Integer recruitmentId) {
    String key = "timekeep:areas:" + recruitmentId;
    String cached = redis.opsForValue().get(key);
    if (cached != null) return objectMapper.readValue(cached, new TypeReference<List<WorkAreaDto>>() {});

    List<WorkAreaDto> areas = loadFromRecruitmentCache(recruitmentId);   // đọc từ cache:data:recruitment

    // 🔑 Ghi CẢ KHI RỖNG: vị trí không cấu hình khu vực là trạng thái ỔN ĐỊNH,
    // cache lại để mỗi lần check-in không phải deserialize lại toàn bộ cache việc làm.
    redis.opsForValue().set(key, objectMapper.writeValueAsString(areas), areaCacheTtlSeconds, SECONDS);
    return areas;
}
```

🔑 **Đây là ngoại lệ duy nhất cache list rỗng** — và có lý do rõ ràng: rỗng ở đây **không phải lỗi tạm thời** mà là **cấu hình thật** (CRM chưa vẽ khu vực cho vị trí đó). Nếu không cache thì mỗi lần check-in phải deserialize 564KB.

🔑 **TTL (900s) đặt dài hơn chu kỳ sync cache chung** → key tự làm mới sau khi CRM đổi cấu hình, và tự hồi nếu Redis mất key.

### Làm sạch dữ liệu rác
```java
/** Bỏ đỉnh thiếu lat/lng và khu vực không còn đỉnh nào — dữ liệu rác không được vào bước validate GPS. */
private List<WorkAreaDto> toWorkAreas(Integer recruitmentId, List<HrAreaCoordinateItem> areas) {
    ...
    if (result.size() < areas.size()) {
        log.warn("Dropped invalid work areas ... areasIn={}, areasOut={}", areas.size(), result.size());
    }
}
```
🔑 Lọc **ngay ở biên cache**, không để dữ liệu thiếu toạ độ đi vào thuật toán GPS (sẽ `NullPointerException` hoặc cho kết quả sai).

### Hợp đồng "rỗng = không validate được"
Javadoc interface:
> *"@return danh sách khu vực; **RỖNG** khi CRM chưa cấu hình khu vực, hoặc chưa có dữ liệu trong cache. Caller phải coi rỗng là **"không validate được" (fail-open)**, KHÔNG phải "ngoài vùng"."*

→ `TimekeepServiceImpl.checkIn()` tuân theo đúng: `areas.isEmpty()` → vẫn cho chấm công. Xem [10](10-module-timekeeping.md).

---

## 6. `CacheController` — API cho app

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| GET | `/cache/version` | public | 4 version → app so để quyết định tải lại |
| GET | `/master-data` | public | Toàn bộ master data (gồm **banks**) |
| GET | `/recruitments/all` | public | Toàn bộ việc làm — app cache local & filter trên device |
| GET | `/companies/all` | public | Toàn bộ công ty |
| POST | `/admin/cache/refresh` | `@PreAuthorize("hasRole('ADMIN')")` | Xoá cache + fetch lại ngay |

### Sắp xếp việc làm ngay ở controller
```java
List<HrRecruitmentItem> list = hrCacheService.getAllRecruitments().stream()
        .sorted(Comparator.comparing(HrRecruitmentItem::getIndexJob, Comparator.nullsLast(Integer::compareTo))
                .thenComparing(item -> Boolean.TRUE.equals(item.getIsUrgent()) ? 0 : 1))
        .collect(Collectors.toList());
```
🔑 `Comparator.nullsLast` — `indexJob` có thể null; không xử lý sẽ `NullPointerException` khi sort.
💡 Sort ở **đọc** chứ không ở **sync** để đổi thứ tự hiển thị không cần bump version cache.

⚠️ `POST /admin/cache/refresh` nằm trong `/admin/**` = `PUBLIC_URLS` (permitAll ở tầng URL), nhưng có `@PreAuthorize("hasRole('ADMIN')")` ở **tầng method** → vẫn được bảo vệ. Đây là cách duy nhất khiến endpoint dưới `/admin/**` an toàn.

---

## 7. Favorites (`FavoriteServiceImpl`)

`POST /favorites` (ghi đè toàn bộ) · `GET /favorites`

```java
// Lưu: List<Integer> → CSV vào t_user.favorite_recruitment_ids
String ids = recruitmentIds.stream().map(String::valueOf).collect(Collectors.joining(","));

// Đọc: parse CSV → Set → filter TỪ CACHE
Set<Integer> favoriteIds = Arrays.stream(raw.split(",")).map(String::trim)
        .filter(s -> !s.isEmpty()).map(Integer::parseInt).collect(Collectors.toSet());
return hrCacheService.getAllRecruitments().stream()
        .filter(item -> favoriteIds.contains(item.getId())).collect(Collectors.toList());
```
🔑 **0 query DB cho danh sách việc làm** — lọc trong bộ nhớ từ cache. Không có bảng `t_favorite`, không có JOIN.
💡 Đánh đổi: việc làm đã đóng (không còn trong cache) sẽ **biến mất** khỏi danh sách yêu thích. Chấp nhận được (thậm chí là hành vi mong muốn).

---

## 8. News (`NewsServiceImpl` + `NewsController`)

| Method | Path | Nguồn |
|---|---|---|
| GET | `/news/hot` | cache MD5-version (`cache:data:news-hot`) |
| GET | `/news/pin` | cache MD5-version |
| GET | `/news/normal` | cache MD5-version (giới hạn 1000 tin) |
| GET | `/news/detail?id=` | cache-aside TTL 300s |
| GET | `/news/detail-slug?slug=` | cache-aside TTL 300s |

```java
/** typeId=200 ("Tin tức") theo SysNewspaperManagers.TYPE_INFO bên hr-backend
 *  — typeId=100 là "Hướng dẫn đào tạo CTV", ngoài phạm vi API này. */
private static final int NEWS_TYPE_ID = 200;
private static final int NEWS_NORMAL_PAGE_LIMIT = 1000;
```
🔑 Chi tiết **`htmlContent` chỉ có ở API detail**, không có trong danh sách → đó là lý do detail phải gọi hr-backend riêng (không lấy từ cache list được).

## 9. Đi tiếp

→ [`09-module-apply.md`](09-module-apply.md)
