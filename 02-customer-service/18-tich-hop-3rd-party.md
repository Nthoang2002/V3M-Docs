# customer-service — Tích hợp bên thứ ba (Feign)

Package `config/proxy` — **7 Feign client** + 3 lớp config.
Facade: `utils/hr/HrBackendClient` (493 dòng), `utils/urbox/UrboxClient`.

---

## 1. Bảng 7 proxy

| Proxy | Đối tác | Auth | Config | Dùng cho |
|---|---|---|---|---|
| `HrDataProxy` | hr-backend | **Basic Auth** + header `partner` (chữ **thường**) | `DefaultFeignConfig` | Master data, việc làm, công ty, tin tức |
| `HrBackendProxy` | hr-backend | **`api-key`** (S2S) + header `Partner` (chữ **HOA**) | `DefaultFeignConfig` | Thưởng, hoa hồng, apply, vị trí chấm công |
| `HrAppAuthProxy` | hr-backend | **JWT user** + header `Partner` | `MultipartFeignConfig` | Đẩy thông tin OCR sang CRM |
| `CdpProxy` | CDP | (không) | `DefaultFeignConfig` | Resolve/tạo/cập nhật customer profile |
| `EkycProxy` | EKYC AI Mobifi | header `x-api-key` | `MultipartFeignConfig` | OCR CCCD + đối chiếu khuôn mặt |
| `UrboxProxy` | Urbox | body `app_id`/`app_secret` + header `Signature` (RSA) | `DefaultFeignConfig` | Catalog quà + đổi voucher |
| `MobifiOtpProxy` | Mobifi OTP | header `x-api-key` | `DefaultFeignConfig` | Gửi/kiểm tra OTP |

### ⚠️ hr-backend có **3 proxy** vì có **3 cơ chế auth khác nhau**
| Nhóm | Auth | Header partner |
|---|---|---|
| `HrDataProxy` | `Authorization: Basic base64(user:pass)` | `partner` (thường) |
| `HrBackendProxy` | `api-key: {applyApiKey}` | `Partner` (HOA) — và **một số endpoint KHÔNG gửi** |
| `HrAppAuthProxy` | `Authorization: Bearer {user JWT}` | `Partner` |

🔑 **Chữ hoa/thường của header `partner` khác nhau giữa 2 nhóm** — đây là chi tiết thật, ghi rõ trong Javadoc proxy. HTTP header về lý thuyết case-insensitive nhưng .NET binding có thể phân biệt.

Comment trong `HrBackendProxy`:
```java
/** GET /api/v1/CsData/AllDistrict — api-key, lọc theo TenantId. KHÔNG gửi Partner header. */
/** GET /api/v1/CsData/Banks — api-key. KHÔNG gửi Partner header. */
```

---

## 2. `@EnableServiceProxy` — meta-annotation

```java
@Retention(RUNTIME) @Target(TYPE)
@EnableFeignClients(basePackages = "com.ttt.v3m.app.customer.config.proxy")
@Import({DefaultFeignConfig.class})
public @interface EnableServiceProxy {}
```
Đặt trên `AppCustomerServiceApplication`. Gom 2 annotation thành 1.

## 3. `DefaultFeignConfig`

```java
public class DefaultFeignConfig implements RequestInterceptor {
    @Value("${feign.client.config.default.connect-timeout:3000}") private int connectTimeout;
    @Value("${feign.client.config.default.read-timeout:5000}")    private int readTimeout;

    @Override
    public void apply(RequestTemplate requestTemplate) {
        requestTemplate.header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE);
    }

    @Bean
    public Request.Options requestOptions() {
        return new Request.Options(connectTimeout, MILLISECONDS, readTimeout, MILLISECONDS, true);
    }
}
```
Mặc định: **connect 3s / read 5s**.
⚠️ **Không có** retry, không có circuit breaker → lỗi upstream truyền thẳng lên, xử lý ở tầng service (`try/catch` → 502).

## 4. 🔑 `MultipartFeignConfig` — 3 bean, mỗi bean 1 sự cố

```java
public class MultipartFeignConfig {
    @Value("${feign.client.config.ekyc-proxy.connect-timeout:5000}") private int connectTimeout;
    @Value("${feign.client.config.ekyc-proxy.read-timeout:30000}")   private int readTimeout;   // 🔑 30s

    @Bean
    public Encoder multipartEncoder(ObjectFactory<HttpMessageConverters> messageConverters) {
        return new SpringFormEncoder(new SpringEncoder(messageConverters));      // (1)
    }

    @Bean
    public Request.Options multipartRequestOptions() { ... }                      // (2)

    /**
     * AI EKYC service ĐÔI KHI trả Content-Type: application/octet-stream dù body thực chất là JSON
     * — SpringDecoder mặc định TỪ CHỐI decode vì không có HttpMessageConverter khớp content-type.
     * Decoder này parse thẳng bằng Jackson, BỎ QUA content-type trả về.
     */
    @Bean
    public Decoder multipartDecoder(ObjectMapper objectMapper) {                  // (3)
        return (Response response, Type type) -> {
            if (response.body() == null) return null;
            try (InputStream is = response.body().asInputStream()) {
                return objectMapper.readValue(is, objectMapper.getTypeFactory().constructType(type));
            }
        };
    }
}
```

| Bean | Vì sao |
|---|---|
| (1) `SpringFormEncoder` | Encoder mặc định của Feign không biết encode `MultipartFile`/`Resource` |
| (2) timeout **30s** | Xử lý ảnh (OCR/face) chậm hơn API JSON thông thường rất nhiều |
| (3) `Decoder` tự viết | 🔑 Đối tác trả **content-type sai** → decoder mặc định từ chối. Bỏ qua content-type, parse thẳng bằng Jackson |

💡 (3) là ví dụ điển hình: **API đối tác không chuẩn thì phải nới lỏng ở phía mình**, không thể bắt họ sửa.

---

## 5. `HrBackendClient` — facade

```java
/**
 * Facade gọi hr-backend qua Feign proxy (HrDataProxy Basic-Auth + HrBackendProxy api-key).
 * Giữ nguyên public API cho caller (HrCacheService/News/Reward/Apply) — chỉ đổi tầng HTTP từ
 * Unirest sang Feign. Post-processing (media URL, companyId, avatar) + xử lý status/exception
 * tolerant đặt tại đây; PROXY CHỈ LO HTTP + JSON.
 */
```
🔑 **Phân tầng rõ ràng:** `Proxy` = HTTP + JSON. `Client` = business logic của việc gọi (auth, xử lý status, post-processing, error mapping).
💡 Nhờ facade này mà việc **đổi tầng HTTP từ Unirest sang Feign** không phải sửa 1 dòng nào ở service layer.

### Basic Auth tính mỗi lần gọi
```java
private String basicAuth() {
    String raw = props.getUsername() + ":" + props.getPassword();
    return "Basic " + Base64.getEncoder().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
}
```

### `dataList()` — tolerant, nuốt lỗi
```java
/** Gọi 1 endpoint list-of-T, trả data hoặc empty list; nuốt lỗi (log) — giữ hành vi tolerant cũ. */
private <T> List<T> dataList(String label, Supplier<HrApiResponse<List<T>>> call) { ... }
```
Dùng cho master data (12 endpoint) — 1 loại lookup lỗi không được làm hỏng cả `syncMasterData()`.

### 🔑 `fetchRewardByProfile()` — map status có phân biệt
```java
/**
 * Xử lý lỗi/log dùng chung cho 5 lời gọi reward theo profileId — giữ ĐÚNG semantics bản *ByCustomerId:
 * HR 400/404 propagate CÙNG STATUS, còn lại trả null để caller quy về 502.
 */
private <T> T fetchRewardByProfile(String method, Long profileId, Supplier<HrApiResponse<T>> call) { ... }

/**
 * HR trả 400/404 = lỗi NGHIỆP VỤ (hồ sơ không tồn tại / tham số sai) → propagate ĐÚNG status kèm
 * message của HR. Các mã khác (401/5xx/timeout) để caller quy về 502 —
 * KHÔNG LẪN LỖI HẠ TẦNG VÀO 4xx.
 */
private void throwIfHrClientError(String method, Long profileId, FeignException e) { ... }

/** Lấy message từ body JSON HR; fallback theo HTTP status — không match nghiệp vụ theo chuỗi. */
```
🔑 **Nguyên tắc chuyển tiếp lỗi từ upstream:**
| Upstream trả | Mình trả | Vì sao |
|---|---|---|
| 400 / 404 | **cùng status** + message của họ | Lỗi nghiệp vụ — client sửa được |
| 401 / 5xx / timeout | **502** | Lỗi hạ tầng — client thử lại được |

💡 *"không match nghiệp vụ theo chuỗi"* — không viết `if (message.contains("not found"))`. Đối tác đổi wording là vỡ.

### 🔑 `fetchAgentSupportByPhone()` — null cho MỌI lý do
```java
/**
 * SB-4471: tra SĐT người giới thiệu ra sale phụ trách. Trả null khi không tra được VÌ BẤT KỲ LÝ DO GÌ
 * (không khớp ai, hr-backend lỗi) — caller phải coi null là "chưa có sale",
 * TUYỆT ĐỐI KHÔNG CHẶN ĐĂNG KÝ VÌ CRM LỖI.
 */
public Long fetchAgentSupportByPhone(String phone) { ... }
```
🔑 Hợp đồng của hàm **được ghi rõ trong Javadoc** để caller không hiểu nhầm null là "lỗi".

### `createProfile()` — 🔑 xử lý `data` đa hình
```java
/**
 * POST /api/v1/Profile/AppAdd — data trả về LOOSELY-TYPED (JsonNode):
 * lúc lỗi validation hr-backend trả data là STRING (tên field), lúc success là OBJECT {profileId}
 * — deserialize cứng sẽ VỠ.
 */
@PostMapping("/api/v1/Profile/AppAdd")
HrApiResponse<JsonNode> createProfile(...);
```
```java
/**
 * Map response Profile/AppAdd. TÁCH RIÊNG để unit-test được.
 * hr-backend trả lỗi validation dạng {status:false, message, data:"<TênField>"} — data là String
 * (tên field lỗi), KHÁC lúc success {status:true, data:{profileId}}.
 * Đọc data dạng JsonNode, chỉ lấy profileId khi status=true.
 */
```
💡 **`JsonNode` là "escape hatch"** khi contract của đối tác không nhất quán. Tách hàm map ra riêng để test được với chuỗi JSON thật (`HrBackendClientParseTest`).

### Post-processing: media URL
```java
private void prependMediaBase(List<HrMediaData> mediaList) { ... }
private String prependMediaBaseSingle(String path) { ... }
```
hr-backend trả đường dẫn tương đối (`/upload/news/abc.jpg`) → thêm `hr-backend.media-base-url` thành URL đầy đủ **ngay ở biên**, app không phải tự ghép.

---

## 6. `CdpProxy` — resolve-or-create 1 lượt gọi

```java
/**
 * Tra cứu + tạo mới TRONG 1 LƯỢT GỌI. Trả null khi CDP không tra ra và cũng không tạo được
 * (thiếu phone). Thay cho cặp ProfileByPhoneOrIdCard + Create trước đây.
 */
@PostMapping("/api/CustomerProfile/ResolveOrCreate")
UUID resolveOrCreateProfile(@RequestBody CdpResolveProfileRequest request);
```

`CdpCustomerServiceImpl`:
```java
// 1 lượt gọi: CDP tự tra cứu (CCCD → phone) rồi tạo mới nếu chưa có. KHÔNG tách lookup + create
// ở phía client nữa — 2 REQUEST ĐỒNG THỜI CÙNG SĐT TỪNG SINH RA CUSTOMER TRÙNG.
```
🔑 **Bài học race condition kinh điển:**
```
Request A: lookup(phone) → không thấy
Request B: lookup(phone) → không thấy
Request A: create(phone) → customer 1
Request B: create(phone) → customer 2   ❌ TRÙNG
```
Fix: đẩy cả 2 bước sang **1 API của bên sở hữu dữ liệu** — họ mới có khả năng làm nguyên tử (unique constraint / transaction).
💡 **Nguyên tắc:** check-then-act qua mạng luôn có race. Phải gộp thành 1 thao tác nguyên tử ở phía sở hữu dữ liệu.

```java
Timer.Sample sample = Timer.start(meterRegistry);
String result = "fail";
try { ... result = "success"; return customerId; }
catch (Exception e) { log.warn("CDP resolveOrCreate failed: phone={}, debug={}", mask(trimmedPhone), ...); return null; }
finally { sample.stop(Timer.builder("cdp.resolve").tag("result", result).register(meterRegistry)); }
```
🔑 Trả `null` chứ không ném — caller (`register`, `CdpBackfillJob`) tự quyết định.

---

## 7. `MobifiOtpProxy` — URI động

```java
@FeignClient(name = "mobifi-otp-proxy", url = "NOT_USED", configuration = DefaultFeignConfig.class)
public interface MobifiOtpProxy {
    @PostMapping("/verify/gen-otp")
    ResponseEntity<MobifiApiResponse<SendOtpResponse>> genOtp(URI uri, @RequestHeader("x-api-key") String xApiKey,
                                                              @RequestBody GenOtpRequest request);
}
```
🔑 `url = "NOT_USED"` + tham số **`URI uri` đầu tiên** — tính năng của Feign: truyền `java.net.URI` làm tham số đầu sẽ **override** base URL.
Ở `OtpServiceImpl`: `URI uri = UriComponentsBuilder.fromUriString(otpUri).build().toUri();`
💡 Dùng khi base URL đến từ config runtime, không cố định lúc compile.

---

## 8. `EkycProxy` — multipart

```java
@FeignClient(name = "ekyc-proxy", url = "${ekyc.base-url:https://ai-gw-gateway-server-uat.mobifi.vn}",
             configuration = MultipartFeignConfig.class)
public interface EkycProxy {
    @PostMapping(value = "/verify/customer-ai/ocr-vekyc", consumes = MULTIPART_FORM_DATA_VALUE)
    EkycApiResponse<EkycOcrData> ocrVekyc(@RequestHeader("x-api-key") String apiKey,
                                          @RequestPart("image") MultipartFile image,
                                          @RequestPart("sessionkey") String sessionkey);

    @PostMapping(value = "/verify/customer-ai/matching-face", consumes = MULTIPART_FORM_DATA_VALUE)
    EkycApiResponse<EkycMatchFaceResult> matchingFace(@RequestHeader("x-api-key") String apiKey,
                                                      @RequestPart("image") MultipartFile cccdFront,
                                                      @RequestPart("selfie") MultipartFile selfie);
}
```
Dùng bởi **cả 2 luồng**: KYC (`KycServiceImpl`) và chấm công (`FaceRecognitionServiceImpl`) — xem [10](10-module-timekeeping.md) về lý do dùng chung.

## 9. `HrAppAuthProxy` — đẩy OCR ngược sang CRM

```java
/**
 * Cập nhật thông tin OCR (ảnh CCCD + ảnh mặt) cho user đã có tài khoản trên hr-backend.
 * Requires: Authorization: Bearer {user JWT — SAME SECRET as customer-service}
 * Partner header: tenant name (e.g. "viec3mien")
 */
@PutMapping(value = "/api/AppAuth/UpdateOcrInfo", consumes = MULTIPART_FORM_DATA_VALUE)
Object updateOcrInfo(@RequestHeader("Authorization") String authorization, @RequestHeader("Partner") String partner,
                     @RequestPart("PhoneNumber") String phoneNumber, ...,
                     @RequestPart("NationalIdImages.NationalIdFrontSide") Resource nationalIdFrontSide, ...);
```
🔑 *"same secret as customer-service"* — hr-backend verify **chính JWT mà customer-service phát**. Hệ quả của việc dùng HS256 (đối xứng): secret phải chia sẻ giữa 2 hệ thống.
💡 Tên part `"NationalIdImages.NationalIdFrontSide"` có dấu chấm — cú pháp binding object lồng nhau của ASP.NET.

## 10. Đi tiếp

→ [`19-jobs-quartz.md`](19-jobs-quartz.md)
