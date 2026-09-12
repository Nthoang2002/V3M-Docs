# behavior-events — Config, Build, Deploy, Test

## 1. `bootstrap.yml` (file duy nhất trong repo)

```yaml
spring:
  application:
    id: 33
    name: APP-EVENT-SERVICE
  cloud:
    config:
      uri: ${CONFIG_SERVER_URI:http://config-server:8888}
```

🔑 **Chỉ có thế.** Toàn bộ cấu hình thật (DB, Kafka, secret) nằm ở **Spring Cloud Config Server**, service kéo về lúc khởi động theo `spring.application.name`.
💡 `bootstrap.yml` được đọc **trước** `application.yml` (trong bootstrap context) — vì phải biết địa chỉ config server trước khi có thể tải cấu hình chính.

## 2. `application-bk.yml` — bản sao lưu tham chiếu

File `bk` = backup, **không được load** (profile không tồn tại). Dùng để biết cấu hình thực tế trông thế nào:

```yaml
server:
  port: 9093
  max-http-header-size: 100000000

spring:
  application:
    name: event-service
  sleuth:
    sampler:
      probability: 1.0                 # trace 100% request

  datasource:                          # ← PostgreSQL (datasource CHÍNH, cho JPA)
    driver-class-name: org.postgresql.Driver
    url: jdbc:postgresql://192.168.25.81:5432/cdp?currentSchema=app_event
    username: ${DB_USERNAME:n8n}
    password: ${DB_PASSWORD:Abc@1234}       # CHANGE IN PROD

  jpa:
    hibernate:
      ddl-auto: none                   # 🔑 KHÔNG tự tạo bảng
    properties:
      hibernate:
        dialect: org.hibernate.dialect.PostgreSQL10Dialect
        default_schema: app_event
        jdbc:
          lob:
            non_contextual_creation: true   # tránh warning JDBC LOB với PostgreSQL

  kafka: ...                           # xem 03-kafka.md

management:
  endpoint:
    web:
      exposure:
        include: "*"                   # ⚠️ mở TẤT CẢ actuator — chỉ hợp lý trong mạng nội bộ
    health:
      show-details: always

eureka:
  client:
    enabled: false                     # ⚠️ đang TẮT ở bản này
    service-url:
      defaultZone: http://v3m-eureka-server-8761-service:8761/eureka/
    fetchRegistry: false

kafka:
  event-topic: app-event-topic
  behavior-topic: cdp-behavior-topic
```

⚠️ Ngoài ra còn 2 nhóm key **không có trong file bk** nhưng code có dùng (`SecondaryDataSourceConfig`):
```yaml
mariadb.datasource.{url,username,password,driver-class-name}   # DB v3m cũ
cdp.datasource.{url,username,password,driver-class-name}       # PG cdp public schema
```
→ Chúng nằm ở Config Server. Thiếu là **sập lúc startup** (`@Value` không có default).

## 3. `pom.xml`

```xml
<parent>
    <groupId>com.ttt</groupId><artifactId>core</artifactId><version>0.0.5</version>
</parent>
<artifactId>app-event-service</artifactId>
<version>1.0.0</version>
```
Parent `com.ttt:core` là POM nội bộ (tải từ GitLab Maven registry `https://git.3tit.vn/api/v4/groups/19/-/packages/maven`) — nó khai `spring-boot-starter-parent` + version chung.

Dependency đáng chú ý:
| Dependency | Vì sao có |
|---|---|
| `spring-boot-starter-data-jpa` | JPA + Hibernate |
| `postgresql` 42.6.0 | driver DB chính |
| **`mariadb-java-client` 3.1.4** | 🔑 driver cho datasource phụ (đọc `base_user`) |
| `spring-kafka` | producer + consumer |
| `springfox-swagger2` / `-ui` 2.8.0 | Swagger 2 |
| `jackson-databind` 2.10.2 | JSON |
| `mapstruct` 1.5.5.Final | (khai báo sẵn, service này chưa dùng mapper nào) |
| `lombok` 1.18.20 (`provided`) | `@Data`, `@Builder`, `@Slf4j` |
| `commons-lang3` | `ExceptionUtils` trong `DebuggingDTO` |
| `spring-cloud-starter-sleuth` 2.2.2 | trace id trong log |
| `spring-boot-starter-validation` | Bean Validation (`@NotBlank`) |

Build plugin:
```xml
<maven-compiler-plugin>
  <source>11</source><target>11</target>
  <compilerArgument>-parameters</compilerArgument>   <!-- giữ tên tham số cho Spring binding -->
  <annotationProcessorPaths>lombok, mapstruct-processor</annotationProcessorPaths>
</maven-compiler-plugin>
<maven-surefire-plugin>
  <testFailureIgnore>true</testFailureIgnore>        <!-- ⚠️ test fail KHÔNG chặn build -->
</maven-surefire-plugin>
```
⚠️ `testFailureIgnore=true` — CI **vẫn build image** dù test đỏ. Là đánh đổi tốc độ, nhưng phải tự chạy `mvn test` và đọc kết quả.

## 4. `Dockerfile`

```dockerfile
FROM registry.3tit.vn/base/base-docker-image/images/openjdk:11.0.6-jre
WORKDIR /app
COPY ./target/app-event-service-1.0.0.jar /app/app-event-service.jar
ENV TZ="Asia/Ho_Chi_Minh"
ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS} -jar /app/app-event-service.jar"]
```
- Base image **nội bộ** (không kéo từ Docker Hub).
- `TZ` set tường minh — quan trọng vì `LocalDateTime.now()` phụ thuộc timezone của JVM.
- `${JAVA_OPTS}` truyền từ Helm values (heap size, GC flags…).
- ⚠️ Tên jar **hardcode version `1.0.0`** → bump version trong `pom.xml` sẽ làm vỡ Dockerfile.

## 5. `.gitlab-ci.yml` — pipeline 5 stage

```
verify → build → set_version → package → deploy
```

**Chọn hành vi theo nhánh** (`workflow.rules`):
| Nhánh | `CI_EVENT` | Image tag | Deploy |
|---|---|---|---|
| `feature/*` | `dev_commit` | `dev.<short-sha>` | ❌ |
| `develop*` | `sit_commit` | `qa.<short-sha>` | ❌ |
| `release*` | `release_package` | `release.<version>` | ✅ uat |
| `hotfix*` | `hotfix_package` | `hotfix.<version>` | ✅ uat |
| `master` | `production_package` | `v.<version>` | ❌ (job deploy chỉ chạy cho release/hotfix) |
| merge request | `merge_request_event` | — | ❌ |

### `ci_set_version` — parse version từ commit message

```bash
delimiter="#"; s=$CI_COMMIT_MESSAGE$delimiter; my_array=();
while [[ $s ]]; do my_array+=( "${s%%"$delimiter"*}" ); s=${s#*"$delimiter"}; done;
Version=${my_array[1]};
```
Commit `#1.0.1# SB-4304: Track purchase event` → tách theo `#` → phần tử `[1]` = `1.0.1`.
Ghi vào `build.env` (dotenv artifact) để stage sau dùng qua biến `$BUILD_VERSION`.

### `ci_deploy` — GitOps

```bash
git clone -b ${ENVIRONMENT} https://.../v3m-core-helm-repo.git
sed -i "/  name: event-service/,/  name:/ s|tags.*|tags: ${IMAGE_TAG_PREFIX}.${BUILD_VERSION}|" values.yaml
git commit -m "vendor: Update ... image tags to ..." && git push
```
🔑 **Không `kubectl apply`.** CI chỉ **sửa file `values.yaml` trong repo Helm rồi push**; ArgoCD/Flux (hoặc pipeline khác) sẽ đồng bộ vào cluster. Đây là mô hình **GitOps** — trạng thái cluster luôn khớp với git.

## 6. Unit test

`src/test/java/...` — 5 file:

| Test | Kiểm gì |
|---|---|
| `AppEventServiceApplicationTest` | context load |
| `AppEventControllerTest` | `@WebMvcTest` — nhận object/array, validate lỗi → 400 |
| `AppEventConsumerTest` | 3 nhánh xử lý lỗi (deserialize fail / thiếu field / saveEvent fail) |
| `AppEventServiceImplTest` | dedup, serialize metadata, gọi forward |
| `BehaviorForwardServiceTest` | resolve customerId, chọn matchValue theo action, skip khi không mapping |

Convention (theo `CLAUDE.md`):
- `{ClassName}Test`, cùng package
- method: `{methodName}_{scenario}_{expectedResult}`
- JUnit 5 `@ExtendWith(MockitoExtension.class)` + `@Mock`/`@InjectMocks`
- **Không** gọi DB thật / service ngoài

## 7. Checklist khi làm việc với repo này

Theo `CLAUDE.md` của repo, trước khi commit:
1. `mvn compile` — sạch lỗi
2. `/security-review` — quét bảo mật (repo này **bắt buộc**, khác customer-service để optional)
3. `/doc-flow` — tạo/cập nhật doc trong `docs/`
4. `/versioning` — bump version
5. Gộp tất cả vào **1 commit duy nhất**

Nhánh: `feature/{TICKET}-{mo-ta}` từ `master`, **không commit thẳng master**.

## 8. Hết phần behavior-events

→ Sang service lớn: [`../02-customer-service/00-tong-quan.md`](../02-customer-service/00-tong-quan.md)
