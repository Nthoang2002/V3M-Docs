# customer-service — Module Auth

Package: `service/auth`, `controller/auth`
Class chính: `AuthServiceImpl` (323 dòng), `OtpServiceImpl` (251), `UserSyncItemService` (206)

---

## 1. Bảng endpoint (`AuthController`, base `/auth`, **toàn bộ trong `PUBLIC_URLS`**)

| Method | Path | Mô tả |
|---|---|---|
| POST | `/auth/login` | Đăng nhập bằng **phone** + password (RSA-encrypted) |
| POST | `/auth/send-otp` | Đăng ký bước 1 — validate + lưu pending + gửi OTP |
| POST | `/auth/register` | Đăng ký bước 2 — verify OTP + tạo tài khoản + trả JWT |
| POST | `/auth/resend/verify` | Gửi lại OTP đăng ký |
| POST | `/auth/logout` | Xoá refresh token (cần JWT) |
| POST | `/auth/refresh` | Đổi refresh token lấy access token mới |
| POST | `/auth/forgot-password` | Quên mật khẩu — gửi OTP |
| POST | `/auth/forgot-otp/verify` | Verify OTP → trả `tokenOtp` |
| POST | `/auth/forgot-otp/resend` | Gửi lại OTP |
| POST | `/auth/reset-password` | Đặt lại mật khẩu bằng `tokenOtp` |
| POST | `/auth/change-password` | Đổi mật khẩu (đã đăng nhập, cần mật khẩu hiện tại) |

⚠️ `/auth/logout` và `/auth/change-password` nằm trong `/auth/**` = **permitAll** ở tầng security, nhưng dùng `@RequestAttribute("userId")` → thiếu JWT thì `ServletRequestBindingException` → 401 (xem [04](04-exception-response.md)).

---

## 2. 🔑 Mật khẩu được mã hoá RSA từ client

```java
public AuthResponse login(LoginRequest request) {
    String plainPassword = rsaUtil.decrypt(request.getPassword());   // 🔑 client gửi RSA-encrypted
    UserEntity user = userRepository.findByPhone(request.getPhone())
            .orElseThrow(() -> new BadCredentialsException("Số điện thoại hoặc mật khẩu không đúng"));
    if (!passwordEncoder.matches(plainPassword, user.getPassword())) {
        throw new BadCredentialsException("Số điện thoại hoặc mật khẩu không đúng");
    }
    ...
}
```

**Hai lớp mã hoá, đừng nhầm:**
| Lớp | Thuật toán | Ở đâu | Mục đích |
|---|---|---|---|
| **Truyền** | RSA/ECB/PKCS1Padding | app mã hoá → server giải mã (`RsaUtil`) | Mật khẩu không đi dạng plaintext trong body |
| **Lưu trữ** | BCrypt | `passwordEncoder.encode()` | Hash 1 chiều, không giải được |

`RsaUtil.decrypt()` — nếu giải mã lỗi thì ném luôn `BadCredentialsException("Số điện thoại hoặc mật khẩu không đúng")` (không tiết lộ "payload sai định dạng").

🔑 **Message lỗi giống hệt nhau** cho "sai SĐT" và "sai mật khẩu" → **chống enumerate** tài khoản.

### Kiểm tra trạng thái sau khi so mật khẩu
```java
if (user.getStatus() == UserStatus.BLOCKED)  throw new DisabledException("Tài khoản đã bị khoá");   // 403
if (user.getStatus() == UserStatus.INACTIVE) throw new DisabledException("Tài khoản chưa được kích hoạt");
```
🔑 **Thứ tự có chủ ý**: check mật khẩu TRƯỚC, check trạng thái SAU. Nếu ngược lại thì kẻ tấn công biết được "SĐT này tồn tại nhưng bị khoá" mà không cần biết mật khẩu.

### Làm giàu `fullName` từ CDP (best-effort)
```java
if (customerId != null) {
    try {
        CdpProfileResponse cdpProfile = cdpProxy.getById(customerId);
        if (cdpProfile != null) {
            if (!customerId.equals(cdpProfile.getCustomerId())) {
                log.warn("CDP returned mismatched customerId ...");     // phòng lỗi CDP
            } else {
                fullName = cdpProfile.getFullName();
            }
        }
    } catch (Exception e) {
        log.warn("CDP profile fetch failed on login for userId={}: {}", ...);   // 🔑 KHÔNG chặn login
    }
}
```
🔑 CDP chết **không được chặn đăng nhập**. Đây là mẫu **fail-soft** lặp lại khắp service.

---

## 3. 🔑 Đăng ký 2 bước — dữ liệu chờ nằm ở Redis

```
[Bước 1] POST /auth/send-otp   { phone, password(RSA), fullName, referralCode }
    │
    ├─ userRepository.existsByPhone(phone)? → 400 "Số điện thoại đã được sử dụng"
    ├─ tryAcquireRegisterOtpLock(phone) (SETNX TTL 5s) → chống spam
    ├─ password = passwordEncoder.encode(rsaUtil.decrypt(password))   🔑 hash NGAY ở bước 1
    ├─ uuid = UUID.randomUUID()
    ├─ Redis SET auth:register:pending:{uuid} = JSON(request)   TTL 900s
    └─ otpService.sendRegisterOtp(phone, uuid) → Mobifi gửi SMS
    → trả { uuid, verifyKey(masked), transactionId, expiredTime, numberLimit }

[Bước 2] POST /auth/register   { uuid, otp, verifyKey }
    │  @Transactional
    ├─ otpService.verifyRegisterOtp(request)          → sai OTP thì ném
    ├─ pendingJson = Redis GET+DEL auth:register:pending:{uuid}  (Lua nguyên tử)
    │     null → 400 "Phiên đăng ký đã hết hạn"
    ├─ RE-CHECK existsByPhone(phone)                  🔑 chống race
    ├─ customerId = cdpCustomerService.resolveOrCreate(phone, fullName, null)
    │     null (CDP lỗi) → VẪN TẠO USER, CdpBackfillJob vá sau
    ├─ agentSupport = resolveAgentSupport(referralCode, phone)
    ├─ userRepository.save(user)  (source = APP)
    ├─ agreementService.accept(userId, null, ipAddress)   🔑 ghi consent luôn
    └─ trả AuthResponse (accessToken + refreshToken)
```

### Bốn chi tiết quan trọng

**(1) Hash mật khẩu ở bước 1, không phải bước 2**
```java
request.setPassword(passwordEncoder.encode(rsaUtil.decrypt(request.getPassword())));
redisTokenService.saveRegisterPending(uuid, objectMapper.writeValueAsString(request));
```
🔑 Redis chỉ chứa **BCrypt hash**, không bao giờ chứa mật khẩu thô. Redis bị đọc trộm cũng không lộ mật khẩu.

**(2) Re-check phone ở bước 2** — giữa 2 bước có 15 phút, đủ để 2 người đăng ký cùng số.

**(3) CDP lỗi KHÔNG chặn đăng ký**
```java
// Đăng ký chưa thu thập CCCD nên nationalId=null; nếu CDP lỗi/timeout thì customerId=null
// (giữ hành vi cũ — không chặn đăng ký), CdpBackfillJob sẽ thử liên kết lại sau.
```
→ Xem [19](19-jobs-quartz.md) về `CdpBackfillJob`.

**(4) Ghi consent điều khoản luôn khi đăng ký**
```java
// Form đăng ký đã có tickbox chấp nhận → coi như user đồng ý phiên bản hiện hành;
// tránh app hiện lại màn consent sau khi đăng ký xong.
// version=null → accept bản hiện hành; idempotent. Chạy cùng @Transactional với tạo user nên atomic.
agreementService.accept(saved.getId(), null, ipAddress);
```
`ipAddress` lấy từ `X-Forwarded-For` (controller) — vì service chạy sau Zuul gateway, `remoteAddr` chỉ là IP gateway.

---

## 4. 🔑 `resolveAgentSupport()` — mã giới thiệu → sale phụ trách (SB-4471)

```java
private Long resolveAgentSupport(String referralCode, String phoneForLog) {
    if (referralCode == null || referralCode.trim().isEmpty()) return null;
    String code = referralCode.trim();

    // (1) Tra DB nội bộ trước — rẻ, và CTV thuần app v2 chỉ tồn tại ở đây
    List<Long> referrerIds = userRepository.findIdsByEmployeeCodeOrPhone(code);
    if (referrerIds.size() == 1) {
        Long inherited = userRepository.findAgentSupportById(referrerIds.get(0)).orElse(null);
        if (inherited != null) return inherited;
    }

    // (2) Không ra thì hỏi CRM
    Long fromCrm = hrBackendClient.fetchAgentSupportByPhone(code);
    if (fromCrm == null) log.warn("Không xác định được sale phụ trách từ mã giới thiệu: phone={}", mask(phoneForLog));
    return fromCrm;
}
```

`t_user.agent_support` = **`AbpUsers.Id` bên CRM** — 🔑 **ngoại lệ DUY NHẤT** tham chiếu id CRM trong `t_user`.
Lý do (Javadoc entity): *"sale là nhân sự CRM, không có tài khoản app"*. Người giới thiệu thì vẫn thuần V2 (`t_apply.referral_id`).

🔑 **Mã sai → `null`, KHÔNG chặn đăng ký** — port đúng hành vi app v1: *"vẫn tạo tài khoản, chỉ là chưa có sale phụ trách; admin phân bổ sau được"*.
⚠️ Khác hoàn toàn với luồng **apply** — ở đó mã sai thì **chặn 400** (vì liên quan tiền hoa hồng). Xem [09](09-module-apply.md).

---

## 5. Refresh token — rotation

```java
public AuthResponse refreshToken(RefreshTokenRequest request) {
    Long userId = redisTokenService.getUserIdFromRefreshToken(refreshToken);
    if (userId == null) throw new BadCredentialsException("Refresh token không hợp lệ hoặc đã hết hạn");

    // 🔑 Rotate: xoá token cũ NGAY TRƯỚC khi cấp token mới
    redisTokenService.revokeRefreshToken(refreshToken);
    redisTokenService.deleteRefreshToken(userId);

    UserEntity user = userRepository.findById(userId)
            .orElseThrow(() -> new BadCredentialsException("Người dùng không tồn tại"));
    if (user.getStatus() != UserStatus.ACTIVE) throw new DisabledException("Tài khoản không còn hoạt động");

    return buildAuthResponse(user);        // cấp cặp token mới
}
```
🔑 **Refresh token rotation** — mỗi lần refresh sinh token mới, token cũ bị vô hiệu ngay. Nếu token bị đánh cắp, kẻ trộm dùng 1 lần thì user thật sẽ bị đá ra (và ngược lại) → phát hiện được.

`user.getStatus() != ACTIVE` — kiểm tra lại trạng thái ở mỗi lần refresh: admin khoá tài khoản thì phiên hiện tại bị chặn ngay ở lần refresh kế.

---

## 6. Đổi / đặt lại mật khẩu

### `resetPassword` (sau khi verify OTP quên mật khẩu)
```java
Long userId = redisTokenService.getAndDeleteTokenOtpUserId(request.getTokenOtp());   // Lua GET+DEL
if (userId == null) throw new IllegalArgumentException("Token OTP không hợp lệ hoặc đã hết hạn");
user.setPassword(passwordEncoder.encode(rsaUtil.decrypt(request.getNewPassword())));
userRepository.save(user);
redisTokenService.deleteRefreshToken(userId);        // 🔑 thu hồi phiên
```

### `changePassword` (đã đăng nhập)
```java
if (!passwordEncoder.matches(rsaUtil.decrypt(request.getCurrentPassword()), user.getPassword()))
    throw new BadCredentialsException("Mật khẩu hiện tại không đúng");
if (!newPasswordPlain.equals(confirmPasswordPlain))
    throw new IllegalArgumentException("Mật khẩu xác nhận không khớp với mật khẩu mới");
user.setPassword(passwordEncoder.encode(newPasswordPlain));
redisTokenService.deleteRefreshToken(userId);        // 🔑 bắt đăng nhập lại
```
🔑 Cả 2 luồng đều **thu hồi refresh token** sau khi đổi mật khẩu — nếu tài khoản đang bị chiếm, đổi mật khẩu sẽ đá kẻ chiếm ra.

---

## 7. `OtpServiceImpl` — tích hợp Mobifi OTP

### Config (`otp.*`)
`uri`, `authorization-value` (x-api-key), `template-code`, `expired-time`, `brand-name`, `number-limit`, `account-code`, `type-send` (`sms`|`email`), `enable`.

### 🔑 Cờ `otp.enable` — tắt OTP cho môi trường test
```java
if (!otpEnable) {
    log.warn("OTP disabled — skipping 3rd party call for user {}", user.getUsername());
    return ForgotPasswordResponse.builder().uuid(uuid).verifyKey(maskVerifyKey(verifyKey)).build();
}
```
Và `verifyForgotOtp` khi tắt thì **bỏ qua kiểm tra, cấp thẳng tokenOtp**.
⚠️ Bật cờ này trên production = **ai cũng đổi được mật khẩu của bất kỳ ai**. Phải chắc chắn `otp.enable=true` ở prod.

### Luồng quên mật khẩu
```
sendForgotOtp(user)
  ├─ tryAcquireOtpLock(userId)  (5s)  → đang xử lý thì 400
  ├─ verifyKey = phone (hoặc email nếu type-send=email)
  ├─ uuid = UUID
  ├─ Redis SET auth:otp:session:{uuid} = "{userId}:{verifyKey}"  TTL 900s
  └─ callGenOtp(uuid, verifyKey) → Mobifi

verifyForgotOtp(uuid, otp, verifyKey)
  ├─ callCheckOtp() → Mobifi
  │    status == null   → "OTP đã hết hạn hoặc không tồn tại"
  │    status == false  → numberLimit == null ? "vượt quá số lần" : "sai, còn N lần thử"
  └─ buildTokenOtp(uuid):
       session = Redis GET auth:otp:session:{uuid}   → null thì 400
       userId  = session.split(":")[0]
       tokenOtp = UUID; Redis SET auth:otp:tokenotp:{tokenOtp} = userId  TTL 1800s
       Redis DEL auth:otp:session:{uuid}
       → trả { tokenOtp }
```
🔑 **Hai tầng token**: `uuid` (phiên OTP, 15') → sau khi verify đổi lấy `tokenOtp` (vé đổi mật khẩu, 30'). Tách ra để `uuid` không dùng lại được sau khi đã verify.

### Mask verify key khi log
```java
private String maskVerifyKey(String key) {
    if (key.contains("@")) { int at = key.indexOf('@'); return key.substring(0, Math.min(2, at)) + "***" + key.substring(at); }
    return key.substring(0, 3) + "****" + key.substring(key.length() - 3);
}
```

---

## 8. `UserSyncService` — đồng bộ user từ CRM

`POST /admin/users/sync` — nhận `List<UserSyncRequest>` (tối đa **1000**), upsert theo `phone`.

### 🔑 Tách bean `UserSyncItemService` để dùng `REQUIRES_NEW`

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
public int[] syncOne(UserSyncRequest req) { ... return new int[]{created, updated, failed}; }
```
🔑 **Vì sao phải tách bean riêng?**
Spring `@Transactional` hoạt động qua **proxy AOP**. Gọi `this.syncOne()` trong cùng class sẽ **bỏ qua proxy** → annotation vô tác dụng. Phải gọi qua bean khác.

`REQUIRES_NEW` = mỗi user 1 transaction độc lập → **1 user lỗi không làm hỏng cả batch 1000 user**.

### Ba nguồn mật khẩu khi tạo user mới
```java
private String resolveNewUserPassword(UserSyncRequest req) {
    String encoded = decryptAndHash(req.getPasswordEncrypted(), req.getPhone());  // (1) RC2 từ hr-backend
    if (encoded != null) return encoded;
    if (req.getPasswordBcryptHash() != null && !req.getPasswordBcryptHash().isBlank())
        return req.getPasswordBcryptHash();                                       // (2) BCrypt sẵn từ v3m-core
    return null;                                                                  // (3) → fallback = hash(phone)
}
```
`Rc2DecryptUtil` giải mã RC2/CBC/PKCS5 do CRM (.NET) mã hoá, charset **UTF-16LE** (`Encoding.Unicode` của .NET). Xem [22](22-utils-crypto.md).

### ⚠️ Bài học: map gender sai suốt một thời gian dài

Javadoc trong `UserSyncItemService`:
> *"hr-backend gửi gender qua `BaseUserInfo.Gender` (field app v1 cũ, KHÔNG phải id master-data thật): `"F"` → 1, `"M"` → 2, khác → 0. `t_user.gender` lưu trực tiếp id master-data CRM: 7=Nam, 8=Nữ, 9=Khác. Trước đây `UserSyncItemService` **copy thẳng `req.getGender()` không qua map**, khiến gender mọi user sync từ CRM bị lưu **sai id hoàn toàn**."*

```java
static Integer mapHrGenderToMasterDataId(Integer hrGender) {
    if (hrGender == null) return null;
    if (hrGender == 1) return 8;   // hr F → master-data Nữ
    if (hrGender == 2) return 7;   // hr M → master-data Nam
    return null;                   // 🔑 giá trị không xác định → null, KHÔNG đoán
}
```
🔑 Trả `null` thay vì giá trị mặc định: *"không đoán, để tránh ghi đè dữ liệu gender đã đúng từ nguồn khác (VD: KYC OCR qua app)"*.
Và ở `applyProfileFields`: `if (mappedGender != null) user.setGender(mappedGender);` — chỉ set khi map ra được.

### Bảo vệ dữ liệu do app tự tạo
```java
// Chỉ xóa các bản ghi CRM_SYNC — bảo vệ bank account do user tự thêm qua app (APP)
bankAccountRepository.deleteByUserIdAndSource(userId, UserSource.CRM_SYNC);
```
```java
// Staging raw URLs: chỉ set nếu chưa có S3 URL (tránh overwrite khi user đã KYC qua app v2)
if (req.getCccdFrontRaw() != null && user.getCccdFrontUrl() == null) user.setCccdFrontRaw(...);
// isOcrVerified: chỉ upgrade lên true, không downgrade
if (Boolean.TRUE.equals(req.getIsOcrVerified()) && !Boolean.TRUE.equals(user.getIsVerified())) user.setIsVerified(true);
```
🔑 Cột `source` (`APP` | `CRM_SYNC`) là cơ chế phân định quyền sở hữu dữ liệu giữa 2 hệ thống — **pattern lặp lại**: `t_user.source`, `t_user_bank_account.source`, `t_worker_recruitment_status` (gap-fill).

## 9. Đi tiếp

→ [`06-module-kyc.md`](06-module-kyc.md)
