# Tra cứu nhanh — Toàn bộ API

**Cột "Auth"**: `public` = trong `PUBLIC_URLS` (không kiểm JWT ở service) · `JWT` = cần token user · `ADMIN` = `hasRole("ADMIN")` · `GW` = auth do gateway đảm nhiệm (server-to-server).

---

# A. behavior-events (app-event-service) — port 9093

| Method | Path | Auth | Controller | Doc |
|---|---|---|---|---|
| POST | `/api/events` | GW | `AppEventController` | [02](../01-behavior-events/02-api-controller.md) |
| POST | `/api/events/Reprocess?from=&to=` | GW | `AppEventController` | [02](../01-behavior-events/02-api-controller.md) |
| GET | `/api/events/health` | GW | `AppEventController` | |

---

# B. customer-service

## B1. Auth (`/auth/**` — toàn bộ **public** ở tầng URL)

| Method | Path | Auth | Body chính | Doc |
|---|---|---|---|---|
| POST | `/auth/login` | public | `{phone, password(RSA)}` | [05](../02-customer-service/05-module-auth.md) |
| POST | `/auth/send-otp` | public | `{phone, password(RSA), fullName, referralCode}` | |
| POST | `/auth/register` | public | `{uuid, otp, verifyKey}` | |
| POST | `/auth/resend/verify` | public | `{uuid, verifyKey}` | |
| POST | `/auth/logout` | JWT* | — | |
| POST | `/auth/refresh` | public | `{refreshToken}` | |
| POST | `/auth/forgot-password` | public | `{phone}` | |
| POST | `/auth/forgot-otp/verify` | public | `{uuid, otp, verifyKey}` | |
| POST | `/auth/forgot-otp/resend` | public | `{uuid, verifyKey}` | |
| POST | `/auth/reset-password` | public | `{tokenOtp, newPassword(RSA)}` | |
| POST | `/auth/change-password` | JWT* | `{currentPassword, newPassword, confirmPassword}` (RSA) | |

⚠️ `*` = permitAll ở tầng URL nhưng dùng `@RequestAttribute("userId")` ⇒ thiếu JWT sẽ **401**.

## B2. Profile & KYC

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/profile` | JWT | [07](../02-customer-service/07-module-profile-bank-agreement.md) |
| PUT | `/profile` | JWT | |
| POST | `/profile/kyc/ocr` (multipart: `front`, `back`) | JWT | [06](../02-customer-service/06-module-kyc.md) |
| POST | `/profile/kyc/confirm` (multipart: `frontKey`, `backKey`, `face`) | JWT | |
| POST | `/profile/kyc/restart` | JWT | |

## B3. Bank account

| Method | Path | Auth |
|---|---|---|
| GET | `/profile/bank-accounts` | JWT |
| POST | `/profile/bank-accounts` | JWT |
| PUT | `/profile/bank-accounts/{id}` | JWT |
| DELETE | `/profile/bank-accounts/{id}` | JWT |
| PATCH | `/profile/bank-accounts/{id}/set-default` | JWT |

## B4. Agreement (điều khoản)

| Method | Path | Auth |
|---|---|---|
| GET | `/agreements/current` | **public** |
| GET | `/agreements/versions` | **public** (khai riêng theo method) |
| POST | `/agreements/versions` | **ADMIN** |
| GET | `/agreements/status` | JWT |
| POST | `/agreements/accept` | JWT |

## B5. Cache / Master data

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/cache/version` | **public** | [08](../02-customer-service/08-module-cache-masterdata.md) |
| GET | `/master-data` | **public** | |
| GET | `/recruitments/all` | **public** | |
| GET | `/companies/all` | **public** | |
| POST | `/admin/cache/refresh` | ADMIN (`@PreAuthorize`) | |

## B6. News

| Method | Path | Auth |
|---|---|---|
| GET | `/news/hot` · `/news/pin` · `/news/normal` | **public** |
| GET | `/news/detail?id=` | **public** |
| GET | `/news/detail-slug?slug=` | **public** |

## B7. Favorites

| Method | Path | Auth |
|---|---|---|
| POST | `/favorites` | JWT |
| GET | `/favorites` | JWT |

## B8. Apply (ứng tuyển)

| Method | Path | Auth | Doc |
|---|---|---|---|
| POST | `/applies` | JWT | [09](../02-customer-service/09-module-apply.md) |
| GET | `/applies` | JWT | |

## B9. Timekeeping (chấm công)

| Method | Path | Auth | Doc |
|---|---|---|---|
| POST | `/timekeeping/check` | JWT | [10](../02-customer-service/10-module-timekeeping.md) |
| GET | `/timekeeping/status?recruitmentId=` | JWT | |
| POST | `/timekeeping/monthly` | JWT | |
| GET | `/timekeeping/my-recruitments` | JWT | |
| POST | `/timekeeping/resign?recruitmentId=` | JWT | |
| POST | `/timekeeping/start-work?recruitmentId=` | JWT | |
| POST | `/timekeeping/missed-checkout/report?recruitmentId=` | JWT | |
| GET | `/timekeeping/admin/list?recruitmentId=&from=&to=&page=&size=` | **public** (GW) | |
| PUT | `/timekeeping/admin/approve` | **public** (GW) | |
| GET | `/timekeeping/missed-checkout?date=` | **public** (GW) | |
| POST | `/timekeeping/missed-checkout/reset?date=` | **public** (GW) | |
| GET | `/timekeeping/sync?date=` | **public** (GW) | |
| GET | `/timekeeping/sync/updated?date=` | **public** (GW) | |

## B10. Mission & Point (app)

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/missions?routerCode=` | JWT | [12](../02-customer-service/12-module-rule-engine.md) — 🔑 **GET này GHI DB** |
| POST | `/missions/{earnRuleId}/accept` | JWT | |
| GET | `/missions/points` | JWT | |
| GET | `/missions/points/history?direction=ALL\|EARNED\|SPENT` | JWT | |

## B11. Gift (quà Urbox)

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/gifts/brands` | **public** | [13](../02-customer-service/13-module-gift-urbox.md) |
| GET | `/gifts?category=&brand=&title=&page=&size=` | JWT | |
| PUT | `/gifts/{giftId}/points` | **ADMIN** | |
| POST | `/gifts/{giftId}/redeem` | JWT | |
| GET | `/gifts/redemptions` | JWT | |

## B12. Reward (thưởng tiền)

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/rewards/all` | JWT | [14](../02-customer-service/14-module-reward-incentive.md) |
| GET | `/rewards/mc-bonus?profileId=` | JWT + `ownsProfile` | |
| GET | `/rewards/spot-bonus?profileId=` | JWT + `ownsProfile` | |
| GET | `/rewards/attendance-bonus?profileId=` | JWT + `ownsProfile` | |
| GET | `/rewards/actual-work-bonus?profileId=` | JWT + `ownsProfile` | |
| GET | `/rewards/types?profileId=` | JWT + `ownsProfile` | |

## B13. Incentive (hoa hồng CTV)

| Method | Path | Auth |
|---|---|---|
| GET | `/incentives/chart?year=` | JWT |
| GET | `/incentives/total?year=&month=` | JWT |
| GET | `/incentives?year=&month=&paymentIds=&orderBy=&page=&size=` | JWT |
| GET | `/incentives/statuses` | JWT |

## B14. CTV

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/ctv/contract` | JWT | [16](../02-customer-service/16-module-ctv.md) |
| POST | `/ctv/contract/sign` | JWT | |

## B15. Notification

| Method | Path | Auth | Doc |
|---|---|---|---|
| PUT | `/notifications/fcm-token` | JWT | [15](../02-customer-service/15-module-notification-fcm.md) |
| GET | `/notifications` | JWT | |
| GET | `/notifications/unread-count` | JWT | |
| POST | `/notifications/{id}/read` | JWT | |
| POST | `/add-role-notification` | **public** (GW) | 🔑 Vỏ tương thích v3m-core-service |

## B16. Rule config (admin)

| Method | Path | Auth | Doc |
|---|---|---|---|
| POST | `/earn-rules` | **ADMIN** | [11](../02-customer-service/11-module-rule-config.md) |
| GET | `/earn-rules?keyword=&page=&size=` | **ADMIN** | |
| GET | `/earn-rules/{id}` | **ADMIN** | |
| PUT | `/earn-rules/{id}` | **ADMIN** | |
| DELETE | `/earn-rules/{id}` | **ADMIN** | |
| GET | `/earn-rules/options` | **ADMIN** | |

## B17. Admin — tra cứu giao dịch

| Method | Path | Auth | Doc |
|---|---|---|---|
| GET | `/gift-redemptions?giftIds=&brandIds=&catIds=&userIds=&userKeyword=&status=&code=&from=&to=` | **ADMIN** | [17](../02-customer-service/17-module-admin.md) |
| GET | `/gift-redemptions/filter-option` | **ADMIN** | |
| GET | `/gift-redemptions/{id}` | **ADMIN** | |
| GET | `/earn-transactions?earnRuleIds=&userIds=&code=&from=&to=` | **ADMIN** | |
| GET | `/earn-transactions/{id}` | **ADMIN** | |
| GET | `/earn-transactions/filter-option` | **ADMIN** | |
| GET | `/users/{userId}` | **ADMIN** | |
| GET | `/users/{userId}/points` | **ADMIN** | |
| GET | `/gift-price-history?giftId=&page=&size=` | **ADMIN** | |

## B18. Internal (server-to-server, auth ở gateway)

| Method | Path | Gọi bởi |
|---|---|---|
| POST | `/admin/users/sync` (≤1000 item) | CRM sync |
| POST | `/internal/users/batch` (≤500 customerId) | hệ khác |
| POST | `/internal/users/batch-by-phone` | backfill `AppProfile.CustomerId` |
| POST | `/internal/bank-accounts/batch` (≤100 phone) | hệ khác |
| POST | `/internal/notifications/send` | hr-backend |
| POST | `/internal/worker-recruitment-status/sync` | sync-data-crm |

---

# C. Swagger

| Service | URL |
|---|---|
| behavior-events | `http://{host}:9093/swagger-ui.html` |
| customer-service | `http://{host}/swagger-ui.html` (có nút Authorize — header `Authorization`) |

# D. Actuator

`/actuator/**` — trong `PUBLIC_URLS`, `management.endpoints.web.exposure.include: "*"`.
Metric Prometheus: `/actuator/prometheus`.
