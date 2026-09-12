# Kiến thức nền — Redis & các pattern cache

Redis trong V3M dùng cho **4 mục đích** khác nhau, mỗi cái một pattern.

---

## 1. Bốn nhóm sử dụng

| Nhóm | Key prefix | TTL | Class |
|---|---|---|---|
| **Phiên đăng nhập** | `auth:refresh:*`, `auth:otp:*`, `auth:register:*` | có | `RedisTokenService` |
| **Cache dữ liệu** | `cache:*`, `timekeep:areas:*` | tuỳ | `HrCacheServiceImpl`, `GiftCacheServiceImpl`, … |
| **Dedup event** | `rule:event:dedup:*` | 300s | `CdpBehaviorSavedConsumer`, `RuleEventConsumer` |
| **Distributed lock** | `auth:otp:lock:*`, `auth:register:lock:*` | 5s | `RedisTokenService` |

---

## 2. 🔑 `SETNX` (setIfAbsent) — 3 công dụng

```java
redisTemplate.opsForValue().setIfAbsent(key, value, ttl, TimeUnit.SECONDS);
// trả true nếu key CHƯA tồn tại (và đã set), false nếu đã có
```

| Công dụng | Ví dụ | TTL |
|---|---|---|
| **Distributed lock** | `tryAcquireOtpLock(userId)` — chống spam gửi OTP | 5s (tự nhả) |
| **Dedup** | `acquireDedup(userId, eventType, phút)` | 300s |
| **Khôi phục cache không bump version** | `redis.opsForValue().setIfAbsent(REDIS_DATA_RECRUITMENT, json)` | ∞ |

🔑 **Lock có TTL tự nhả** — không cần unlock thủ công, không sợ deadlock khi pod chết giữa chừng.
⚠️ Đánh đổi: nếu thao tác kéo dài hơn TTL thì lock hết hạn sớm. Ở đây 5s là đủ (chỉ chống double-click).

---

## 3. 🔑 Lua script — nguyên tử GET + DEL

```java
private static final DefaultRedisScript<String> GET_DEL_SCRIPT = new DefaultRedisScript<>(
        "local v = redis.call('GET', KEYS[1])\n" +
        "if v then redis.call('DEL', KEYS[1]) end\n" +
        "return v", String.class);
```

**Vì sao cần?**
```
Không nguyên tử:                          Nguyên tử (Lua):
  Request A: GET tokenOtp → userId=5        Request A: GET+DEL → userId=5
  Request B: GET tokenOtp → userId=5        Request B: GET+DEL → null  ✅
  Request A: DEL
  Request B: DEL
  ⇒ CẢ HAI đổi được mật khẩu ❌
```
Redis chạy Lua **single-threaded, nguyên tử** — không lệnh nào chen vào giữa.

Dùng ở: `getAndDeleteTokenOtpUserId()` (vé đổi mật khẩu), `getAndDeleteRegisterPending()` (dữ liệu đăng ký).
🔑 Đây là mẫu **token dùng-một-lần**.

---

## 4. 🔑 Pattern 1 — MD5-hash + version (cache lớn, ít đổi)

```
Job (6h)
  ├─ fetch từ nguồn → serialize JSON → md5 = newHash
  ├─ so với storedHash trong DB (system_config)
  ├─ KHÁC  → version = now(); Redis SET data + version; DB SET hash + version
  └─ GIỐNG → Redis SETNX data  (chỉ khôi phục nếu mất key, KHÔNG bump version)

App: GET /cache/version → so với version local → khác mới tải lại
```

🔑 **4 quyết định:**
| Quyết định | Vì sao |
|---|---|
| Hash + version ở **DB**, data ở **Redis** | Redis có thể mất; hash/version là **trạng thái**, phải bền |
| `SETNX` khi hash giống | Khôi phục data mà không bump version (app không tải lại vô ích) |
| Version = timestamp ms | Đơn điệu tăng, dễ so, không cần counter |
| `try/catch` bọc toàn bộ | Nguồn lỗi → giữ nguyên cache cũ |

**Không TTL** — dữ liệu tồn tại đến khi có bản mới. Job là thứ duy nhất làm mới.

Dùng cho: master-data, recruitment, company, news, gift-brand, gift.

---

## 5. Pattern 2 — Cache-aside TTL ngắn

```java
String cached = redis.opsForValue().get(cacheKey);
if (cached != null) return deserialize(cached);
T value = fetchFromSource();
if (value != null) redis.opsForValue().set(cacheKey, serialize(value), ttl, SECONDS);
return value;
```

🔑 **Không negative-cache** (không ghi khi `null`/rỗng):
```java
// KHÔNG cache list rỗng: hr-backend lỗi tạm thời trả [] mà cache lại thì
// worker thấy rỗng suốt TTL dù dữ liệu đã đúng. Chỉ cache khi có kết quả để lần sau tự hồi.
if (!result.isEmpty()) { redis.opsForValue().set(cacheKey, json, ttl, SECONDS); }
```

⚠️ **Ngoại lệ có lý do**: `RecruitmentAreaCacheServiceImpl` **cố ý** cache list rỗng —
> *"vị trí không cấu hình khu vực là **trạng thái ổn định**, cache lại để mỗi lần check-in không phải deserialize lại toàn bộ cache việc làm."*

💡 Phân biệt: rỗng vì **lỗi tạm thời** (không cache) vs rỗng vì **cấu hình thật** (cache được).

Dùng cho: news detail (300s), `cache:my-recruitments:{userId}` (180s).

---

## 6. Pattern 3 — Spring `@Cacheable`

```java
@Cacheable(value = "event-types", key = "'codes'")
public Set<String> getActiveEventCodes() { ... }
```
Cấu hình TTL trong `CacheConfig` → `RedisCacheManager`.
💡 Dùng khi chỉ cần "nhớ kết quả N giây", không cần version/hash.
⚠️ Cũng bị **self-invocation** như `@Transactional`.
⚠️ Chỉ có **1** cache name dùng cách này trong toàn dự án (`event-types`).

---

## 7. Pattern 4 — Derived cache (cắt nhỏ payload lớn)

```java
public List<WorkAreaDto> findByRecruitmentId(Integer recruitmentId) {
    String key = "timekeep:areas:" + recruitmentId;
    String cached = redis.opsForValue().get(key);
    if (cached != null) return deserialize(cached);
    List<WorkAreaDto> areas = loadFromRecruitmentCache(recruitmentId);   // đọc từ cache:data:recruitment
    redis.opsForValue().set(key, serialize(areas), 900, SECONDS);        // ghi cả khi rỗng
    return areas;
}
```

🔑 **Bài toán:** payload chung `cache:data:recruitment` **~564KB cho 113 vị trí**. Deserialize mỗi lần check-in là quá đắt khi chỉ cần khu vực của 1 vị trí.
🔑 **TTL (900s) đặt DÀI HƠN chu kỳ sync** → key tự làm mới sau khi CRM đổi cấu hình, và tự hồi nếu Redis mất key.

---

## 8. Bảng Redis key đầy đủ

### Phiên đăng nhập (`RedisTokenService`)
| Key | Value | TTL |
|---|---|---|
| `auth:refresh:uid:{userId}` | token | `app.jwt.refresh-token-expiry` |
| `auth:refresh:tkn:{token}` | userId | như trên |
| `auth:otp:session:{uuid}` | `{userId}:{verifyKey}` | 900s |
| `auth:otp:tokenotp:{tokenOtp}` | userId | 1800s |
| `auth:otp:lock:{userId}` | `"1"` | 5s |
| `auth:register:pending:{uuid}` | JSON đăng ký (password đã BCrypt) | 900s |
| `auth:register:lock:{phone}` | `"1"` | 5s |

🔑 **Lưu 2 chiều** refresh token vì có 2 nhu cầu: `logout(userId)` cần `uid→token`, `refresh(token)` cần `token→uid`.

### Cache dữ liệu
| Key | TTL |
|---|---|
| `cache:version:master-data` / `cache:data:master-data` | ∞ |
| `cache:version:recruitment` / `cache:data:recruitment` | ∞ |
| `cache:version:company` / `cache:data:company` | ∞ |
| `cache:version:news` / `cache:data:news-hot` `-pin` `-normal` | ∞ |
| `cache:version:gift-brand` / `cache:data:gift-brand` | ∞ |
| `cache:version:gift` / `cache:data:gift` | ∞ |
| `cache:news-detail:id:{id}` / `:slug:{slug}` | 300s |
| `cache:my-recruitments:{userId}` | 180s |
| `timekeep:areas:{recruitmentId}` | 900s |
| `event-types::codes` / `::options` (Spring Cache) | 300s |

### Dedup
| Key | TTL |
|---|---|
| `rule:event:dedup:{userId}:{eventType}:{phút}` | 300s |

---

## 9. Nguyên tắc chung: Redis lỗi KHÔNG được làm sập

```java
try {
    String cached = redis.opsForValue().get(key);
    if (cached != null) return objectMapper.readValue(cached, ...);
} catch (Exception e) {
    log.warn("cache read failed: ..., debug={}", DebuggingDTO.build(e));
}
// đi tiếp: gọi nguồn thật
```
🔑 Mọi thao tác Redis trong dự án đều bọc `try/catch` + `log.warn`. Redis chết ⇒ chậm hơn (gọi nguồn thật) chứ **không lỗi**.

⚠️ Ngoại lệ: `RedisTokenService` **không** bọc — vì Redis chết thì không đăng nhập/refresh được thật (không có nguồn thay thế).

---

## 10. `StringRedisTemplate` vs `RedisTemplate`

Dự án dùng **`StringRedisTemplate`** ở mọi nơi (trừ `@Cacheable` dùng `GenericJackson2JsonRedisSerializer`).
🔑 Lý do: giá trị lưu là **chuỗi JSON tự serialize bằng `ObjectMapper`** → kiểm soát hoàn toàn định dạng, đọc được bằng `redis-cli` khi debug, không phụ thuộc serializer của Spring.
