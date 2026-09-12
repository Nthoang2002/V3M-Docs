# Tra cứu nhanh — Config keys

Toàn bộ cấu hình nằm ở **Spring Cloud Config Server** (repo git, branch theo môi trường).
Trong repo chỉ có `bootstrap.yml`.

---

# A. behavior-events

## `bootstrap.yml` (trong repo)
```yaml
spring.application.id: 33
spring.application.name: APP-EVENT-SERVICE
spring.cloud.config.uri: ${CONFIG_SERVER_URI:http://config-server:8888}
```

## Từ Config Server
| Key | Mặc định | Dùng ở đâu |
|---|---|---|
| `server.port` | 9093 | |
| `spring.datasource.{url,username,password,driver-class-name}` | PostgreSQL `cdp?currentSchema=app_event` | JPA chính |
| `spring.jpa.hibernate.ddl-auto` | `none` | 🔑 không tự tạo bảng |
| `spring.jpa.properties.hibernate.dialect` | `PostgreSQL10Dialect` | |
| `spring.jpa.properties.hibernate.default_schema` | `app_event` | |
| **`mariadb.datasource.{url,username,password,driver-class-name}`** | — | 🔑 `SecondaryDataSourceConfig` — đọc `base_user`. **Không có default, thiếu = sập** |
| **`cdp.datasource.{url,username,password,driver-class-name}`** | — | 🔑 đọc `customer_identity`. **Không có default** |
| `spring.kafka.consumer.group-id` | `app_event_service` | |
| `spring.kafka.consumer.auto-offset-reset` | `earliest` | |
| `spring.kafka.{consumer,producer}.bootstrap-servers` | | |
| `spring.kafka.listener.missing-topics-fatal` | `false` | |
| **`kafka.event-topic`** | `app-event-topic` | |
| **`kafka.behavior-topic`** | `cdp-behavior-topic` | |
| `spring.sleuth.sampler.probability` | 1.0 | trace 100% |
| `management.endpoint.web.exposure.include` | `*` | |
| `eureka.client.enabled` | `false` (bản bk) | |

---

# B. customer-service

## `bootstrap.yml` (trong repo)
```yaml
spring.application.id: 32
spring.application.name: APP-CUSTOMER-SERVICE
spring.cloud.config.uri: ${CONFIG_SERVER_URI:http://config-server:8888}
```

## B1. Auth & Crypto
| Key | Mặc định | Dùng ở |
|---|---|---|
| `app.jwt.secret` | — | `JwtUtil` (HS256) |
| `app.jwt.access-token-expiry` | — (ms) | `JwtUtil` |
| `app.jwt.refresh-token-expiry` | — (giây) | `RedisTokenService` |
| `app.crypto.private-key` | — | `RsaUtil` (RSA PKCS8 base64) |
| `app.sync.rc2-key` | `""` | `Rc2DecryptUtil` |
| `app.sync.rc2-iv` | `""` | `Rc2DecryptUtil` |

## B2. OTP (Mobifi)
| Key | Dùng ở |
|---|---|
| `otp.uri` | `OtpServiceImpl` |
| `otp.authorization-value` | header `x-api-key` |
| `otp.template-code` · `otp.account-code` · `otp.brand-name` | |
| `otp.expired-time` · `otp.number-limit` | |
| `otp.type-send` | `sms` \| `email` |
| **`otp.enable`** | ⚠️ mặc định `true` — **`false` trên prod = ai cũng đổi mật khẩu người khác** |

## B3. hr-backend
| Key | Dùng ở |
|---|---|
| `hr-backend.base-url` | 3 Feign proxy |
| `hr-backend.username` / `.password` | Basic Auth (`HrDataProxy`) |
| `hr-backend.partner` | header `partner`/`Partner` |
| `hr-backend.apply-api-key` | header `api-key` (`HrBackendProxy`) |
| `hr-backend.tenant-id` | `CsData/AllDistrict` |
| `hr-backend.media-base-url` | prepend URL ảnh tin tức |

## B4. CDP / EKYC / Face
| Key | Mặc định |
|---|---|
| `cdp.base-url` | — |
| `cdp.profile-sync.cron` | `0 0 * * * ?` |
| `cdp.backfill.cron` | `0 */30 * * * ?` |
| `cdp.backfill.batch-size` | `200` |
| `ekyc.base-url` | `https://ai-gw-gateway-server-uat.mobifi.vn` |
| `ekyc.api-key` | — |
| `face-recognition.api-key` | — |
| `face-recognition.min-similarity` | `0.6` |

## B5. Urbox
| Key | Mặc định |
|---|---|
| `urbox.base-url` · `urbox.app-id` · `urbox.app-secret` | — |
| `urbox.private-key` | — (RSA PKCS8 PEM, ký `cartPayVoucher`) |
| `urbox.campaign-code` | — |
| `urbox.redeem-send-sms` | `true` |
| `urbox.excluded-gift-types` | `[]` |
| `urbox.max-office-per-gift` | `50` |

## B6. S3 (FPT Object Storage)
| Key |
|---|
| `s3.endpoint` · `s3.region` · `s3.bucket` · `s3.access-key` · `s3.secret-key` |

## B7. Firebase (FCM)
| Key | Ghi chú |
|---|---|
| `firebase.credentials-json` | 🔑 **Ưu tiên** — nội dung JSON qua Config Server |
| `firebase.credentials-path` | Fallback local dev (file, đã gitignore) |

## B8. Kafka
| Key | Ghi chú |
|---|---|
| `spring.kafka.consumer.group-id` | dùng cho cả 3 consumer |
| **`kafka.topic.cdp-behavior-consume`** | `cdp-behavior-saved` |
| **`kafka.topic.cdp-behavior-publish`** | `cdp-behavior-topic` |
| **`kafka.topic.hr-timekeeping-sync`** | |
| **`rule.engine.kafka.topic`** | mặc định `rule-events` |
| **`rule.engine.event-dedup-ttl-seconds`** | mặc định `300` |

## B9. Cache & Redis
| Key | Mặc định |
|---|---|
| `spring.redis.*` | kết nối Redis |
| `spring.cache.event-types.ttl-seconds` | `300` |
| `redis.cache.news-detail.ttl-seconds` | `300` |
| `redis.cache.my-recruitments.ttl-seconds` | `180` |
| `timekeeping.area-cache.ttl-seconds` | `900` |

## B10. Quartz cron
| Key | Mặc định |
|---|---|
| `cache.sync-cron.master-data` | `0 0 */6 * * ?` |
| `cache.sync-cron.recruitment` | `0 0 */6 * * ?` |
| `cache.sync-cron.company` | `0 0 */6 * * ?` |
| `cache.sync-cron.news` | `0 0 */6 * * ?` |
| `cache.sync-cron.gift` | `0 0 */6 * * ?` |
| `cdp.profile-sync.cron` | `0 0 * * * ?` |
| `cdp.backfill.cron` | `0 */30 * * * ?` |
| `kyc.image-migrate.cron` | `0 */10 * * * ?` |

## B11. Timekeeping
| Key | Mặc định |
|---|---|
| `timekeeping.forgot-checkout-window-hours` | `16` |

## B12. Feign timeout
| Key | Mặc định |
|---|---|
| `feign.client.config.default.connect-timeout` | `3000` ms |
| `feign.client.config.default.read-timeout` | `5000` ms |
| `feign.client.config.ekyc-proxy.connect-timeout` | `5000` ms |
| `feign.client.config.ekyc-proxy.read-timeout` | **`30000`** ms (xử lý ảnh chậm) |

---

# C. Quy tắc cấu hình (từ `CLAUDE.md`)

- ❌ **Không hardcode** URL, key, secret, timeout, flag trong code Java
- ✅ Dùng `@Value("${...}")` hoặc `@ConfigurationProperties`
- ✅ Tên key **kebab-case**, nhóm theo prefix module
- ✅ Giá trị nhạy cảm phải có chú thích `# CHANGE IN PROD` trong yml
- ✅ Mọi `@Value` phải có default **hoặc** được khai rõ trong yml

⚠️ Key **không có default** mà thiếu ⇒ **sập lúc startup**:
`mariadb.datasource.*`, `cdp.datasource.*` (behavior-events) · `app.jwt.*`, `app.crypto.private-key`, `s3.*`, `ekyc.api-key`, `face-recognition.api-key`, `otp.*`, `hr-backend.*`, `urbox.*` (customer-service)
