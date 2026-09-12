# customer-service — Cấu trúc package

## 1. Convention thư mục (BẮT BUỘC theo `CLAUDE.md`)

```
com.ttt.v3m.app.customer
├── entities/{module}/            ← @Entity
├── entities/{module}/enums/
├── repositories/{module}/        ← Spring Data JPA
├── service/{module}/iface/       ← interface (Javadoc BẮT BUỘC)
├── service/{module}/impl/        ← implementation
├── controller/{module}/
└── model/{module}/{request,response}/
```
> **Mỗi sub-domain mới phải có đủ 4 vị trí** (entities, repositories, service iface, service impl).
> Không gộp sub-domain vào folder của sub-domain khác.

## 2. Cây thư mục đầy đủ (main)

```
com/ttt/v3m/app/customer/
├── AppCustomerServiceApplication.java
│
├── config/                                  # 12 class cấu hình
│   ├── AsyncConfig            @EnableAsync (cho FcmDispatchService)
│   ├── CacheConfig            RedisCacheManager (Spring Cache abstraction)
│   ├── JacksonConfig          ObjectMapper @Primary
│   ├── QuartzJobConfig        8 JobDetail + 8 Trigger
│   ├── S3Config / S3Properties
│   ├── FcmConfig / FcmProperties
│   ├── HrBackendProperties · UrboxProperties
│   ├── proxy/                 # 7 Feign client + 3 config
│   │   ├── EnableServiceProxy      (annotation gộp @EnableFeignClients)
│   │   ├── DefaultFeignConfig      (JSON + timeout)
│   │   ├── MultipartFeignConfig    (form encoder + decoder cho EKYC)
│   │   ├── HrBackendProxy          hr-backend — api-key (S2S)
│   │   ├── HrDataProxy             hr-backend — Basic Auth
│   │   ├── HrAppAuthProxy          hr-backend — multipart (đẩy OCR)
│   │   ├── CdpProxy                CDP
│   │   ├── EkycProxy               EKYC AI (OCR + match face)
│   │   ├── UrboxProxy              Urbox (quà)
│   │   └── MobifiOtpProxy          OTP SMS
│   └── security/
│       ├── SecurityConfig          WebSecurityConfigurerAdapter
│       ├── JwtAuthFilter           OncePerRequestFilter
│       └── UserDetailsServiceImpl
│
├── controller/                              # 20 controller
│   ├── admin/AdminTransactionController
│   ├── agreement/AgreementController
│   ├── app/AppMissionController
│   ├── apply/ApplyController
│   ├── auth/{AuthController, ProfileController, BankAccountController, UserSyncController}
│   ├── cache/CacheController
│   ├── ctv/CtvController
│   ├── gift/GiftController
│   ├── incentive/IncentiveController
│   ├── internal/{InternalUserController, InternalBankAccountController,
│   │             InternalNotificationController, InternalWorkerRecruitmentStatusController}
│   ├── news/NewsController
│   ├── notification/{NotificationController, CrmRoleNotificationController}
│   ├── recruitment/FavoriteController
│   ├── reward/RewardController
│   ├── rule/config/EarnRuleController
│   └── timekeeping/TimekeepController
│
├── entities/                                # 22 entity
│   ├── agreement/{AgreementVersionEntity, UserAgreementEntity}
│   ├── apply/{ApplyEntity, enums/SyncStatus}
│   ├── auth/{UserEntity, UserBankAccountEntity, UserSource, enums/{UserRole,UserStatus}}
│   ├── cache/SystemConfigEntity
│   ├── ctv/{CtvContractEntity, enums/CtvContractStatus}
│   ├── gift/{GiftPriceEntity, GiftPriceHistoryEntity, GiftRedemptionEntity, enums/…}
│   ├── notification/{NotificationEntity, UserDeviceEntity}
│   ├── router/AppRouterEntity
│   ├── rule/config/{EarnRuleEntity, RuleConditionGroupEntity, RuleConditionEntity,
│   │                DisplayConditionGroupEntity, DisplayConditionEntity,
│   │                EventTypeEntity, LogicOperatorEntity, enums/…}
│   ├── rule/engine/{UserPoint, UserRuleProgress, PointTransaction, enums/TransactionType}
│   └── timekeeping/{TimekeepRecordEntity, WorkerRecruitmentStatusEntity}
│
├── repositories/                            # 22 repository (cùng cấu trúc module)
│
├── service/                                 # 16 module
│   ├── admin/       AdminTransactionService(Impl)
│   ├── agreement/   AgreementService(Impl)
│   ├── apply/       ApplyService(Impl)
│   ├── auth/        AuthService, KycService, OtpService, ProfileService,
│   │                BankAccountService, UserSyncService, UserSyncItemService
│   ├── cache/       HrCacheService(Impl), SystemConfigService(Impl)
│   ├── cdp/         CdpCustomerService(Impl)
│   ├── ctv/         CtvService(Impl)
│   ├── gift/        GiftService, GiftCacheService, GiftPriceService,
│   │                GiftRedemptionService, GiftRedemptionTxService
│   ├── incentive/   IncentiveService(Impl)
│   ├── news/        NewsService(Impl)
│   ├── notification/NotificationService(Impl), FcmDispatchService
│   ├── recruitment/ FavoriteService(Impl)
│   ├── reward/      RewardService(Impl)
│   ├── router/      AppRouterService(Impl)
│   ├── rule/config/ EarnRuleService, EarnRuleQueryService, RuleValidationService, EventTypeCacheService
│   ├── rule/engine/ RuleEngineService, RuleEvaluationService, MissionEnrollmentService
│   ├── storage/     StorageService → S3StorageService
│   ├── timekeeping/ TimekeepService, FaceRecognitionService,
│   │                RecruitmentAreaCacheService, WorkerRecruitmentStatusSyncService
│   └── worker/      WorkerProfileService(Impl)      ← 🔑 nguồn duy nhất userId→profileIds
│
├── job/                                     # 8 Quartz job
│   ├── MasterDataSyncJob · RecruitmentSyncJob · CompanySyncJob · NewsSyncJob · GiftSyncJob
│   ├── CdpProfileSyncJob · CdpBackfillJob · KycImageMigrateJob
│
├── kafka/                                   # 3 consumer
│   ├── CdpBehaviorSavedConsumer   ← cdp-behavior-saved     → rule engine
│   ├── RuleEventConsumer          ← rule-events            → rule engine
│   └── HrTimekeepingSyncConsumer  ← hr-timekeeping-sync    → timekeep_record + publish CDP
│
├── model/                                   # ~150 DTO
│   ├── common/{ApiResponse, PageResponse}
│   ├── admin/ · agreement/ · apply/ · auth/{request,response} · cache/ · cdp/ · ctv/
│   ├── ekyc/ · gift/ · hr/ · incentive/ · notification/ · otp/ · recruitment/
│   ├── reward/ · router/ · rule/{config,engine}/{request,response} · timekeeping/ · urbox/
│
├── exception/{GlobalExceptionHandler, ResourceNotFoundException, ValidationException}
├── swagger/Swagger2Config
└── utils/
    ├── auth/{JwtUtil, RedisTokenService, RsaUtil, Rc2DecryptUtil}
    ├── common/{DebuggingDTO, GeoUtils, InMemoryMultipartFile}
    ├── fcm/{FcmSender, FcmSendResult}
    ├── hr/HrBackendClient           ← facade 493 dòng bọc 2 Feign proxy
    └── urbox/{UrboxClient, UrboxSignatureUtil}
```

## 3. Class lớn nhất — đọc theo thứ tự này

| # | Class | Dòng | Vì sao quan trọng |
|---|---|---|---|
| 1 | `RuleEngineServiceImpl` | 765 | Trái tim nghiệp vụ điểm thưởng |
| 2 | `TimekeepServiceImpl` | 612 | Module phức tạp nhất về nghiệp vụ |
| 3 | `HrBackendClient` | 493 | Mọi giao tiếp với CRM |
| 4 | `KycServiceImpl` | 445 | OCR + face + validate bộ ảnh |
| 5 | `AdminTransactionServiceImpl` | 426 | Specification API (query động) |
| 6 | `AuthServiceImpl` | 323 | Login/đăng ký/OTP/token |
| 7 | `HrCacheServiceImpl` | 318 | Pattern cache MD5-version |
| 8 | `RewardServiceImpl` | 314 | Proxy + hàng rào sở hữu + metric |

## 4. Entry point

```java
@SpringBootApplication
@EnableTransactionManagement
@EnableJpaAuditing                                        // @CreatedDate / @LastModifiedDate
@ConfigurationPropertiesScan                              // quét @ConfigurationProperties
@EntityScan(basePackages = {"com.ttt.v3m.app.customer.entities"})
@EnableJpaRepositories(basePackages = {"com.ttt.v3m.app.customer.repositories"})
@EnableScheduling
@EnableFeignClients
@EnableServiceProxy                                       // annotation tự định nghĩa
public class AppCustomerServiceApplication { ... }
```

`@EnableServiceProxy` là annotation **tự viết** (`config/proxy/EnableServiceProxy.java`):
```java
@Retention(RUNTIME) @Target(TYPE)
@EnableFeignClients(basePackages = "com.ttt.v3m.app.customer.config.proxy")
@Import({DefaultFeignConfig.class})
public @interface EnableServiceProxy {}
```
💡 Gom 2 annotation thành 1 để chỗ dùng gọn — kỹ thuật **meta-annotation** của Spring.

## 5. Đi tiếp

→ [`02-khoi-dong-config.md`](02-khoi-dong-config.md)
