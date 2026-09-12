# customer-service — Utils & Crypto

Package `utils/` — 4 nhóm: `auth/`, `common/`, `fcm/`, `hr/` + `urbox/`.
(FCM đã nói ở [15](15-module-notification-fcm.md), `HrBackendClient`/`UrboxClient` ở [18](18-tich-hop-3rd-party.md))

---

## 1. Bảng crypto trong dự án

| Thuật toán | Class | Dùng ở đâu | Chiều |
|---|---|---|---|
| **BCrypt** | `PasswordEncoder` (Spring) | Lưu mật khẩu `t_user.password` | 1 chiều (hash) |
| **RSA/ECB/PKCS1** | `RsaUtil` | App mã hoá mật khẩu khi gửi lên | 2 chiều (server giải) |
| **RC2/CBC/PKCS5** | `Rc2DecryptUtil` | Giải mật khẩu CRM (.NET) gửi sang | 2 chiều (server giải) |
| **HS256 (HMAC)** | `JwtUtil` (jjwt) | Ký JWT | đối xứng |
| **SHA256withRSA** | `UrboxSignatureUtil` | Ký request đổi quà Urbox | ký số |
| **MD5** | `HrCacheServiceImpl.md5()` | Hash để so cache đổi chưa | 🔑 **không phải mật mã** — chỉ dùng làm checksum |

---

## 2. `RsaUtil` — giải mật khẩu từ app

```java
@Component
public class RsaUtil {
    @Value("${app.crypto.private-key}") private String privateKeyBase64;

    public String decrypt(String encryptedBase64) {
        try {
            Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            cipher.init(Cipher.DECRYPT_MODE, loadPrivateKey());
            byte[] decrypted = cipher.doFinal(Base64.getDecoder().decode(encryptedBase64));
            return new String(decrypted, StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new BadCredentialsException("Số điện thoại hoặc mật khẩu không đúng");   // 🔑
        }
    }

    public String getPublicKeyBase64() {
        RSAPrivateCrtKey crtKey = (RSAPrivateCrtKey) loadPrivateKey();
        RSAPublicKeySpec pubSpec = new RSAPublicKeySpec(crtKey.getModulus(), crtKey.getPublicExponent());
        PublicKey publicKey = KeyFactory.getInstance("RSA").generatePublic(pubSpec);
        return Base64.getEncoder().encodeToString(publicKey.getEncoded());
    }

    private PrivateKey loadPrivateKey() throws Exception {
        byte[] keyBytes = Base64.getDecoder().decode(privateKeyBase64.replaceAll("\\s", ""));   // 🔑 bỏ whitespace
        return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(keyBytes));
    }
}
```

🔑 **Giải mã lỗi → ném `BadCredentialsException` với message giống hệt "sai mật khẩu"** — không tiết lộ "payload sai định dạng". Attacker không phân biệt được "gửi rác" với "sai mật khẩu".

🔑 `getPublicKeyBase64()` — **derive public key từ private key**. Chỉ cần cấu hình 1 khoá (private), public key tính ra được. `RSAPrivateCrtKey` (Chinese Remainder Theorem) chứa cả `modulus` + `publicExponent`.

🔑 `.replaceAll("\\s", "")` — PEM key trong file YAML thường xuống dòng/thụt lề; phải bỏ hết whitespace trước khi Base64-decode.

💡 **Vì sao mã hoá mật khẩu ở client?** Đã có HTTPS rồi mà? Lý do thực tế:
- Chống lộ ở tầng log/proxy nội bộ (một số gateway log request body)
- Chống developer/QA vô tình thấy mật khẩu thật khi debug
Không phải thay thế HTTPS.

⚠️ `RSA/ECB/PKCS1Padding` là padding **cũ**, có lỗ hổng lý thuyết (Bleichenbacher). `OAEP` an toàn hơn — nhưng đổi thì phải đồng bộ với app.

---

## 3. `Rc2DecryptUtil` — giải mật khẩu từ CRM (.NET)

```java
@Component
public class Rc2DecryptUtil {
    @Value("${app.sync.rc2-key:}") private String rc2KeyBase64;
    @Value("${app.sync.rc2-iv:}")  private String rc2IvBase64;

    @PostConstruct
    public void init() { Security.addProvider(new BouncyCastleProvider()); }    // 🔑 JDK không có RC2

    /**
     * Giải mã chuỗi RC2/CBC/PKCS5 do CRM hr-backend mã hoá.
     * .NET dùng Encoding.Unicode = UTF-16 LE.
     * Trả null nếu key chưa cấu hình hoặc decrypt thất bại.
     */
    public String decrypt(String encryptedBase64) {
        if (encryptedBase64 == null || encryptedBase64.isBlank()) return null;
        if (rc2KeyBase64.isBlank() || rc2IvBase64.isBlank()) return null;       // 🔑 chưa cấu hình → null
        try {
            SecretKeySpec keySpec = new SecretKeySpec(Base64.getDecoder().decode(rc2KeyBase64), "RC2");
            IvParameterSpec ivSpec = new IvParameterSpec(Base64.getDecoder().decode(rc2IvBase64));
            Cipher cipher = Cipher.getInstance("RC2/CBC/PKCS5Padding", "BC");   // 🔑 provider "BC"
            cipher.init(Cipher.DECRYPT_MODE, keySpec, ivSpec);
            byte[] decrypted = cipher.doFinal(Base64.getDecoder().decode(encryptedBase64));
            return new String(decrypted, Charset.forName("UTF-16LE"));          // 🔑 charset .NET
        } catch (Exception e) {
            return null;                                                        // 🔑 nuốt hoàn toàn
        }
    }
}
```

🔑 **Ba chi tiết "liên thông .NET ↔ Java" đáng nhớ:**
1. **RC2 không có trong JDK** → phải thêm `BouncyCastleProvider` và chỉ định provider `"BC"`
2. **`Encoding.Unicode` của .NET = UTF-16 Little Endian**, không phải UTF-8. Sai charset → ra chuỗi rác có ký tự `\0` xen kẽ
3. **Trả `null` thay vì ném** — decrypt lỗi thì bỏ qua cập nhật mật khẩu (`UserSyncItemService` log warn + dùng nguồn khác), không làm hỏng cả batch sync

⚠️ **RC2 là thuật toán lỗi thời** (khoá 40–128 bit, đã bị coi là yếu). Ở đây dùng vì phải **tương thích với hệ CRM cũ** — không phải lựa chọn thiết kế mới.

---

## 4. `UrboxSignatureUtil` — ký RSA-SHA256

```java
/**
 * Sinh chữ ký RSA-SHA256 cho API đổi quà Urbox (cartPayVoucher) theo tài liệu Urbox cung cấp:
 * ksort data theo key → json_encode → ký bằng private key (SHA256withRSA) → base64.
 * CHỈ áp dụng cho các field Urbox yêu cầu ký (app_id, app_secret, campaign_code, dataBuy,
 * isSendSms, site_user_id, transaction_id) — KHÔNG ký toàn bộ request body
 * (VD: ttphone không nằm trong tập field ký theo tài liệu).
 */
public String sign(Map<String, Object> dataToSign) { ... }
```

🔑 **`ksort`** (sắp key theo alphabet) là bắt buộc: JSON không đảm bảo thứ tự key, mà chữ ký tính trên **chuỗi byte**. 2 bên phải sinh **chuỗi giống hệt nhau**.
🔑 **Chỉ ký tập field quy định** — thừa/thiếu 1 field là chữ ký sai. Tài liệu đối tác là nguồn duy nhất quyết định tập này.

💡 `ksort` là hàm PHP — tài liệu Urbox viết bằng PHP, phải port đúng semantics sang Java.

---

## 5. `GeoUtils` — ray-casting

Đã phân tích chi tiết ở [10](10-module-timekeeping.md). Điểm cốt lõi nhắc lại:
- **Port nguyên semantics** từ `TimeKeepV2PolygonGeometry.IsPointInsidePolygon` (C#) để 2 hệ cho cùng kết quả
- `COORDINATE_TOLERANCE = 1e-9` khớp `CoordinateTolerance` bên hr-backend
- Trùng đỉnh → tính là **nằm trong**
- Đa giác < 3 đỉnh → `false`
- Có test `GeoUtilsCrossCheckTest` đối chiếu với vector chuẩn từ C#

🔑 `final class` + `private GeoUtils() {}` — utility class chuẩn (không cho khởi tạo, không cho kế thừa).

---

## 6. `InMemoryMultipartFile`

```java
/** Wrap byte[] thành MultipartFile để pass vào Feign client (SpringFormEncoder). */
public class InMemoryMultipartFile implements MultipartFile {
    private final String name, originalFilename, contentType;
    private final byte[] bytes;
    ...
    @Override public InputStream getInputStream() { return new ByteArrayInputStream(bytes); }
    @Override public void transferTo(File dest) throws IOException { Files.write(dest.toPath(), bytes); }
}
```
🔑 Spring **không có** implementation nào của `MultipartFile` cho `byte[]` (chỉ có `StandardMultipartFile` gắn với request). Cần khi:
- Gửi ảnh tải từ S3 sang EKYC (`KycServiceImpl`, `FaceRecognitionServiceImpl`)
- Gửi PDF vừa render lên S3 (`CtvServiceImpl`)
- Gửi ảnh tải từ URL lên S3 (`KycImageMigrateJob`)

---

## 7. `DebuggingDTO`

Đã nói ở [04](04-exception-response.md). Nhắc lại điểm cốt lõi:
```java
.filter(el -> el.getClassName().contains("ttt"))     // 🔑 chỉ giữ frame của công ty
```
Stack trace 80 dòng → 3–5 dòng.

⚠️ **Không dùng ở chỗ exception có thể chứa PII** (xem `KycServiceImpl.applyOcrDataToProfile`).

---

## 8. Hàm `mask()` — lặp lại ở 5 nơi

```java
private static String mask(String phone) {
    if (phone == null || phone.length() < 5) return "***";
    return phone.substring(0, 3) + "***" + phone.substring(phone.length() - 2);
}
```
Có ở: `AuthServiceImpl`, `CdpCustomerServiceImpl`, `WorkerProfileServiceImpl`, `ApplyServiceImpl` (mask cả mã giới thiệu vì có thể là SĐT), `UserSyncItemService` (`"****" + 4 số cuối`), `OtpServiceImpl` (`maskVerifyKey`, xử lý cả email).

⚠️ **Lặp code** — nên gom vào `utils/common/MaskUtil`. Là điểm có thể refactor. Nhưng lưu ý các bản không hoàn toàn giống nhau (số ký tự giữ lại khác nhau).

🔑 **Quy tắc `/log-standard` của dự án:**
| Loại dữ liệu | Được log? |
|---|---|
| `userId`, `profileId`, `recruitmentId`, `eventId` | ✅ id kỹ thuật |
| SĐT | ⚠️ chỉ dạng mask |
| Tên, CCCD, ngày sinh, địa chỉ | ❌ không bao giờ |
| Giá trị query param thô | ❌ (có thể chứa PII) |
| FCM token | ⚠️ 12 ký tự đầu |
| Exception message | ⚠️ cẩn thận — Jackson có thể nhúng giá trị dữ liệu |

## 9. Đi tiếp

→ [`23-database-migration.md`](23-database-migration.md)
