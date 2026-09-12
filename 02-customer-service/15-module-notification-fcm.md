# customer-service — Notification & FCM

Package `service/notification` — 2 class: `NotificationServiceImpl`, `FcmDispatchService`
Util: `utils/fcm/FcmSender`, `FcmSendResult` · Config: `FcmConfig`, `AsyncConfig`

---

## 1. Hai kênh thông báo

| Kênh | Lưu ở đâu | Đọc qua |
|---|---|---|
| **Inbox** (trong app) | `t_notification` | `GET /notifications` |
| **Push** (FCM) | không lưu | Firebase → thiết bị |

2 bảng:
- `t_notification` — `user_id`, `code`, `type`, `title`, `content`, `url`, `object_id`, `count`, `is_read`, `created_at`
- `t_user_device` — `user_id`, `fcm_token` (UNIQUE), `platform`, `is_active`

---

## 2. Endpoint

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| PUT | `/notifications/fcm-token` | JWT | Đăng ký/cập nhật token thiết bị |
| GET | `/notifications` | JWT | Danh sách inbox, mới nhất trước |
| GET | `/notifications/unread-count` | JWT | Badge count |
| POST | `/notifications/{id}/read` | JWT | Đánh dấu đã đọc |
| POST | `/internal/notifications/send` | **public** (gateway) | hr-backend gửi push |
| POST | `/add-role-notification` | **public** (gateway) | 🔑 Vỏ tương thích v3m-core-service |

---

## 3. `registerDevice()` — upsert theo token

```java
@Transactional
public void registerDevice(Long userId, String fcmToken, String platform) {
    UserDeviceEntity device = userDeviceRepository.findByFcmToken(fcmToken)
            .orElseGet(() -> UserDeviceEntity.builder().fcmToken(fcmToken).build());
    device.setUserId(userId);          // 🔑 GHI ĐÈ userId
    device.setPlatform(platform);
    device.setActive(true);
    userDeviceRepository.save(device);
}
```
🔑 Upsert theo **token** (không phải theo user) — *"1 token luôn thuộc về đúng 1 user tại 1 thời điểm"*.
Tình huống: user A đăng xuất, user B đăng nhập trên **cùng thiết bị** → token cũ được gán lại cho B, A không còn nhận push của B nữa.
1 user có thể có **nhiều** thiết bị.

---

## 4. 🔑 `@Async` và bài học self-invocation

```java
/** Tách riêng bean này (KHÔNG gộp vào NotificationServiceImpl) vì @Async chỉ hoạt động qua proxy
 *  — gọi trong cùng class sẽ bị bỏ qua (self-invocation). */
@Service
public class FcmDispatchService {
    @Async
    public void dispatchAsync(List<String> tokens, String title, String body, Map<String,String> data) {
        int success = 0;
        List<String> unregisteredTokens = new ArrayList<>();

        for (String token : tokens) {
            FcmSendResult result = fcmSender.sendToToken(token, title, body, data);
            if (result == FcmSendResult.SUCCESS) success++;
            else if (result == FcmSendResult.TOKEN_UNREGISTERED) unregisteredTokens.add(token);
        }

        if (!unregisteredTokens.isEmpty()) {
            int deactivated = userDeviceRepository.deactivateByFcmTokenIn(unregisteredTokens);   // 🔑 1 câu lệnh
            log.info("FCM tokens deactivated (unregistered): count={}", deactivated);
        }
        log.info("FCM dispatch done: total={}, success={}, unregistered={}, failed={}", ...);
    }
}
```

🔑 **Cùng bài học với `@Transactional`**: `@Async` chạy qua **proxy**. `this.dispatchAsync()` trong cùng class = chạy đồng bộ, annotation vô nghĩa.
(Đây là lần thứ **3** pattern này xuất hiện trong codebase: `UserSyncItemService`, `GiftRedemptionTxService`, `FcmDispatchService`.)

### 🔑 Tự dọn token chết
```java
/** Soft-delete hàng loạt token bị Firebase báo UNREGISTERED — 1 câu lệnh cho cả batch, không lặp từng token. */
@Modifying(clearAutomatically = true)
@Query("UPDATE UserDeviceEntity d SET d.isActive = false WHERE d.fcmToken IN :tokens")
int deactivateByFcmTokenIn(@Param("tokens") List<String> tokens);
```
Firebase trả `UNREGISTERED` khi app bị gỡ / token rotate → **soft-delete** (`is_active = false`), giữ bản ghi làm lịch sử.
💡 `clearAutomatically = true` — xoá persistence context sau khi UPDATE, tránh entity trong cache còn giá trị cũ.

### `FcmSender` — phân loại kết quả
```java
public enum FcmSendResult {
    SUCCESS,
    /** Firebase báo token không còn hợp lệ (app gỡ cài đặt, token bị rotate...) — nên soft-delete. */
    TOKEN_UNREGISTERED,
    FAILED
}
```
```java
catch (FirebaseMessagingException e) {
    log.warn("FCM send failed: token={}..., errorCode={}, debug={}", safePrefix(token), e.getMessagingErrorCode(), ...);
    return e.getMessagingErrorCode() == MessagingErrorCode.UNREGISTERED
            ? FcmSendResult.TOKEN_UNREGISTERED : FcmSendResult.FAILED;
}
```
🔑 3 trạng thái (không phải boolean) vì **`UNREGISTERED` cần hành động khác** (dọn token) so với lỗi tạm thời.
```java
private String safePrefix(String token) {
    if (token == null || token.length() < 12) return "***";
    return token.substring(0, 12);         // 🔑 log 12 ký tự đầu — đủ để trace, không lộ token
}
```

---

## 5. `send()` — 2 nhánh: có `phones` vs broadcast

```java
@Transactional
public void send(SendNotificationRequest request) {
    // SB-4805: phones rỗng → broadcast push tới TOÀN BỘ thiết bị active.
    // Broadcast CHỈ bắn push, KHÔNG ghi inbox — tránh fan-out ghi N dòng t_notification
    // mỗi lần SendMessage của CRM (rất thường xuyên) làm PHÌNH BẢNG.
    if (request.getPhones() == null || request.getPhones().isEmpty()) { broadcastToAllDevices(request); return; }

    List<UserEntity> users = userRepository.findByPhoneIn(request.getPhones());
    if (users.size() != request.getPhones().size())
        log.warn("send notification — some phones not found: requested={}, matched={}", ...);
    if (users.isEmpty()) return;

    List<Long> pushEligibleUserIds = new ArrayList<>();
    for (UserEntity user : users) {
        boolean deduped = tryIncrementExisting(user.getId(), request);      // 🔑 dedup
        if (!deduped) {
            notificationRepository.save(NotificationEntity.builder()... .count(1).isRead(false).build());
            pushEligibleUserIds.add(user.getId());
        }
    }
    if (pushEligibleUserIds.isEmpty()) { log.info("send notification — all deduped, no push: ..."); return; }

    List<String> tokens = userDeviceRepository.findByUserIdInAndIsActiveTrue(pushEligibleUserIds).stream()
            .map(UserDeviceEntity::getFcmToken).collect(toList());
    fcmDispatchService.dispatchAsync(tokens, request.getTitle(), request.getContent(), buildDataMap(request));
}
```

### 🔑 Dedup: cộng dồn `count` thay vì tạo bản ghi mới
```java
/** Nếu có bản ghi CHƯA ĐỌC trùng user+objectId+code, cộng dồn count thay vì tạo mới + gửi lại push
 *  (giống DISTRIBUTE_LEADS bên v3m-core-service). */
private boolean tryIncrementExisting(Long userId, SendNotificationRequest request) {
    if (request.getObjectId() == null || request.getCode() == null) return false;
    return notificationRepository
            .findFirstByUserIdAndObjectIdAndCodeAndIsReadFalse(userId, request.getObjectId(), request.getCode())
            .map(existing -> { existing.setCount(existing.getCount() + 1);
                               notificationRepository.save(existing); return true; })
            .orElse(false);
}
```
🔑 CRM có thể phân bổ 5 lead cùng lúc → thay vì 5 thông báo, hiển thị 1 thông báo với `count = 5`.
🔑 **Dedup thì KHÔNG gửi push** (`pushEligibleUserIds` không thêm) — user không bị rung 5 lần.
🔑 Chỉ dedup khi **chưa đọc** — đã đọc rồi thì thông báo mới phải nổi lên.

### Broadcast — chỉ push, không inbox
```java
private void broadcastToAllDevices(SendNotificationRequest request) {
    List<String> tokens = userDeviceRepository.findAllActiveTokens();
    log.info("Broadcast notification to all active devices: code={}, devices={}", request.getCode(), tokens.size());
    if (tokens.isEmpty()) return;
    fcmDispatchService.dispatchAsync(tokens, request.getTitle(), request.getContent(), buildDataMap(request));
}
```
```java
@Query("SELECT DISTINCT d.fcmToken FROM UserDeviceEntity d WHERE d.isActive = true")
List<String> findAllActiveTokens();
```
💡 `DISTINCT` — 1 user nhiều thiết bị, và cùng token có thể bị ghi trùng nếu dữ liệu bẩn.

---

## 6. `notifyMissionCompleted()` — thông báo hoàn thành nhiệm vụ

```java
@Override
@Transactional(propagation = Propagation.REQUIRES_NEW)      // 🔑 tx riêng
public void notifyMissionCompleted(Long userId, String missionName, int missionPoints,
                                   int totalPoints, String routerPath) {
    String fullName = userRepository.findById(userId).map(UserEntity::getFullName)
            .filter(s -> s != null && !s.isBlank()).orElse("bạn");      // 🔑 fallback

    String title = "Hoàn thành nhiệm vụ 🎉";
    String content = String.format("Chúc mừng %s! Bạn đã hoàn thành nhiệm vụ \"%s\" và nhận %d điểm thưởng. "
            + "Tổng điểm thưởng của bạn: %d.", fullName, missionName, missionPoints, totalPoints);

    // SB-4815: url = route màn hình thực hiện nhiệm vụ. Lưu THẲNG path (snapshot lúc hoàn thành) chứ
    // không lưu earnRuleId để resolve lại — app chỉ cần chỗ để nhảy tới, không cần biết là nhiệm vụ nào.
    notificationRepository.save(NotificationEntity.builder()
            .userId(userId).code("MISSION_COMPLETED").type("MISSION")
            .title(title).content(content).url(routerPath).count(1).isRead(false).build());

    List<String> tokens = userDeviceRepository.findByUserIdInAndIsActiveTrue(List.of(userId)).stream()
            .map(UserDeviceEntity::getFcmToken).collect(toList());
    if (tokens.isEmpty()) return;

    // data (IM LẶNG, app tự đọc) tách hoàn toàn khỏi notification title/body (OS hiển thị cho user)
    Map<String, String> data = new HashMap<>();
    data.put("code", "MISSION_COMPLETED"); data.put("type", "MISSION");
    if (routerPath != null) data.put("url", routerPath);
    fcmDispatchService.dispatchAsync(tokens, title, content, data);
}
```

🔑 **`REQUIRES_NEW`** — thông báo lỗi **không được rollback việc cộng điểm** (kết hợp với `try/catch` ở `awardPoints`, xem [12](12-module-rule-engine.md)).
🔑 **Lưu `routerPath` snapshot** thay vì `earnRuleId`: nhiệm vụ có thể bị sửa/xoá sau đó, nhưng thông báo cũ vẫn phải nhảy đúng màn hình.
🔑 **`notification` vs `data` trong FCM**:
- `notification` (title/body) → **OS hiển thị**, app không cần chạy
- `data` → app **tự đọc** để điều hướng (deeplink)

---

## 7. `CrmRoleNotificationController` — 🔑 vỏ tương thích (adapter)

```java
/**
 * SB-4805: vỏ tương thích endpoint /add-role-notification của v3m-core-service.
 *
 * hr-backend (GlobalMessage.SendMessageBySetting → CollaboratorAppApi.SendRoleNotification)
 * gọi POST {ApiAuth:OUT:CTVApp:Url}/add-role-notification. GIỮ NGUYÊN path + shape request/response
 * của v1 để chuyển hệ chỉ cần đổi 1 GIÁ TRỊ CONFIG bên hr-backend, KHÔNG phải sửa/deploy hr-backend.
 *
 * Khác v1 về ngữ nghĩa: v1 resolve roleId → danh sách user của role rồi ghi inbox + push từng user.
 * customer-service không có bảng role của hệ v1 nên ruột dùng lại luồng broadcast sẵn có
 * (INotificationService.send với phones rỗng): CHỈ push tới toàn bộ thiết bị app đang active,
 * KHÔNG ghi inbox (tránh fan-out N dòng t_notification mỗi lần CRM gửi).
 */
```

🔑 **Đây là pattern Adapter/Strangler Fig** — kỹ thuật thay thế hệ thống cũ:
- Giữ **nguyên** contract (path, request, response) của hệ cũ
- Thay **ruột** bằng implementation mới
- Chuyển hệ = đổi 1 giá trị config ở hệ gọi, **không deploy** hệ gọi

```java
// v1 cũng chặn title rỗng (TITLE_CAN_NOT_NULL) — giữ nguyên để không đẩy push trắng tiêu đề.
if (request.getTitle() == null || request.getTitle().trim().isEmpty()) {
    result = "bad_request";
    return ResponseEntity.badRequest().body(CrmRoleNotificationResponse.fail("Title can not null", "bad_request", 400));
}
```
🔑 Giữ **cả message lỗi tiếng Anh** của v1 → hr-backend parse response không bị vỡ.

```java
private SendNotificationRequest toBroadcastRequest(CrmRoleNotificationRequest request) {
    SendNotificationRequest broadcast = new SendNotificationRequest();
    broadcast.setPhones(null);            // 🔑 null → đi nhánh broadcast
    ...
}
```
`roleId` **chỉ để log**, không map sang role của app v2.

Metric: `notification.crm_role{result=success|bad_request|fail}`.

## 8. Đi tiếp

→ [`16-module-ctv.md`](16-module-ctv.md)
