# behavior-events — Cấu trúc package & bản đồ class

## 1. Cây thư mục

```
src/main/java/com/ttt/v3m/app/event/
├── AppEventServiceApplication.java      ← entry point
├── cache/
│   ├── BehaviorMappingCache.java        ← cache bảng dịch tên hành vi (reload 2h)
│   └── UserResolutionCache.java         ← cache userId→phone→customerId (lazy)
├── config/
│   ├── JacksonConfig.java               ← ObjectMapper @Primary
│   └── SecondaryDataSourceConfig.java   ← 2 JdbcTemplate phụ (MariaDB + CDP)
├── controller/
│   └── AppEventController.java          ← 3 endpoint
├── entities/
│   ├── AppEventEntity.java              ← t_app_event
│   └── BehaviorMappingEntity.java       ← t_behavior_mapping
├── exception/
│   ├── GlobalExceptionHandler.java      ← @RestControllerAdvice
│   ├── ResourceNotFoundException.java
│   └── ValidationException.java
├── kafka/
│   ├── IAppEventProducer.java           ← interface (để mock trong test)
│   ├── AppEventProducer.java            ← → app-event-topic
│   ├── BehaviorEventProducer.java       ← → cdp-behavior-topic
│   └── AppEventConsumer.java            ← ← app-event-topic
├── model/
│   ├── common/ApiResponse.java          ← wrapper {success, message, data}
│   ├── message/AppEventMessage.java     ← payload Kafka (nội bộ)
│   ├── request/TrackEventRequest.java   ← body API (snake_case)
│   └── response/
│       ├── EventResponseStatus.java     ← ACCEPTED | FAILED
│       ├── ReprocessResult.java         ← {total, forwarded, skipped}
│       └── TrackEventResponse.java      ← {eventId, status, message}
├── repositories/
│   ├── AppEventRepository.java
│   └── BehaviorMappingRepository.java
├── service/
│   ├── iface/IAppEventService.java
│   └── impl/
│       ├── AppEventServiceImpl.java     ← publish + save
│       ├── BehaviorForwardService.java  ← 🔑 trái tim: dịch tên + forward CDP
│       └── BehaviorReprocessService.java← chạy lại event cũ
├── swagger/Swagger2Config.java
└── utils/common/DebuggingDTO.java       ← chuẩn hoá log exception
```

## 2. Convention thư mục (theo `CLAUDE.md` của repo)

```
entities/            ← @Entity
entities/enums/
repositories/        ← Spring Data JPA interface
service/iface/       ← interface, có Javadoc BẮT BUỘC
service/impl/        ← implementation
controller/
kafka/
model/common/        ← DTO dùng chung
model/request/
model/response/
model/message/       ← payload Kafka
```
> Service này chỉ có **1 domain** (event tracking) nên không có sub-folder domain.
> Nếu thêm domain mới (vd `session`) thì tạo `entities/session/`, `service/session/iface/`…

## 3. Entry point

```java
@SpringBootApplication
@EnableTransactionManagement
@EnableJpaAuditing                                       // @CreatedDate tự điền
@ConfigurationPropertiesScan
@EntityScan(basePackages = {"...event.entities"})        // vì có datasource phụ nên khai báo tường minh
@EnableJpaRepositories(basePackages = {"...event.repositories"})
@EnableScheduling                                        // cho @Scheduled reload cache
public class AppEventServiceApplication { ... }
```

💡 **Vì sao phải khai `@EntityScan`/`@EnableJpaRepositories` tường minh?**
Có `SecondaryDataSourceConfig` tạo thêm `DataSource` khác. Khi context có nhiều `DataSource`, cấu hình auto của Spring Boot dễ nhập nhằng → khai báo rõ ràng phạm vi quét cho **JPA chính** (PostgreSQL) là an toàn; 2 datasource phụ chỉ dùng `JdbcTemplate` thô, không qua JPA.

## 4. Bản đồ phụ thuộc (ai gọi ai)

```
AppEventController
   ├─→ IAppEventService (AppEventServiceImpl)
   │      ├─→ IAppEventProducer (AppEventProducer) ──→ Kafka app-event-topic
   │      ├─→ AppEventRepository                   ──→ PostgreSQL
   │      └─→ BehaviorForwardService  (@Lazy — vì vòng phụ thuộc gián tiếp)
   │             ├─→ BehaviorMappingCache   ──→ BehaviorMappingRepository ──→ PG
   │             ├─→ UserResolutionCache    ──→ mariadbJdbcTemplate / cdpJdbcTemplate
   │             └─→ BehaviorEventProducer  ──→ Kafka cdp-behavior-topic
   └─→ BehaviorReprocessService
          ├─→ AppEventRepository (đọc theo khoảng created_at, phân trang 500)
          └─→ BehaviorForwardService

AppEventConsumer ←── Kafka app-event-topic
   └─→ IAppEventService.saveEvent()
```

⚠️ Chú ý `@Lazy` trên `BehaviorForwardService` trong `AppEventServiceImpl`:
```java
@Lazy
private final BehaviorForwardService behaviorForwardService;
```
Dùng để phá vòng phụ thuộc lúc khởi tạo bean (`BehaviorReprocessService` → `BehaviorForwardService`, còn `AppEventServiceImpl` cũng cần nó). `@Lazy` khiến Spring inject một **proxy**, chỉ khởi tạo bean thật khi gọi method đầu tiên.

## 5. Đi tiếp

→ [`02-api-controller.md`](02-api-controller.md)
